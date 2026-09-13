// Tab Volume Booster - content script
// Routes each <video>/<audio> element through a Web Audio graph:
//   source -> lowCutFilter (highpass) -> bassFilter (lowshelf) -> mudFilter (peaking) -> presenceFilter (peaking) -> tameFilter (highshelf) -> [ soft clipper | masterGain | leveler->makeup->limiter ] -> destination
//   The last stage is one of three swappable tails (see activeTail): the soft clipper
//   (default, bakes in the boost + rounds peaks), a plain gain node (raw/transparent),
//   or the YouTube-style "Stable Volume" leveler->makeup->limiter chain (A/B, off by
//   default — setLeveler(true) to try it). See SETTINGS.stableVolume.
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
      minPercent: 100, // the floor: this add-on only boosts, never cuts below normal.
      maxPercent: 1200, // how far the slider goes (1200 = 12x loudness). See §"How high?" in README.
      defaultPercent: 100, // where a fresh tab starts (no boost)
    },

    // ---- The EQ bands the presets drive. --------------------------------------
    //  A "biquad" filter reshapes the sound. These define WHERE each band sits
    //  and how wide it is; how hard each preset pushes them is set in `presets`.
    //
    //  The Voice preset follows the standard broadcast "clarity" recipe, applied in
    //  chain order: high-pass out the rumble (KEEPING the voice's body), cut the
    //  "mud", GENTLY lift "presence", then softly tame the harsh/sibilant top. The
    //  golden rule is CUT, don't boost: cutting mud is what makes a voice read as
    //  clear, and it does so without amplifying noise or harshness — so the presence
    //  lift stays small on purpose. (Boosting presence hard, then hacking away the
    //  harshness it creates, is the trap the old preset fell into.)

    // 1. Hygiene high-pass: removes sub-bass rumble and handling noise but leaves the
    //    voice's body intact. This is the RIGHT way to de-rumble — unlike a low-SHELF
    //    cut, which scoops out the 100-300 Hz body and leaves a thin, "telephone"-
    //    sounding voice. It engages ONLY when the user has asked for something — a
    //    boost (>100%) or a non-Flat preset; at the do-nothing baseline (100% + Flat)
    //    it's flattened to an exact passthrough so the untouched signal is untouched.
    //    (See routeLowCut for how the same node is bypassed without re-wiring.)
    lowCutBand: {
      type: "highpass", // passes everything ABOVE frequencyHz, rolls off below it
      frequencyHz: 80, // standard broadcast low-cut: kills rumble, keeps fundamentals
      //                  (an adult male voice starts ~85 Hz). Small laptop/earbud
      //                  speakers can't reproduce sub-80 anyway, so Bass loses nothing.
      q: 0.707, // Butterworth (maximally flat) — no resonant bump at the corner.
    },
    // 2. Bass boost (Bass preset only): a low shelf that adds warmth/boom.
    bassBand: {
      type: "lowshelf", // lifts EVERYTHING below `frequencyHz`
      frequencyHz: 120, // in the usable-bass range small speakers can actually reproduce.
    },
    // 3. Mud cut (Voice preset): the un-muffler. Cutting the boxy low-mids is what
    //    makes a voice read as "clear" — and unlike a big presence boost it adds no
    //    noise or harshness.
    mudBand: {
      type: "peaking", // a bell centred on `frequencyHz`
      frequencyHz: 350, // the "boxy/muddy" low-mids (250-500 Hz).
      q: 1.0, // broad, so it opens the voice up rather than notching one spot.
    },
    // 4. Presence lift (Voice preset): forwardness / intelligibility. Kept GENTLE —
    //    2-5 kHz is also where harshness lives, so more than a few dB starts to
    //    pierce (the old preset boosted +6 here and created the harshness we then
    //    spent a whole session fighting).
    presenceBand: {
      type: "peaking",
      frequencyHz: 3000, // consonant intelligibility / "radio" forwardness.
      q: 1.0, // broad, so it reads as presence, not a nasal honk.
    },
    // 5. Tame the top (Voice preset): a gentle high-shelf roll-off that smooths the
    //    harsh/sibilant 5-8 kHz region. Gentle on purpose — a hard cut here (the old
    //    -9 dB) just makes the voice dull. With the mud cut and only a small presence
    //    lift, very little taming is needed.
    tameBand: {
      type: "highshelf", // rolls off EVERYTHING above `frequencyHz`
      frequencyHz: 7500, // above the consonants (s/t/f/sh live at 4-6 kHz), on the
      //                    sibilant shoulder — so it smooths "sss" without dulling clarity.
    },

    // ---- Presets: each sets the bands' gain in DECIBELS. 0 dB = flat. --------
    //  Rule of thumb: +6 dB ≈ twice as loud for that band, -6 dB ≈ half. The
    //  low-cut (lowCutBand) is a high-pass with no gain knob (engaged by boost/preset,
    //  see routeLowCut), so it isn't listed here. Flat at 100% leaves everything
    //  untouched; Bass only lifts the low shelf; Voice runs the cut-led clarity recipe.
    presets: {
      default: { bassGainDb: 0, mudGainDb: 0, presenceGainDb: 0, tameGainDb: 0 }, // flat
      bass: { bassGainDb: 14, mudGainDb: 0, presenceGainDb: 0, tameGainDb: 0 }, // boomy
      voice: { bassGainDb: -2, mudGainDb: -4, presenceGainDb: 3, tameGainDb: -3 },
      //        clarity recipe: no low-cut band here (the 80 Hz high-pass, engaged with
      //        this preset, already removes the rumble AND keeps the body), -5 dB mud
      //        to un-muffle, a +4 dB presence lift (kept small so it never pierces),
      //        and a soft -3 dB top
      //        shelf to smooth sibilance. Cut-led, so it's clear without harshness.
      //        (The mud cut is nudged a touch deeper and presence a touch higher for a
      //        little more forward "radio" character — cutting mud adds that clarity
      //        cleanly, so we lean on it more than on the boost.)
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
      kneeStartDb: -0.5, // the boost passes through as CLEAN, LINEAR gain below this; only in the
      //                 last ~0.6 dB up to the ceiling do peaks ease into the limit. Kept high
      //                 on purpose: a low knee (the old -3) saturates most of the signal and
      //                 sounds distorted, because the boost is baked into the curve so "-3 dBFS
      //                 of the OUTPUT" is a much lower INPUT level once driven. -1 leaves the
      //                 body of the signal untouched and rounds only the true peaks. (Even
      //                 higher, e.g. -0.5, is closer to a transparent brickwall limiter — the
      //                 cleanest on the body, but harder on sharp transients. Lower = warmer,
      //                 more driven/distorted.)
      ceilingDb: -0.4, // the hard ceiling output can never exceed — a hair under 0 dBFS for safety.
      curveSamples: 16384, // resolution of the shaping lookup table (bigger = finer, costs a little memory).
      oversample: "4x", // "none" | "2x" | "4x": tames the aliasing that any clipping adds. 4x = smoothest.
    },

    // ---- "Stable Volume": a YouTube-style loudness path (A/B PROTOTYPE, off by default) --
    //  YouTube's "Stable Volume" never gets loudness from raw gain — it COMPRESSES to
    //  raise perceived loudness, then a limiter only guards the rare true peak. That's
    //  the opposite of our soft-clip path (which asks a clipper to be the loudness
    //  engine, so it saturates and distorts when driven). This tail follows the
    //  mastering order instead:  leveler (compress) -> makeup (the slider) -> limiter.
    //  Because compression shrinks the peak-to-average gap, the makeup gain buys far
    //  more perceived loudness per dB — loud AND clean. Off by default so nothing
    //  changes until you flip it (setLeveler(true) / the "set-leveler" message); flip
    //  it live on a real video to A/B against the soft clipper.
    stableVolume: {
      enabled: false, // OFF by default — this is the A/B alternative to the soft clipper.
      // The LEVELER: a gentle compressor doing the loudness work (NOT a limiter). Low
      // ratio + slow-ish attack is what keeps it from the "muted/pumped" sound the old
      // one-stage limiter had — it levels, it doesn't crush.
      leveler: {
        thresholdDb: -24, // start leveling well below the peaks
        kneeDb: 24, // soft, gradual onset
        ratio: 4, // leveling, not limiting (a limiter is >10:1)
        attackSec: 0.03, // ~30 ms: slow enough to let transients/punch through
        releaseSec: 0.3, // smooth recovery, no pumping
      },
      // The LIMITER: a separate fast brickwall, the final gatekeeper for stray peaks —
      // does almost nothing most of the time (this is the split the old design lacked).
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
  let mudFilter = null; // Voice-only cut at 350 Hz (un-muffle)
  let presenceFilter = null; // Voice-only lift at 3 kHz (clarity/forwardness)
  let tameFilter = null; // Voice-only high-shelf roll-off at 7.5 kHz (smooth the top)
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
  // A small list of streaming services whose audio we genuinely can't boost:
  // they use hardware-backed DRM on a protected media path that never reaches a
  // WebAudio graph we're allowed to tap, so createMediaElementSource fails or
  // yields silence. The popup turns a match into an honest "out of my hands"
  // warning.
  //
  // NOTE: we deliberately do NOT flag DRM/EME in general. Plenty of DRM (e.g.
  // software Widevine, as on bitmovin's demo) decodes to a normal <video> we CAN
  // route, so boosting works — flagging all EME would cry wolf on those. Only the
  // known-unreachable hosts below get the warning. (The other case we can't
  // touch — a player inside a cross-origin <iframe>, like an embedded YouTube —
  // is spotted in the popup instead: the tab is audible but exposes no media the
  // top document can see.)
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

    mudFilter = audioContext.createBiquadFilter();
    mudFilter.type = SETTINGS.mudBand.type;
    mudFilter.frequency.value = SETTINGS.mudBand.frequencyHz;
    mudFilter.Q.value = SETTINGS.mudBand.q;
    mudFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    presenceFilter = audioContext.createBiquadFilter();
    presenceFilter.type = SETTINGS.presenceBand.type;
    presenceFilter.frequency.value = SETTINGS.presenceBand.frequencyHz;
    presenceFilter.Q.value = SETTINGS.presenceBand.q;
    presenceFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    tameFilter = audioContext.createBiquadFilter();
    tameFilter.type = SETTINGS.tameBand.type;
    tameFilter.frequency.value = SETTINGS.tameBand.frequencyHz;
    tameFilter.gain.value = 0; // preset-driven; set by applyPresetNodes()

    // THREE possible tails, all wired to the speakers; the LAST EQ node (tameFilter)
    // feeds exactly one of them (see routeClip / activeTail), so switching is instant.
    //
    //  SOFT-CLIP : tameFilter -> shaper -> destination         (default when boosting)
    //        The shaper's curve applies the boost AND rounds off the peaks. (The
    //        boost lives in the curve because a WaveShaper clamps its input to ±1,
    //        so a gain node in front of it would just hard-clip.)
    //  RAW/BASE  : tameFilter -> masterGain -> destination
    //        A plain gain node. At 100% its gain is exactly 1.0, so this is the
    //        transparent passthrough used whenever there's no boost. Above 100% with
    //        soft-clip toggled off it carries the raw, freely-clippable boost (A/B).
    //  STABLE-VOL: tameFilter -> leveler -> makeupGain -> limiter -> destination
    //        The YouTube-style path (off by default): compress for loudness, apply the
    //        slider as makeup gain, then brickwall the stray peaks. (See SETTINGS.stableVolume.)
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

    // EQ chain (frequency order): lowCut -> bass -> mud -> presence -> tame -> tail.
    // Biquads in series are commutative in magnitude, so the ordering is just for
    // readability; tameFilter is the last stage and feeds the tail via routeClip.
    lowCutFilter.connect(bassFilter);
    bassFilter.connect(mudFilter);
    mudFilter.connect(presenceFilter);
    presenceFilter.connect(tameFilter);
    masterGain.connect(audioContext.destination); // RAW/BASE tail — always wired, fed only when active
    shaper.connect(audioContext.destination); //     SOFT-CLIP tail — always wired, fed only when active
    leveler.connect(makeupGain); //                   STABLE-VOL tail: build it, wire it to the speakers,
    makeupGain.connect(limiter); //                   and feed it only when activeTail() selects it
    limiter.connect(audioContext.destination);
    routeClip(); // point tameFilter at whichever tail is active
    routeLowCut(); // high-pass on only when boosting/preset; exact passthrough at baseline

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

  // The ONE definition of "the user has asked us to alter the sound": a boost past
  // 100% OR a non-Flat preset. Both the soft clipper and the high-pass key off this,
  // so they engage and bypass together. When it's false — the do-nothing baseline of
  // 100% + Flat — the whole chain collapses to an exact passthrough and the audio is
  // left bit-for-bit untouched. That baseline transparency is the whole point.
  function processingEngaged() {
    return currentVolume > 1 || currentPreset !== "default";
  }

  // Which tail should the last EQ node feed right now? One place decides:
  //  - Baseline (100% + Flat): masterGain at gain 1.0 — a bit-transparent passthrough.
  //    The shaper would otherwise saturate every peak above its knee and colour the
  //    sound; the leveler would compress it. Neither is wanted when the user asked for
  //    nothing, so we route around both.
  //  - Engaged + Stable-Volume on: the leveler chain (compress -> makeup -> limiter).
  //  - Engaged + soft-clip on: the shaper (boost baked in, peaks rounded). This is the
  //    default when boosting — a preset's EQ lift or a slider boost can push peaks past
  //    the ceiling, and the shaper keeps that from hard-clipping.
  //  - Engaged + both off: masterGain — the raw, freely-clippable boosted signal (A/B).
  function activeTail() {
    if (!processingEngaged()) return masterGain;
    if (levelerEnabled) return leveler;
    if (clipEnabled) return shaper;
    return masterGain;
  }

  // Point the last EQ node (tameFilter) at whichever tail activeTail() picks. Every
  // tail stays wired to the speakers, so this is just re-pointing one connection —
  // safe to flip live (soft-clip toggle, Stable-Volume toggle, or crossing 100%).
  function routeClip() {
    if (!tameFilter || !masterGain || !shaper || !leveler) return;
    try {
      tameFilter.disconnect();
    } catch (err) {
      /* nothing connected yet */
    }
    tameFilter.connect(activeTail());
  }

  // Engage/bypass the always-there high-pass WITHOUT re-wiring the graph. The node
  // stays in the chain; we just change what it does. When processing is engaged — a
  // boost (>100%) or a non-Flat preset — it's a real 80 Hz high-pass (rumble out,
  // body kept). At the do-nothing baseline (100% + Flat) it becomes a 0 dB "peaking"
  // filter, which is a mathematically EXACT identity (numerator == denominator,
  // H(z) = 1 at every frequency) — so the untouched signal passes through bit-for-
  // bit. This is why 100% + Flat sounds identical to no extension at all: nothing in
  // the chain colours it. Safe to flip live (just changes params).
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

  // Programmatic on/off for the "Stable Volume" (compressor) tail — the A/B against
  // the soft clipper. When on, it takes precedence over the soft clipper (see
  // activeTail). Flip it live on a real video to compare: setLeveler(true|false).
  function setLevelerEnabled(on) {
    levelerEnabled = !!on;
    routeClip();
    return levelerEnabled;
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
    // The baseline (100% + Flat) must be truly native — routing an element through
    // the graph is itself audible even when the graph is transparent. So don't route
    // until the user has actually asked for something. NOT marked skipped: it stays a
    // candidate, so wireAll picks it up the moment we engage.
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
    mudFilter.gain.value = preset.mudGainDb;
    presenceFilter.gain.value = preset.presenceGainDb;
    tameFilter.gain.value = preset.tameGainDb;
  }

  // Bring the graph up, hook gestures, and take over if we already can. Never
  // routes anything into a suspended context.
  //
  // At the do-nothing baseline (100% + Flat) we do NOTHING until a graph already
  // exists: building an AudioContext and pulling the media in through
  // createMediaElementSource is itself audible (it re-paths and resamples the
  // audio), so a tab the user never boosted must stay 100% native. We only build +
  // route once the user actually asks for something — a boost or a preset. (If a
  // graph was already built by an earlier boost we keep going; it's idempotent and
  // wireAll won't re-route at the baseline anyway.)
  function engage() {
    if (!processingEngaged() && !audioContext) return;
    buildGraph();
    hookGestures();
    audioContext.resume().catch(() => {}); // fire-and-forget; may be a no-op until a gesture
    engaged = true;
    if (audioContext.state === "running") wireAll();
  }

  // Tell the background page our current volume + preset. It uses this to stamp
  // (or clear) the toolbar badge AND to remember this tab's setting across a
  // refresh. Fire-and-forget; if the background isn't up yet it rejects harmlessly.
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
    // A preset counts as "processing engaged", so re-point both bypasses: the
    // high-pass drops in for Voice/Bass (out for Flat) and the soft clipper engages
    // to catch the preset's EQ peaks (bypassed again on Flat at 100%).
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
      // The popup shows a hint when boost is engaged but the page context isn't
      // running yet (user needs to click the page), or when some media can't be
      // boosted because it's cross-origin.
      pending: engaged && contextState !== "running" && counts.routable > 0,
      blockedMedia: counts.blocked,
      // "tricky" = a known streaming host whose DRM audio we can't route (see
      // TRICKY_HOSTS). The popup turns this into an orange "out of my hands"
      // warning. (The embedded cross-origin <iframe> case — audible tab, no media
      // the top document can see — is detected in the popup instead.)
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

  // Console test hook. From the *content script's* devtools context you can run:
  //   __tabVolumeBooster.setSoftClip(false)  // hear the raw, clippable boost
  //   __tabVolumeBooster.setSoftClip(true)   // smooth, protected again
  //   __tabVolumeBooster.setLeveler(true)    // A/B: YouTube-style "Stable Volume" path
  //   __tabVolumeBooster.setLeveler(false)   // back to the soft clipper
  // Boost the slider first (the tails only run while engaged), then flip live to A/B.
  // (Easiest: DevTools console context dropdown -> this page's content script,
  //  or drive it from the popup via a "set-softclip" / "set-leveler" message.)
  window.__tabVolumeBooster = {
    setSoftClip: setSoftClipEnabled,
    isSoftClipEnabled: () => clipEnabled,
    setLeveler: setLevelerEnabled,
    isLevelerEnabled: () => levelerEnabled,
  };

  // Restore this tab's last volume/preset (survives a refresh, since a refresh
  // keeps the tab id). We run in EVERY frame and apply uniformly — no top-frame /
  // has-media special-casing. Building the graph in a frame is cheap and silent:
  // nothing is ever routed until the context is running AND the frame actually has
  // a media element (see wireAll), so an empty ad/tracker frame just holds an idle,
  // soundless graph. One rule for every frame means live control and a reload can't
  // drift apart — every frame that has media boosts, together.
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
