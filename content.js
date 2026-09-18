// Tab Volume Booster - content script
// Routes each <video>/<audio> element through a Web Audio graph:
//   source -> lowCutFilter (highpass) -> bassFilter (lowshelf) -> voiceBoostFilter (peaking) -> [ soft clipper | masterGain | leveler->makeup->limiter ] -> destination
// The last stage is one of three swappable tails (see activeTail): the soft clipper
// (default), a plain gain node (raw/transparent), or the "Stable Volume" chain (A/B, off by default).
//
// Two hard-won rules (verified in real Firefox):
// 1. NEVER route a media element into a *suspended* AudioContext — under Firefox's autoplay
//    policy it starts suspended and resume() only works after a page-level gesture, so a routed
//    element would go SILENT. We leave audio native until the context is running, then take over.
// 2. A cross-origin element without CORS produces SILENCE in createMediaElementSource; we detect
//    those and leave them native rather than muting them.

(() => {
  if (window.__tabVolumeBoosterInjected) return;
  window.__tabVolumeBoosterInjected = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ==========================================================================
  //  SETTINGS  —  the only place with tunable numbers.
  //  The code below only references these values (no magic numbers elsewhere).
  //  Edit a value, then reload the add-on in about:debugging to hear the change.
  // ==========================================================================
  const SETTINGS = {
    // ---- Volume slider range, in percent. 100 = the tab's normal volume. -----
    //  The single source of truth for the ceiling: the popup asks for maxPercent
    //  and sizes its slider to match, so you only change the number here.
    volume: {
      minPercent: 100, // the floor: this add-on only boosts, never cuts below normal.
      maxPercent: 1200, // how far the slider goes (1200 = 12x loudness). See §"How high?" in README.
      defaultPercent: 100, // where a fresh tab starts (no boost)
    },

    // ---- The EQ bands the presets drive. --------------------------------------
    //  A biquad filter reshapes the sound; these define WHERE each band sits and how
    //  wide it is, while how hard each preset pushes them is set in `presets`.

    // 1. Hygiene high-pass: removes sub-bass rumble but keeps the voice's body intact —
    //    the right way to de-rumble (a low-shelf cut would scoop the body and leave a thin
    //    "telephone" voice). Engages only when processing (see routeLowCut); an exact
    //    passthrough at the 100%+Flat baseline.
    lowCutBand: {
      type: "highpass", // passes everything ABOVE frequencyHz, rolls off below it
      frequencyHz: 80, // standard broadcast low-cut: kills rumble, keeps fundamentals.
      //                  Small laptop/earbud speakers can't reproduce sub-80 anyway.
      q: 0.707, // Butterworth (maximally flat) — no resonant bump at the corner.
    },
    // 2. Bass boost (Bass preset only): a low shelf that adds warmth/boom.
    bassBand: {
      type: "lowshelf", // lifts EVERYTHING below `frequencyHz`
      frequencyHz: 120, // in the usable-bass range small speakers can actually reproduce.
    },
    // 3. Voice-boost bell (the Voice preset): a straight copy of Volume Master's voice boost —
    //    ONE broad peaking bell that lifts (not cuts) the vocal midrange.
    //    Reverse-engineered from Volume Master v1.14.x (offscreen.js): peaking @ 1500 Hz,
    //    Q 1, +12 dB. (Their store copy says "2.5 kHz + a compressor"; the shipped code is
    //    a single 1500 Hz bell with no compressor.) This replaced our old clarity-cut Voice
    //    recipe, which is kept as a comment under the `voice` preset below.
    voiceBoostBand: {
      type: "peaking", // a bell centred on `frequencyHz`
      frequencyHz: 1500, // Volume Master's actual voice-boost centre (broad vocal midrange)
      q: 1.0, // Volume Master's Q — broad, so it reads as "fuller/louder voice", not a honk
    },

    // ---- Presets: each sets the bands' gain in DECIBELS. 0 dB = flat. --------
    //  Rule of thumb: +6 dB ≈ twice as loud for that band, -6 dB ≈ half. The low-cut
    //  has no gain knob (see routeLowCut), so it isn't listed here.
    presets: {
      default: { bassGainDb: 0, voiceBoostGainDb: 0 }, // flat
      bass: { bassGainDb: 14, voiceBoostGainDb: 0 }, // boomy
      voice: { bassGainDb: 0, voiceBoostGainDb: 12 },
      //        Volume Master's voice boost, copied 1:1: a single +12 dB bell at 1500 Hz and nothing
      //        else — a BOOST (louder/fuller), riding through the soft clipper so it won't harsh-clip.
    },

    // ---- The soft clipper: the anti-clipping stage at the end of the chain. --
    //  When the boost pushes peaks past the digital ceiling (±1.0), instead of chopping
    //  them square (harsh clipping) we ROUND them off into warm saturation, acting only on
    //  the top peaks so it doesn't squash dynamics like a compressor. Because a WaveShaper
    //  clamps its input to ±1, the boost is baked INTO the curve, rebuilt on every slider move.
    softClip: {
      enabled: true,
      kneeStartDb: -0.3,
      ceilingDb: 0,
      curveSamples: 8192,
      oversample: "2x",
    },

    // ---- "Stable Volume": a YouTube-style loudness path (A/B PROTOTYPE, off by default) --
    //  Rather than get loudness from raw gain, this COMPRESSES to raise perceived
    //  loudness, then a limiter only guards the rare true peak — mastering order:
    //  leveler (compress) -> makeup (the slider) -> limiter. Compression shrinks the
    //  peak-to-average gap, so makeup gain buys more loudness per dB; flip it live
    //  (setLeveler(true)) to A/B against the soft clipper.
    stableVolume: {
      enabled: false, // OFF by default — this is the A/B alternative to the soft clipper.
      // The LEVELER: a gentle compressor doing the loudness work (NOT a limiter).
      // Low ratio + slow-ish attack keeps it from the "muted/pumped" sound of a crushing limiter.
      leveler: {
        thresholdDb: -24, // start leveling well below the peaks
        kneeDb: 24, // soft, gradual onset
        ratio: 4, // leveling, not limiting (a limiter is >10:1)
        attackSec: 0.03, // ~30 ms: slow enough to let transients/punch through
        releaseSec: 0.3, // smooth recovery, no pumping
      },
      // The LIMITER: a separate fast brickwall, the final gatekeeper for stray peaks —
      // does almost nothing most of the time.
      limiter: {
        thresholdDb: -2, // catch peaks a hair under 0 dBFS
        kneeDb: 2,
        ratio: 20, // effectively a brickwall
        attackSec: 0.002, // ~2 ms: fast enough to stop overs
        releaseSec: 0.08,
      },
    },
  };
  // ==========================================================================

  let audioContext = null;
  let masterGain = null;
  let lowCutFilter = null; // high-pass: rumble out, body kept — engaged by boost/preset (see routeLowCut)
  let bassFilter = null; // low shelf, lifted by the Bass preset
  let voiceBoostFilter = null; // Voice-only +12 dB bell at 1.5 kHz (Volume Master's voice boost)
  let shaper = null; // WaveShaper doing the soft clipping (with the boost baked into its curve)
  let clipEnabled = SETTINGS.softClip.enabled; // live bypass flag; toggle with setSoftClipEnabled()
  // "Stable Volume" tail (A/B alternative to the shaper): leveler -> makeup -> limiter.
  let leveler = null; // DynamicsCompressor doing the loudness work (raises perceived loudness)
  let makeupGain = null; // the slider's boost, applied AFTER compression (like mastering makeup gain)
  let limiter = null; // DynamicsCompressor as a fast brickwall — final true-peak safety
  let levelerEnabled = SETTINGS.stableVolume.enabled; // live toggle via setLevelerEnabled()
  let observer = null;
  let gesturesHooked = false;

  const wired = new WeakSet(); // elements routed through the graph
  const skipped = new WeakSet(); // elements we deliberately left native (cross-origin)

  let currentVolume = SETTINGS.volume.defaultPercent / 100; // gain multiplier: 1.0 == 100%
  let currentPreset = "default";
  let engaged = false; // the user has asked us to take over

  // --- "Tricky" pages: audio we physically can't touch --------------------
  // Streaming services whose hardware-backed DRM never reaches a WebAudio graph we
  // can tap, so createMediaElementSource fails or yields silence; the popup turns a
  // match into an "out of my hands" warning.
  // We do NOT flag DRM/EME in general — plenty of it (e.g. software Widevine) decodes
  // to a routable <video>, so flagging all EME would cry wolf; only these hosts get it.
  const TRICKY_HOSTS =
    /(^|\.)(netflix\.com|disneyplus\.com|hulu\.com|max\.com|hbomax\.com|hbo\.com|primevideo\.com|amazon\.[a-z.]+|spotify\.com|peacocktv\.com|paramountplus\.com|crunchyroll\.com|tv\.apple\.com)$/i;

  function isTrickyHost() {
    try {
      return TRICKY_HOSTS.test(location.hostname);
    } catch (err) {
      return false;
    }
  }

  // --- Graph -------------------------------------------------------------

  function buildGraph() {
    if (audioContext) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    lowCutFilter = audioContext.createBiquadFilter();
    lowCutFilter.type = SETTINGS.lowCutBand.type;
    lowCutFilter.frequency.value = SETTINGS.lowCutBand.frequencyHz;
    lowCutFilter.Q.value = SETTINGS.lowCutBand.q; // initial params; routeLowCut flips it in/out of the path

    bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = SETTINGS.bassBand.type;
    bassFilter.frequency.value = SETTINGS.bassBand.frequencyHz;
    bassFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    voiceBoostFilter = audioContext.createBiquadFilter();
    voiceBoostFilter.type = SETTINGS.voiceBoostBand.type;
    voiceBoostFilter.frequency.value = SETTINGS.voiceBoostBand.frequencyHz;
    voiceBoostFilter.Q.value = SETTINGS.voiceBoostBand.q;
    voiceBoostFilter.gain.value = 0; // 0 dB peaking == exact passthrough unless Voice+ is picked

    // THREE possible tails, all wired to the speakers; the LAST EQ node (voiceBoostFilter)
    // feeds exactly one (see routeClip / activeTail), so switching is instant.
    //  SOFT-CLIP : voiceBoostFilter -> shaper -> destination      (default when boosting; boost baked into the curve)
    //  RAW/BASE  : voiceBoostFilter -> masterGain -> destination  (transparent at 100%, raw clippable boost above)
    //  STABLE-VOL: voiceBoostFilter -> leveler -> makeupGain -> limiter -> destination  (off by default; see SETTINGS.stableVolume)
    masterGain = audioContext.createGain();
    masterGain.gain.value = currentVolume;

    shaper = audioContext.createWaveShaper();
    shaper.oversample = SETTINGS.softClip.oversample;
    updateShaperCurve(); // bakes the current volume + the soft-clip shape into the curve

    // Stable-Volume tail: leveler (compress) -> makeupGain (slider) -> limiter (brickwall).
    const lv = SETTINGS.stableVolume.leveler;
    leveler = audioContext.createDynamicsCompressor();
    leveler.threshold.value = lv.thresholdDb;
    leveler.knee.value = lv.kneeDb;
    leveler.ratio.value = lv.ratio;
    leveler.attack.value = lv.attackSec;
    leveler.release.value = lv.releaseSec;

    makeupGain = audioContext.createGain();
    makeupGain.gain.value = currentVolume; // the boost, applied AFTER compression

    const lm = SETTINGS.stableVolume.limiter;
    limiter = audioContext.createDynamicsCompressor();
    limiter.threshold.value = lm.thresholdDb;
    limiter.knee.value = lm.kneeDb;
    limiter.ratio.value = lm.ratio;
    limiter.attack.value = lm.attackSec;
    limiter.release.value = lm.releaseSec;

    // EQ chain (frequency order): lowCut -> bass -> voiceBoost -> tail.
    // Biquads in series are commutative in magnitude, so the order is just for readability.
    lowCutFilter.connect(bassFilter);
    bassFilter.connect(voiceBoostFilter); // voiceBoostFilter is the last EQ node (feeds the tail)
    masterGain.connect(audioContext.destination); // RAW/BASE tail — always wired, fed only when active
    shaper.connect(audioContext.destination); //     SOFT-CLIP tail — always wired, fed only when active
    leveler.connect(makeupGain); //                   STABLE-VOL tail: build it, wire it to the speakers,
    makeupGain.connect(limiter); //                   and feed it only when activeTail() selects it
    limiter.connect(audioContext.destination);
    routeClip(); // point voiceBoostFilter at whichever tail is active
    routeLowCut(); // high-pass on only when boosting/preset; exact passthrough at baseline

    applyPresetNodes();

    // When the context becomes runnable (after a page gesture), take over.
    audioContext.addEventListener("statechange", () => {
      if (audioContext.state === "running") wireAll();
    });
  }

  const dbToLinear = (db) => Math.pow(10, db / 20);

  // The soft-clip transfer function. The already-boosted sample `u` passes straight
  // through below the knee and eases smoothly toward `ceiling` above it, never crossing it.
  //   |u| <= knee : pass through;  |u| > knee : knee + (ceiling-knee) * tanh((|u|-knee)/(ceiling-knee))
  function softClipSample(u, knee, ceiling) {
    const mag = Math.abs(u);
    if (mag <= knee) return u;
    const sign = u < 0 ? -1 : 1;
    return sign * (knee + (ceiling - knee) * Math.tanh((mag - knee) / (ceiling - knee)));
  }

  // Rebuild the WaveShaper's lookup curve for the CURRENT volume, baking the boost in
  // (curve[x] = softClip(volume * x)) since the shaper clamps its own input to ±1.
  // Called on startup and on every volume change.
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

  // The ONE definition of "the user has asked us to alter the sound": a boost past 100%
  // OR a non-Flat preset. The soft clipper and high-pass key off this together; when it's
  // false (100% + Flat) the chain collapses to an exact, bit-for-bit passthrough.
  function processingEngaged() {
    return currentVolume > 1 || currentPreset !== "default";
  }

  // Which tail should the last EQ node feed right now? One place decides:
  //  - Baseline (100% + Flat): masterGain at 1.0 — a bit-transparent passthrough, routing around
  //    the shaper (which would colour peaks) and the leveler (which would compress).
  //  - Engaged: leveler chain if Stable-Volume is on, else the shaper if soft-clip is on
  //    (the default when boosting), else masterGain (the raw, freely-clippable boost, A/B).
  function activeTail() {
    if (!processingEngaged()) return masterGain;
    if (levelerEnabled) return leveler;
    if (clipEnabled) return shaper;
    return masterGain;
  }

  // Point the last EQ node (voiceBoostFilter) at whichever tail activeTail() picks. Every tail
  // stays wired to the speakers, so this just re-points one connection — safe to flip live.
  function routeClip() {
    if (!voiceBoostFilter || !masterGain || !shaper || !leveler) return;
    try {
      voiceBoostFilter.disconnect();
    } catch (err) {
      /* nothing connected yet */
    }
    voiceBoostFilter.connect(activeTail());
  }

  // Engage/bypass the always-there high-pass WITHOUT re-wiring — the node stays in the
  // chain and we just change its params (safe to flip live). When engaged it's a real 80 Hz
  // high-pass; at the 100%+Flat baseline it becomes a 0 dB "peaking" filter, a mathematically
  // exact identity (H(z) = 1 everywhere) so the signal passes bit-for-bit.
  function routeLowCut() {
    if (!lowCutFilter) return;
    if (processingEngaged()) {
      lowCutFilter.type = SETTINGS.lowCutBand.type; // "highpass"
      lowCutFilter.frequency.value = SETTINGS.lowCutBand.frequencyHz;
      lowCutFilter.Q.value = SETTINGS.lowCutBand.q;
    } else {
      lowCutFilter.type = "peaking"; // 0 dB peaking == exact passthrough
      lowCutFilter.gain.value = 0;
    }
  }

  // Programmatic on/off for the soft clipper — handy for A/B testing. Call
  // setSoftClipEnabled(false) to hear the raw (clippable) boost, true to protect it.
  function setSoftClipEnabled(on) {
    clipEnabled = !!on;
    routeClip();
    return clipEnabled;
  }

  // Programmatic on/off for the "Stable Volume" tail — the A/B against the soft clipper.
  // When on, it takes precedence over the soft clipper (see activeTail).
  function setLevelerEnabled(on) {
    levelerEnabled = !!on;
    routeClip();
    return levelerEnabled;
  }

  // Can this element's audio survive createMediaElementSource without being silenced?
  // blob:/data:/MSE and same-origin are safe; a cross-origin element only if it opted into CORS.
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
    // The baseline (100% + Flat) must be truly native — routing an element through the
    // graph is itself audible, so don't route until the user asks for something. Not marked
    // skipped, so it stays a candidate wireAll picks up the moment we engage.
    if (!processingEngaged()) return;
    if (!isRoutable(element)) {
      // Cross-origin without CORS: we can't route it, and since we only ever
      // boost (never cut), there's nothing to do to it — leave it fully native.
      skipped.add(element);
      return;
    }
    try {
      const source = audioContext.createMediaElementSource(element);
      source.connect(lowCutFilter);
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
    if (!processingEngaged()) return; // baseline: leave every element native (see wireElement)
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
    voiceBoostFilter.gain.value = preset.voiceBoostGainDb;
  }

  // Bring the graph up, hook gestures, and take over if we already can — never routing into
  // a suspended context. At the 100%+Flat baseline we build nothing until a graph already
  // exists (building an AudioContext and routing media is itself audible), so a tab the user
  // never boosted stays 100% native; we only build + route once they ask for a boost or preset.
  function engage() {
    if (!processingEngaged() && !audioContext) return;
    buildGraph();
    hookGestures();
    audioContext.resume().catch(() => {}); // fire-and-forget; may be a no-op until a gesture
    engaged = true;
    if (audioContext.state === "running") wireAll();
  }

  // Tell the background page our current volume + preset — it stamps the toolbar badge
  // and remembers this tab's setting across a refresh. Fire-and-forget; rejects harmlessly.
  function reportState() {
    try {
      api.runtime
        .sendMessage({
          type: "vol-state",
          volume: Math.round(currentVolume * 100),
          preset: currentPreset,
        })
        ?.catch(() => {});
    } catch (err) {
      /* messaging unavailable (e.g. during teardown) — ignore */
    }
  }

  function setVolume(percent) {
    // Clamp to the configured slider range (guards against stray messages).
    const clamped = Math.min(
      SETTINGS.volume.maxPercent,
      Math.max(SETTINGS.volume.minPercent, percent)
    );
    currentVolume = clamped / 100;
    reportState(); // update the toolbar badge + this tab's remembered setting
    engage();
    if (masterGain) masterGain.gain.value = currentVolume; // RAW/BASE path gain
    if (makeupGain) makeupGain.gain.value = currentVolume; // Stable-Volume path: makeup = the boost
    updateShaperCurve(); // SOFT-CLIP path: rebuild the curve with the new boost baked in
    routeClip(); // engage the shaper only while boosting; bypass it (transparent) at 100%
    routeLowCut(); // engage the high-pass only while boosting; exact passthrough at 100%+Flat
  }

  function applyPreset(name) {
    currentPreset = name === "bass" || name === "voice" ? name : "default";
    engage();
    applyPresetNodes();
    // A preset counts as "processing engaged", so re-point both bypasses: the high-pass
    // and soft clipper drop in for Voice/Bass, and out again on Flat at 100%.
    routeLowCut();
    routeClip();
    reportState(); // remember the preset for this tab (and refresh the badge)
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
      levelerEnabled, // "Stable Volume" (compressor) tail on/off — A/B prototype
      // The popup shows a hint when boost is engaged but the context isn't running yet
      // (user needs to click the page), or when some media can't be boosted (cross-origin).
      pending: engaged && contextState !== "running" && counts.routable > 0,
      blockedMedia: counts.blocked,
      // "tricky" = a known streaming host whose DRM audio we can't route (see TRICKY_HOSTS);
      // the popup turns this into an orange "out of my hands" warning.
      tricky: isTrickyHost(),
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
      case "set-leveler": // { type: "set-leveler", enabled: true|false } — Stable-Volume A/B
        setLevelerEnabled(message.enabled);
        return Promise.resolve(getState());
      default:
        return undefined;
    }
  });

  // Console test hook, from the content script's devtools context:
  //   __tabVolumeBooster.setSoftClip(false)  // hear the raw, clippable boost
  //   __tabVolumeBooster.setSoftClip(true)   // smooth, protected again
  //   __tabVolumeBooster.setLeveler(true|false)  // A/B the "Stable Volume" path
  // Boost the slider first (the tails only run while engaged), then flip live to A/B.
  window.__tabVolumeBooster = {
    setSoftClip: setSoftClipEnabled,
    isSoftClipEnabled: () => clipEnabled,
    setLeveler: setLevelerEnabled,
    isLevelerEnabled: () => levelerEnabled,
  };

  // Restore this tab's last volume/preset (survives a refresh, which keeps the tab id).
  // We run uniformly in EVERY frame — building a graph is cheap and silent (nothing routes
  // until the context runs AND the frame has media, see wireAll), so an empty ad frame just
  // holds an idle graph and every frame with media boosts together.
  function applySaved(saved) {
    if (saved.preset) applyPreset(saved.preset); // also engages the graph
    setVolume(saved.volume); // applies the boost + refreshes badge
  }

  function restoreState() {
    let pending;
    try {
      pending = api.runtime.sendMessage({ type: "vol-restore" });
    } catch (err) {
      reportState();
      return;
    }
    Promise.resolve(pending)
      .then((saved) => {
        if (saved && typeof saved.volume === "number") {
          applySaved(saved); // re-apply the tab's boost in this frame
        } else {
          reportState(); // nothing saved: keep this frame's badge entry in sync
        }
      })
      .catch(() => reportState());
  }

  restoreState();
})();
