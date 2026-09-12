// Tab Volume Booster - content script
// Routes each <video>/<audio> element through a Web Audio graph:
//   source -> bassFilter (lowshelf) -> voiceFilter (peaking) -> trebleFilter (highshelf) -> [ soft clipper | masterGain ] -> destination
//   (the last stage is a soft clipper that bakes in the volume boost; toggle it off to fall back to a plain gain node)
//
// Two hard-won rules (both verified by testing in real Firefox):
//
// 1. NEVER route a media element into a *suspended* AudioContext. Under Firefox's
//    default autoplay policy the context starts "suspended" and resume() only
//    succeeds after a genuine *page-level* user gesture. The extension's gesture
//    happens in the popup, not the page, so we can't rely on it. If we routed a
//    live element into a suspended context the page would go SILENT. Instead we
//    leave audio native until the context is actually running (we resume it from
//    page gestures), and only then take over. This never breaks a page.
//
// 2. A cross-origin media element without CORS produces SILENCE when passed to
//    createMediaElementSource. We detect those and leave them native (falling
//    back to element.volume for <=100%), rather than muting them.

(() => {
  if (window.__tabVolumeBoosterInjected) return;
  window.__tabVolumeBoosterInjected = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ==========================================================================
  //  SETTINGS  —  the only place with tunable numbers.
  //  Every knob for the slider, Bass boost, and Voice boost lives here; the code
  //  below only *references* these values (no magic numbers elsewhere). Edit a
  //  value, then reload the add-on in about:debugging to hear the change.
  // ==========================================================================
  const SETTINGS = {
    // ---- Volume slider range, in percent. 100 = the tab's normal volume. -----
    //  This is the SINGLE source of truth for the ceiling: the popup asks the
    //  content script for maxPercent and sizes its slider to match, so you only
    //  change the number here.
    volume: {
      minPercent: 0,
      maxPercent: 2400, // how far the slider goes (600 = 6x loudness). See §"How high?" in README.
      defaultPercent: 100, // where a fresh tab starts (no boost, no cut)
    },

    // ---- The two EQ bands the presets drive. --------------------------------
    //  A "biquad" filter reshapes the sound. These define WHERE each band sits
    //  and how wide it is; how hard each preset pushes them is set in `presets`.
    bassBand: {
      type: "lowshelf", // lifts/cuts EVERYTHING below `frequencyHz`
      frequencyHz: 300, // shelf corner. Sits in the upper-bass/low-mids: high enough that
      //                   the Bass preset's boost lands where laptop/earbud speakers can
      //                   actually reproduce it, and that the Voice preset's cut trims
      //                   lower-mid "boxiness" as well as rumble. Lower = deeper/sub-only.
    },
    voiceBand: {
      type: "peaking", // a bell centred on `frequencyHz`
      frequencyHz: 2700, // speech "presence": the ~2–3 kHz band where consonant
      //                    intelligibility lives and the ear is most sensitive. The Voice
      //                    preset boosts it hard so the midrange dominates, radio-style.
      q: 1.1, // bell width — a touch focused so the lift reads as "presence", not just louder.
      //         Higher = narrower/more surgical, lower = broader.
    },
    trebleBand: {
      type: "highshelf", // lifts/cuts EVERYTHING above `frequencyHz`
      frequencyHz: 4000, // top of the vocal band. The Voice preset CUTS here to roll off the
      //                    "air"/hiss/sibilance above the voice — this high-cut, paired with
      //                    the low-cut below, is what band-limits the sound to an old-radio
      //                    window and makes speech pop out of it. Corner kept above ~4 kHz so
      //                    consonants (which give clarity) survive.
    },

    // ---- Presets: each sets the three bands' gain in DECIBELS. 0 dB = flat. --
    //  Rule of thumb: +6 dB ≈ twice as loud for that band, -6 dB ≈ half.
    //  Too subtle? Raise the numbers. Distorting/crackly? Lower them.
    //  Voice is a deliberate band-pass: cut lows AND highs, boost the midrange —
    //  that's the "old-time radio", everything-but-the-voice-stripped-away sound.
    presets: {
      default: { bassGainDb: 0, voiceGainDb: 0, trebleGainDb: 0 }, // flat — no colouring
      bass: { bassGainDb: 14, voiceGainDb: 0, trebleGainDb: 0 }, // boomy, weighty low end
      voice: { bassGainDb: -12, voiceGainDb: 11, trebleGainDb: -5 }, // band-limited radio
      //         voice: strip lows, strip highs, shove the midrange forward.
    },

    // ---- The soft clipper: the anti-clipping stage at the end of the chain. --
    //  Once you push the slider hard, the loudest peaks shoot past the digital
    //  ceiling (±1.0). Chop them off square and you get harsh, buzzy "clipping".
    //  Instead we ROUND them off: the signal passes through untouched until it
    //  nears the ceiling, then eases smoothly up to it and can never cross it —
    //  turning nasty digital clipping into warm, gradual saturation (the way an
    //  analog amp overdrives). Unlike a compressor/limiter it acts instantly and
    //  ONLY on the peaks near the top, so it doesn't squash dynamics or "pump" —
    //  which is what made the previous limiter sound muted when driven hard.
    //
    //  Because a WaveShaper clamps its own input to ±1, the volume boost can't sit
    //  in front of it — so we bake the boost INTO the shaping curve and rebuild the
    //  curve whenever the slider moves. (See updateShaperCurve.)
    softClip: {
      enabled: true, // on by default. Flip off to A/B against raw (clippable) gain —
      //                live-toggle with setSoftClipEnabled() / the "set-softclip" message.
      kneeStartDb: -3, // below this level the sound is untouched; above it, saturation eases in.
      //                 Higher (e.g. -1) = cleaner/more transparent; lower (e.g. -9) = warmer, more driven.
      ceilingDb: -0.5, // the hard ceiling output can never exceed — a hair under 0 dBFS for safety.
      curveSamples: 16384, // resolution of the shaping lookup table (bigger = finer, costs a little memory).
      oversample: "4x", // "none" | "2x" | "4x": tames the aliasing that any clipping adds. 4x = smoothest.
    },
  };
  // ==========================================================================

  let audioContext = null;
  let masterGain = null;
  let bassFilter = null;
  let voiceFilter = null;
  let trebleFilter = null;
  let shaper = null; // WaveShaper doing the soft clipping (with the boost baked into its curve)
  let clipEnabled = SETTINGS.softClip.enabled; // live bypass flag; toggle with setSoftClipEnabled()
  let observer = null;
  let gesturesHooked = false;

  const wired = new WeakSet(); // elements routed through the graph
  const skipped = new WeakSet(); // elements we deliberately left native (cross-origin)

  let currentVolume = SETTINGS.volume.defaultPercent / 100; // gain multiplier: 1.0 == 100%
  let currentPreset = "default";
  let engaged = false; // the user has asked us to take over

  // --- Graph -------------------------------------------------------------

  function buildGraph() {
    if (audioContext) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = SETTINGS.bassBand.type;
    bassFilter.frequency.value = SETTINGS.bassBand.frequencyHz;
    bassFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    voiceFilter = audioContext.createBiquadFilter();
    voiceFilter.type = SETTINGS.voiceBand.type;
    voiceFilter.frequency.value = SETTINGS.voiceBand.frequencyHz;
    voiceFilter.Q.value = SETTINGS.voiceBand.q;
    voiceFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    trebleFilter = audioContext.createBiquadFilter();
    trebleFilter.type = SETTINGS.trebleBand.type;
    trebleFilter.frequency.value = SETTINGS.trebleBand.frequencyHz;
    trebleFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    // Two possible tails, both wired to the speakers; the treble filter feeds
    // exactly one of them (see routeClip), so toggling soft-clip is instant.
    //
    //  ON  : trebleFilter -> shaper -> destination
    //        The shaper's curve applies the boost AND rounds off the peaks. (The
    //        boost lives in the curve because a WaveShaper clamps its input to ±1,
    //        so a gain node in front of it would just hard-clip.)
    //  OFF : trebleFilter -> masterGain -> destination
    //        A plain gain node — the raw, boosted, freely-clippable signal (A/B).
    masterGain = audioContext.createGain();
    masterGain.gain.value = currentVolume;

    shaper = audioContext.createWaveShaper();
    shaper.oversample = SETTINGS.softClip.oversample;
    updateShaperCurve(); // bakes the current volume + the soft-clip shape into the curve

    bassFilter.connect(voiceFilter);
    voiceFilter.connect(trebleFilter);
    masterGain.connect(audioContext.destination); // OFF tail — always wired, fed only when bypassed
    shaper.connect(audioContext.destination); //     ON  tail — always wired, fed only when engaged
    routeClip(); // point trebleFilter at whichever tail is active

    applyPresetNodes();

    // When the context becomes runnable (after a page gesture), take over.
    audioContext.addEventListener("statechange", () => {
      if (audioContext.state === "running") wireAll();
    });
  }

  const dbToLinear = (db) => Math.pow(10, db / 20);

  // The soft-clip transfer function. Feed it the already-boosted sample value
  // `u` (may be far outside ±1); it returns a value that stays untouched below
  // the knee and eases smoothly toward `ceiling`, never crossing it.
  //   |u| <= knee : pass straight through (transparent — no colouring)
  //   |u|  > knee : knee + (ceiling-knee) * tanh((|u|-knee)/(ceiling-knee))
  // tanh's slope is 1 at the knee (so the curve is smooth there) and flattens to
  // the ceiling as |u| grows — a gentle, bounded overdrive instead of a hard edge.
  function softClipSample(u, knee, ceiling) {
    const mag = Math.abs(u);
    if (mag <= knee) return u;
    const sign = u < 0 ? -1 : 1;
    return sign * (knee + (ceiling - knee) * Math.tanh((mag - knee) / (ceiling - knee)));
  }

  // Rebuild the WaveShaper's lookup curve for the CURRENT volume. The boost is
  // baked in here (curve[x] = softClip(volume * x)) because the shaper clamps its
  // own input to ±1 — so the gain must be applied as we build the table, not by a
  // node in front of it. Called on startup and on every volume change.
  function updateShaperCurve() {
    if (!shaper) return;
    const n = SETTINGS.softClip.curveSamples;
    const knee = dbToLinear(SETTINGS.softClip.kneeStartDb);
    const ceiling = dbToLinear(SETTINGS.softClip.ceilingDb);
    const drive = currentVolume; // the slider's multiplier, applied inside the curve
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1; // map table index -> input sample in [-1, 1]
      curve[i] = softClipSample(drive * x, knee, ceiling);
    }
    shaper.curve = curve;
  }

  // Point the treble filter at whichever tail is active: the shaper (soft-clip on)
  // or the plain masterGain (off). Both tails stay wired to the speakers, so this
  // is just re-pointing one connection — no rebuild, safe to flip live.
  function routeClip() {
    if (!trebleFilter || !masterGain || !shaper) return;
    try {
      trebleFilter.disconnect();
    } catch (err) {
      /* nothing connected yet */
    }
    trebleFilter.connect(clipEnabled ? shaper : masterGain);
  }

  // Programmatic on/off for the soft clipper — handy for A/B testing. Call
  // setSoftClipEnabled(false) to hear the raw (clippable) boost, true to protect it.
  function setSoftClipEnabled(on) {
    clipEnabled = !!on;
    routeClip();
    return clipEnabled;
  }

  // Can this element's audio survive createMediaElementSource without being
  // silenced? blob:/data:/MSE and same-origin are safe. A cross-origin element
  // is only safe if the page opted into CORS on it.
  function isRoutable(element) {
    const src = element.currentSrc || element.src || "";
    if (!src) return true;
    if (src.startsWith("blob:") || src.startsWith("data:") || src.startsWith("mediasource:")) {
      return true;
    }
    try {
      if (new URL(src, location.href).origin === location.origin) return true;
    } catch (err) {
      return true;
    }
    return element.crossOrigin === "anonymous" || element.crossOrigin === "use-credentials";
  }

  function wireElement(element) {
    if (wired.has(element) || skipped.has(element)) return;
    if (!isRoutable(element)) {
      skipped.add(element);
      element.volume = Math.min(1, currentVolume); // best-effort attenuation
      return;
    }
    try {
      const source = audioContext.createMediaElementSource(element);
      source.connect(bassFilter);
      element.volume = 1; // volume is now controlled by the gain node
      wired.add(element);
    } catch (err) {
      // Already routed, or an element we can't touch; leave it alone.
      skipped.add(element);
    }
  }

  // Only ever called while the context is running.
  function wireAll() {
    if (!audioContext || audioContext.state !== "running") return;
    document.querySelectorAll("video, audio").forEach(wireElement);
    masterGain.gain.value = currentVolume;
    startObserving();
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches("video, audio")) wireElement(node);
          node.querySelectorAll?.("video, audio").forEach(wireElement);
        });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Resume the context from real page gestures (the only thing Firefox accepts).
  function hookGestures() {
    if (gesturesHooked) return;
    gesturesHooked = true;
    const resume = () => {
      if (audioContext && audioContext.state !== "running") {
        audioContext.resume().catch(() => {});
      }
    };
    ["pointerdown", "keydown", "touchstart"].forEach((type) =>
      window.addEventListener(type, resume, { capture: true, passive: true })
    );
    // Playback starting is itself a gesture-driven event on most sites.
    document.addEventListener("play", resume, { capture: true, passive: true });
  }

  function applyPresetNodes() {
    if (!bassFilter) return;
    const preset = SETTINGS.presets[currentPreset] || SETTINGS.presets.default;
    bassFilter.gain.value = preset.bassGainDb;
    voiceFilter.gain.value = preset.voiceGainDb;
    trebleFilter.gain.value = preset.trebleGainDb;
  }

  // Bring the graph up, hook gestures, and take over if we already can. Never
  // routes anything into a suspended context.
  function engage() {
    buildGraph();
    hookGestures();
    audioContext.resume().catch(() => {}); // fire-and-forget; may be a no-op until a gesture
    engaged = true;
    if (audioContext.state === "running") wireAll();
  }

  function setVolume(percent) {
    // Clamp to the configured slider range (guards against stray messages).
    const clamped = Math.min(
      SETTINGS.volume.maxPercent,
      Math.max(SETTINGS.volume.minPercent, percent)
    );
    currentVolume = clamped / 100;
    engage();
    if (masterGain) masterGain.gain.value = currentVolume; // OFF path gain
    updateShaperCurve(); // ON path: rebuild the soft-clip curve with the new boost baked in
    // Immediate <=100% control for elements we won't (or can't yet) route.
    document.querySelectorAll("video, audio").forEach((element) => {
      if (!wired.has(element) && !isRoutable(element)) {
        element.volume = Math.min(1, currentVolume);
      }
    });
  }

  function applyPreset(name) {
    currentPreset = name === "bass" || name === "voice" ? name : "default";
    engage();
    applyPresetNodes();
  }

  // --- State for the popup ----------------------------------------------

  function countMedia() {
    const media = [...document.querySelectorAll("video, audio")];
    let routable = 0;
    let blocked = 0;
    for (const element of media) {
      if (isRoutable(element)) routable += 1;
      else blocked += 1;
    }
    return { total: media.length, routable, blocked };
  }

  function getState() {
    const counts = countMedia();
    const contextState = audioContext ? audioContext.state : "none";
    return {
      ok: true,
      volume: Math.round(currentVolume * 100),
      preset: currentPreset,
      // Volume range comes from SETTINGS so the popup slider is sized from one place.
      minPercent: SETTINGS.volume.minPercent,
      maxPercent: SETTINGS.volume.maxPercent,
      defaultPercent: SETTINGS.volume.defaultPercent,
      hasMedia: counts.total > 0,
      engaged,
      contextState,
      softClipEnabled: clipEnabled,
      // The popup shows a hint when boost is engaged but the page context isn't
      // running yet (user needs to click the page), or when some media can't be
      // boosted because it's cross-origin.
      pending: engaged && contextState !== "running" && counts.routable > 0,
      blockedMedia: counts.blocked,
    };
  }

  api.runtime.onMessage.addListener((message) => {
    switch (message?.type) {
      case "get-state":
        return Promise.resolve(getState());
      case "set-volume":
        setVolume(message.value);
        return Promise.resolve(getState());
      case "set-preset":
        applyPreset(message.name);
        return Promise.resolve(getState());
      case "reset":
        applyPreset("default");
        setVolume(100);
        return Promise.resolve(getState());
      case "set-softclip": // { type: "set-softclip", enabled: true|false }
        setSoftClipEnabled(message.enabled);
        return Promise.resolve(getState());
      default:
        return undefined;
    }
  });

  // Console test hook. From the *content script's* devtools context you can run:
  //   __tabVolumeBooster.setSoftClip(false)  // hear the raw, clippable boost
  //   __tabVolumeBooster.setSoftClip(true)   // smooth, protected again
  // (Easiest: DevTools console context dropdown -> this page's content script,
  //  or drive it from the popup via a "set-softclip" message.)
  window.__tabVolumeBooster = {
    setSoftClip: setSoftClipEnabled,
    isSoftClipEnabled: () => clipEnabled,
  };
})();
