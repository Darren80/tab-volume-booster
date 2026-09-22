// Tab Volume Booster - content script
// Routes each <video>/<audio> element through a Web Audio graph:
//   source -> lowCutFilter (highpass) -> bassFilter (lowshelf) -> voiceBoostFilter (peaking) -> [ compressor ] -> [ soft clipper | masterGain ] -> destination
// The last stage is one of two swappable tails (see activeTail): the soft clipper
// or a plain gain node (raw/transparent). By default the soft clipper engages
// automatically when the signal's crest factor (peak − RMS) exceeds 14.4 dB,
// keeping hard clip for smooth audio and soft clip for spiky audio. The compressor
// (leveller) sits just before the tail and is switched in/out by routeClip when
// active (see compressorActive).

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

    // ---- EQ faders: the dB range the popup's per-band sliders span. ----------
    //  Boost-only, like the volume slider — this add-on lifts bands, never cuts them.
    //  The presets above are just points inside this range that the faders snap to;
    //  dragging a fader past a preset puts the tone into a "custom" state. Widen the
    //  range here (e.g. minDb: -12) if you ever want the faders to cut as well as boost.
    eq: {
      minDb: 0, // flat (no lift)
      maxDb: 18, // headroom above the strongest preset (Bass +14 dB)
      stepDb: 1, // fader granularity
    },

    // ---- The soft clipper: the anti-clipping stage at the end of the chain. --
    //  When the boost pushes peaks past the digital ceiling (±1.0), instead of chopping
    //  them square (harsh clipping) we ROUND them off into warm saturation, acting only on
    //  the top peaks so it doesn't squash dynamics like a compressor. Because a WaveShaper
    //  clamps its input to ±1, the boost is baked INTO the curve, rebuilt on every slider move.
    softClip: {
      enabled: true,
      kneeStartDb: -1, // where the curve starts to bend (dB below ceiling)
      ceilingDb: 0,
      curveSamples: 8192,
      oversample: "2x",
      // ·· AUTO MODE: engage soft clip only when the audio needs it ···········
      //  Smooth, well-mastered audio sounds punchier hard-clipped; spiky audio
      //  (lecture onsets, sharp transients) sounds harsh hard-clipped and needs
      //  the soft clipper. The crest factor (peak − RMS, in dB) measures how
      //  spiky the signal is: low = smooth/full, high = sharp transients.
      //  When auto is true the extension measures the running crest factor and
      //  enables soft clip only when it exceeds the threshold.
      //  Tested across 10 diverse audio sources (mastered music, TED talks,
      //  vintage interviews, audiobooks, classroom lectures) — 14.4 dB was the
      //  crossover where hard clip started sounding worse than soft clip.
      auto: true,
      autoCrestFactorThresholdDb: 14.4,
      //  Smoothing for the running crest factor estimate. Slower = more stable
      //  (won't flicker between modes on a single loud syllable). 2.0 s means
      //  the estimate settles after ~4 seconds of signal.
      autoCrestFactorSmoothingSeconds: 2.0,
    },

    // ---- The leveller (adaptive limiter): clamps loud spikes, leaves normal audio alone. --
    //  Tracks the signal's running-average PEAK level and clamps anything that pokes above
    //  it by more than marginDb. Normal audio passes at unity gain; only spikes get pulled
    //  down. The average uses asymmetric smoothing: it RISES fast (so normal speech after a
    //  pause isn't falsely flagged) but FALLS slowly (so pauses don't drag it down and screams
    //  can't chase it up). Tested against a real peaky lecture recording — 28 spike regions
    //  caught in 14.5 minutes, 99.7% of the signal untouched.
    //  Toggle live in the console: __tabVolumeBooster.setCompressor(true/false)
    compressor: {
      enabled: true,

      // ·· TUNE THIS: how aggressive the leveller is ·························
      //  These two knobs together decide what gets clamped and how hard.

      //  What counts as a spike: "how far above the running average peak does a
      //  signal have to be before the leveller touches it?" Everything below
      //  this margin passes untouched — same loudness, same boost as without
      //  the leveller. Everything above it gets squashed back down. 8 dB means
      //  a peak has to be ~2.5× louder than where peaks normally sit to be
      //  flagged — catches genuine shouts, leaves natural speech emphasis alone.
      //    ▲ raise toward 12  → more lenient, only the loudest screams get caught
      //    ▼ lower toward 6   → more aggressive, catches smaller spikes too
      marginDb: 7,

      //  How hard spikes get squashed: for every N dB the signal overshoots
      //  the threshold, only 1 dB comes out. 12:1 is near brick-wall — a scream
      //  barely rises past the threshold at all. This is the other half of "how
      //  aggressive": marginDb decides WHERE the line is, ratio decides HOW HARD
      //  you enforce it.
      //    ▲ higher (20)  → harder wall, almost nothing gets through
      //    ▼ lower  (4)   → gentler, screams still poke out a bit
      ratio: 16,

      // ·· TUNE IF IT SOUNDS OFF ··············································
      //  The leveller works but something sounds weird — ducking after shouts,
      //  screams escaping, breathing/pumping. Reach for these.

      //  How fast the average RISES when the signal gets louder. Fast rise means
      //  the average catches up to normal speech quickly after a pause, so it
      //  doesn't falsely flag normal speech as a spike. But if it's too fast, the
      //  average chases a scream up and lets it escape. 0.15 s is fast enough to
      //  settle within ~3 updates (150 ms) when speech starts, slow enough that a
      //  scream barely pulls it up before the compressor clamps down.
      //    ▲ raise toward 0.3  → slower to catch up after pauses, but screams can't escape
      //    ▼ lower toward 0.05 → instant catch-up, but screams will escape too
      riseSeconds: 0.15,

      //  How slowly the average FALLS when the signal gets quieter. Slow fall
      //  means the average holds its level through pauses and between sentences,
      //  so when speech resumes it comes back at the level the average expects.
      //  A scream can't drag the average down either. 3.0 s means a brief pause
      //  barely lowers the average.
      //    ▲ raise toward 5.0  → average holds longer through silence/quiet sections
      //    ▼ lower toward 1.5  → average drops faster, adapts to genuinely quieter sections
      fallSeconds: 3.0,

      //  How fast the limiter lets go after a spike passes. On speech this is
      //  audible: too slow and the quiet word RIGHT AFTER a scream gets ducked,
      //  too fast and you hear the volume "pumping" back up.
      //    ▲ higher (0.5)  → slow recovery, can duck the word after a scream
      //    ▼ lower  (0.1)  → fast recovery, but may sound "pumpy" on dense audio
      releaseSeconds: 0.25,

      // ·· RARELY CHANGE ······················································
      //  Fine-tuning for the shape of the clamping. The defaults are set for
      //  transparent, invisible limiting. Only touch if the leveller sounds
      //  audibly artificial.

      //  Knee width around the threshold: how abruptly the clamping kicks in.
      //  A narrow knee = sharp limiter, a wide knee = gradual compressor feel.
      //    ▲ higher (10)  → softer, more gradual onset (compressor-like)
      //    ▼ lower  (2)   → sharper, more sudden (limiter-like)
      kneeDb: 4,

      //  Attack: how fast the limiter grabs a spike once it crosses the threshold.
      //  3 ms catches the onset transient before it's audible as a click.
      //    ▲ higher (0.01)  → lets the very first "pop" of a shout through
      //    ▼ lower  (0.001) → catches it harder, but risks distorting the waveform
      attackSeconds: 0.003,

      // ·· DON'T CHANGE: measurement plumbing ·································
      //  Internal wiring for the level-tracking system. These have correct values;
      //  changing them won't improve the sound, but wrong values will break it.
      silenceGateDb: -40,             // below this = silence; don't update the average (holds it steady through pauses)
      updateIntervalMilliseconds: 50, // re-measure interval (ms); lower = smoother + more CPU
      levelMeterFftSize: 2048,        // AnalyserNode sample window (must be a power of two)
      minimumThresholdDb: -60,        // floor so silence doesn't send the threshold to -Infinity
      maximumThresholdDb: 0,          // ceiling: the Web Audio node only accepts up to 0 dB
    },

    // ---- DRM detection: the ONLY 100%-certain "cannot boost" signal. --------
    //  A companion MAIN-world script (drm-detector.js) runs before the page and wraps the
    //  page's Encrypted Media Extensions (EME) setup. The instant the page attaches a DRM
    //  content key to a media element, the detector postMessages us and we latch drmBlocked.
    //  That is proof — not a host guess — that the audio is encrypted and unreachable by our
    //  Web Audio graph (see getState().drmBlocked and the popup's definitive warning). This
    //  is what makes sites like Spotify, whose audio element is never even in the DOM, report
    //  honestly instead of silently doing nothing.
    drm: {
      // These MUST match DRM_DETECTOR_SETTINGS in drm-detector.js — the two scripts live in
      // separate JS worlds and can only agree on the protocol by matching literals.
      detectedMessageTag: "crescendo-drm-detected", // detector -> us: "this tab is DRM-locked"
      queryMessageTag: "crescendo-drm-query", // us -> detector: "replay if you already detected it"
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
  let compressor = null; // DynamicsCompressorNode levelling dynamics BEFORE the boost tail
  let compressorEnabled = SETTINGS.compressor.enabled; // live bypass flag; toggle with setCompressorEnabled()
  let levelMeter = null; // AnalyserNode tapping the compressor's input, to measure the running average
  let levelMeterSamples = null; // reusable Float32Array the AnalyserNode fills each reading (see measureLevel)
  let runningAverageDb = null; // the smoothed average loudness the adaptive threshold rides on (null = not measured yet)
  let adaptiveThresholdTimerId = null; // setInterval id for the threshold tracker; non-null only while it's running
  let runningPeakDb = null; // smoothed peak level for crest factor measurement (auto soft-clip)
  let runningRmsDb = null; // smoothed RMS level for crest factor measurement (auto soft-clip)
  let debugCrestFactorTickCount = 0; // throttle counter for debug logging
  let eqNodes = {}; // gainKey -> its BiquadFilter, populated in buildGraph (see EQ_BANDS)
  let gesturesHooked = false;
  let drmBlocked = false; // latched by the DRM detector (see SETTINGS.drm): proof this tab's audio is EME-locked and un-boostable

  const wired = new WeakSet(); // elements routed through the graph
  const skipped = new WeakSet(); // elements we left native (CORS upgrade failed / untouchable)
  const upgrading = new WeakSet(); // elements mid CORS-upgrade (reloading with crossOrigin set)
  const observedRoots = new WeakSet(); // document + open shadow roots we watch for new media

  let currentVolume = SETTINGS.volume.defaultPercent / 100; // gain multiplier: 1.0 == 100%
  // The per-band EQ gains (in dB) are the single source of truth for the tone. Presets
  // are just named points in this space; the popup's faders write here directly. The
  // "current preset" is DERIVED from these gains (presetNameFor): it's a named preset
  // when the gains match one exactly, else "custom".
  let eqGains = { ...SETTINGS.presets.default };
  let engaged = false; // the user has asked us to take over

  // The user-adjustable EQ bands the popup shows as sliders, in display order. This is
  // the ONE list that ties each preset gain key to its filter band and the label the
  // popup prints — getState ships it to the popup, which builds a slider per entry. To
  // add / remove / rename / re-tune a fader, edit here (+ the matching `presets` gain
  // key and, for a brand-new band, its node in buildGraph); nothing else hardcodes a band.
  const EQ_BANDS = [
    { gainKey: "bassGainDb", label: "Bass", frequencyHz: SETTINGS.bassBand.frequencyHz },
    { gainKey: "voiceBoostGainDb", label: "Voice", frequencyHz: SETTINGS.voiceBoostBand.frequencyHz },
  ];

  // Which named preset (if any) do the current EQ gains correspond to? Returns the
  // preset key when every band matches one exactly, otherwise "custom" (a hand-tuned tone).
  function presetNameFor(gains) {
    for (const [name, preset] of Object.entries(SETTINGS.presets)) {
      if (EQ_BANDS.every((b) => (preset[b.gainKey] || 0) === (gains[b.gainKey] || 0))) {
        return name;
      }
    }
    return "custom";
  }
  const currentPresetName = () => presetNameFor(eqGains);

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

    // The leveller: evens out loud/quiet swings BEFORE the boost tail lifts them (see
    // routeClip / compressorActive). Params live in SETTINGS.compressor.
    compressor = audioContext.createDynamicsCompressor();
    compressor.knee.value = SETTINGS.compressor.kneeDb;
    compressor.ratio.value = SETTINGS.compressor.ratio;
    compressor.attack.value = SETTINGS.compressor.attackSeconds;
    compressor.release.value = SETTINGS.compressor.releaseSeconds;
    // The threshold is not fixed — the adaptive tracker rides it on the running average (see
    // updateAdaptiveThreshold). Start it at the floor so nothing is clamped until we've measured.
    compressor.threshold.value = SETTINGS.compressor.minimumThresholdDb;

    // Parallel tap that measures the compressor's INPUT level (an AnalyserNode passes no audio
    // onward — it's a pure meter). measureLevel reads it; updateAdaptiveThreshold turns the
    // reading into the running average that aims the threshold.
    levelMeter = audioContext.createAnalyser();
    levelMeter.fftSize = SETTINGS.compressor.levelMeterFftSize;
    levelMeterSamples = new Float32Array(levelMeter.fftSize);
    voiceBoostFilter.connect(levelMeter);

    // Map each EQ band's gain key to its filter node, so applyPresetNodes can push the
    // gains generically (one entry per EQ_BANDS row).
    eqNodes = { bassGainDb: bassFilter, voiceBoostGainDb: voiceBoostFilter };

    // TWO possible tails, both wired to the speakers; the LAST EQ node (voiceBoostFilter)
    // feeds exactly one (see routeClip / activeTail), so switching is instant.
    //  SOFT-CLIP : voiceBoostFilter -> shaper -> destination      (default when boosting; boost baked into the curve)
    //  RAW/BASE  : voiceBoostFilter -> masterGain -> destination  (transparent at 100%, raw clippable boost above)
    masterGain = audioContext.createGain();
    masterGain.gain.value = currentVolume;

    shaper = audioContext.createWaveShaper();
    shaper.oversample = SETTINGS.softClip.oversample;
    updateShaperCurve(); // bakes the current volume + the soft-clip shape into the curve

    // EQ chain (frequency order): lowCut -> bass -> voiceBoost -> tail.
    // Biquads in series are commutative in magnitude, so the order is just for readability.
    lowCutFilter.connect(bassFilter);
    bassFilter.connect(voiceBoostFilter); // voiceBoostFilter is the last EQ node (feeds the tail)
    masterGain.connect(audioContext.destination); // RAW/BASE tail — always wired, fed only when active
    shaper.connect(audioContext.destination); //     SOFT-CLIP tail — always wired, fed only when active
    routeClip(); // point voiceBoostFilter at whichever tail is active
    routeLowCut(); // high-pass on only when boosting/preset; exact passthrough at baseline

    applyPresetNodes();

    // When the context becomes runnable (after a page gesture), take over.
    audioContext.addEventListener("statechange", () => {
      if (audioContext.state === "running") wireAll();
      syncAdaptiveThresholdTracker(); // audio just started/stopped flowing — match the tracker to it
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
  // OR any EQ band lifted off 0 dB. The soft clipper and high-pass key off this together;
  // when it's false (100% + every band flat) the chain collapses to a bit-for-bit passthrough.
  function processingEngaged() {
    return currentVolume > 1 || EQ_BANDS.some((b) => (eqGains[b.gainKey] || 0) !== 0);
  }

  // Which tail should the last EQ node feed right now? One place decides:
  //  - Baseline (100% + Flat): masterGain at 1.0 — a bit-transparent passthrough, routing around
  //    the shaper (which would colour peaks).
  //  - Engaged: the shaper if soft-clip is on (the default when boosting), else masterGain
  //    (the raw, freely-clippable boost, A/B).
  function activeTail() {
    if (!processingEngaged()) return masterGain;
    if (clipEnabled) return shaper;
    return masterGain;
  }

  // Is the leveller in the signal path right now? Like the soft clipper it only acts while
  // processing is engaged, so the 100%+Flat baseline stays a bit-for-bit passthrough.
  function compressorActive() {
    return compressorEnabled && processingEngaged();
  }

  // Point the last EQ node (voiceBoostFilter) at whichever tail activeTail() picks, routing
  // THROUGH the leveller first when it's active:
  //   leveller on : voiceBoostFilter -> compressor -> activeTail -> destination
  //   leveller off: voiceBoostFilter ->               activeTail -> destination
  // Every tail stays wired to the speakers, so this just re-points connections — safe to flip live.
  function routeClip() {
    if (!voiceBoostFilter || !masterGain || !shaper || !compressor || !levelMeter) return;
    try {
      voiceBoostFilter.disconnect(); // drops the tail/compressor AND the levelMeter tap ...
    } catch (err) {
      /* nothing connected yet */
    }
    try {
      compressor.disconnect();
    } catch (err) {
      /* nothing connected yet */
    }
    voiceBoostFilter.connect(levelMeter); // ... so re-establish the meter tap every time (parallel, no audio out)
    const tail = activeTail();
    if (compressorActive()) {
      voiceBoostFilter.connect(compressor); // level the dynamics ...
      compressor.connect(tail); // ... then the tail applies the boost
    } else {
      voiceBoostFilter.connect(tail);
    }
    syncAdaptiveThresholdTracker(); // start/stop the threshold tracker to match the new routing
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

  // Programmatic on/off for the soft clipper. An explicit toggle disables auto
  // mode so the user's choice sticks (otherwise the tracker overrides it in 50ms).
  function setSoftClipEnabled(on) {
    SETTINGS.softClip.auto = false;
    clipEnabled = !!on;
    routeClip();
    return clipEnabled;
  }

  // Programmatic on/off for the leveller — handy for A/B testing. Call
  // setCompressorEnabled(false) to hear the raw, unlevelled dynamics, true to even them out.
  function setCompressorEnabled(on) {
    compressorEnabled = !!on;
    routeClip();
    return compressorEnabled;
  }

  // Asymmetric smoothing factors for the adaptive threshold tracker. The average RISES fast
  // (riseAlpha — catches up to speech after a pause) but FALLS slowly (fallAlpha — holds
  // through pauses, resists screams dragging it down). Derived from SETTINGS, not magic numbers.
  const ADAPTIVE_RISE_ALPHA = 1 - Math.exp(
    -(SETTINGS.compressor.updateIntervalMilliseconds / 1000) / SETTINGS.compressor.riseSeconds
  );
  const ADAPTIVE_FALL_ALPHA = 1 - Math.exp(
    -(SETTINGS.compressor.updateIntervalMilliseconds / 1000) / SETTINGS.compressor.fallSeconds
  );
  const CREST_FACTOR_ALPHA = 1 - Math.exp(
    -(SETTINGS.compressor.updateIntervalMilliseconds / 1000) / SETTINGS.softClip.autoCrestFactorSmoothingSeconds
  );

  // Read the compressor's input level RIGHT NOW in dBFS (0 dB == full scale). Returns both
  // peak and RMS: the compressor uses the peak for its adaptive threshold, and the auto
  // soft-clip uses the gap between them (the crest factor) to decide whether the signal is
  // spiky enough to need soft clipping. Returns null when the tap is silent/not yet flowing.
  function measureLevel() {
    if (!levelMeter || !levelMeterSamples) return null;
    levelMeter.getFloatTimeDomainData(levelMeterSamples);
    let peakSample = 0;
    let sumOfSquares = 0;
    for (let index = 0; index < levelMeterSamples.length; index++) {
      const absoluteSample = Math.abs(levelMeterSamples[index]);
      if (absoluteSample > peakSample) peakSample = absoluteSample;
      sumOfSquares += levelMeterSamples[index] * levelMeterSamples[index];
    }
    if (peakSample <= 0) return null;
    const peakDb = 20 * Math.log10(peakSample);
    const rmsSample = Math.sqrt(sumOfSquares / levelMeterSamples.length);
    const rmsDb = rmsSample > 0 ? 20 * Math.log10(rmsSample) : peakDb;
    return { peakDb, rmsDb };
  }

  // One tick of the tracker: fold the latest peak level into the running average, then aim the
  // compressor's threshold at (average + marginDb) so only signal ABOVE that — the spikes —
  // gets clamped. The threshold is glided (setTargetAtTime) rather than stepped, so it never
  // zippers.
  //
  // Three guards keep the average where speech is, not where silence/screams drag it:
  //   1. Silence gate: readings below silenceGateDb are ignored (average holds through pauses)
  //   2. Fast rise: when the signal is ABOVE the average, the average catches up quickly (so
  //      normal speech after a pause isn't falsely flagged)
  //   3. Slow fall: when the signal is BELOW the average, the average drops slowly (holds its
  //      level between sentences, resists pauses dragging it down)
  function updateAdaptiveThreshold() {
    if (!audioContext) return;
    const measurement = measureLevel();
    if (measurement === null) return;
    const { peakDb, rmsDb } = measurement;
    // Silence gate: don't update the average during pauses — hold it where speech was.
    if (peakDb < SETTINGS.compressor.silenceGateDb) return;

    // Leveller: fold the peak into the running average and aim the compressor threshold.
    if (compressor && compressorActive()) {
      const flooredMeasuredDb = Math.max(SETTINGS.compressor.minimumThresholdDb, peakDb);
      if (runningAverageDb === null) {
        runningAverageDb = flooredMeasuredDb;
      } else {
        const alpha = flooredMeasuredDb > runningAverageDb ? ADAPTIVE_RISE_ALPHA : ADAPTIVE_FALL_ALPHA;
        runningAverageDb += alpha * (flooredMeasuredDb - runningAverageDb);
      }
      const targetThresholdDb = Math.min(
        SETTINGS.compressor.maximumThresholdDb,
        Math.max(SETTINGS.compressor.minimumThresholdDb, runningAverageDb + SETTINGS.compressor.marginDb)
      );
      const glideSeconds = SETTINGS.compressor.updateIntervalMilliseconds / 1000;
      compressor.threshold.setTargetAtTime(targetThresholdDb, audioContext.currentTime, glideSeconds);
    }

    // Auto soft-clip: track the running crest factor (peak − RMS) and enable/disable
    // soft clipping based on whether the signal is spiky enough to need it.
    if (SETTINGS.softClip.auto) {
      if (runningPeakDb === null || runningRmsDb === null) {
        runningPeakDb = peakDb;
        runningRmsDb = rmsDb;
      } else {
        runningPeakDb += CREST_FACTOR_ALPHA * (peakDb - runningPeakDb);
        runningRmsDb += CREST_FACTOR_ALPHA * (rmsDb - runningRmsDb);
      }
      const crestFactorDb = runningPeakDb - runningRmsDb;
      // DEBUG: log crest factor ~1x/sec (every 20 ticks at 50ms interval). Remove after testing.
      debugCrestFactorTickCount++;
      const debugLogIntervalTicks = Math.round(1000 / SETTINGS.compressor.updateIntervalMilliseconds);
      if (debugCrestFactorTickCount % debugLogIntervalTicks === 0) {
        console.log(
          `[CF] crest=${crestFactorDb.toFixed(1)} dB | threshold=${SETTINGS.softClip.autoCrestFactorThresholdDb} dB | ` +
          `peak=${runningPeakDb.toFixed(1)} rms=${runningRmsDb.toFixed(1)} | ` +
          `softClip=${clipEnabled ? "ON" : "OFF"}`
        );
      }
      const shouldSoftClip = crestFactorDb >= SETTINGS.softClip.autoCrestFactorThresholdDb;
      if (shouldSoftClip !== clipEnabled) {
        clipEnabled = shouldSoftClip;
        routeClip();
      }
    }
  }

  // Run the tracker while the leveller OR auto soft-clip needs measurement AND audio is
  // flowing; otherwise stop it and park the threshold at the floor (unity, nothing clamped).
  // Called wherever compressorActive() can change — from routeClip and on the context statechange.
  function syncAdaptiveThresholdTracker() {
    const needsTracking = compressorActive() || (SETTINGS.softClip.auto && processingEngaged());
    const shouldRun = needsTracking && audioContext && audioContext.state === "running";
    if (shouldRun) {
      if (adaptiveThresholdTimerId !== null) return;
      runningAverageDb = null; // re-measure fresh each time it engages
      runningPeakDb = null;
      runningRmsDb = null;
      adaptiveThresholdTimerId = setInterval(
        updateAdaptiveThreshold,
        SETTINGS.compressor.updateIntervalMilliseconds
      );
    } else {
      if (adaptiveThresholdTimerId === null) return;
      clearInterval(adaptiveThresholdTimerId);
      adaptiveThresholdTimerId = null;
      runningAverageDb = null;
      runningPeakDb = null;
      runningRmsDb = null;
      if (compressor) compressor.threshold.value = SETTINGS.compressor.minimumThresholdDb;
    }
  }

  // Is this source one Web Audio can always tap without a CORS opt-in? blob:/data:/MSE
  // and same-origin media are never tainted; an empty src (nothing loaded yet) counts too.
  function isSameOriginish(src) {
    if (!src) return true;
    if (src.startsWith("blob:") || src.startsWith("data:") || src.startsWith("mediasource:")) {
      return true;
    }
    try {
      return new URL(src, location.href).origin === location.origin;
    } catch (err) {
      return true;
    }
  }

  // Can this element's audio survive createMediaElementSource without being silenced *as-is*?
  // Same-originish always; a cross-origin element only if it already opted into CORS. When this
  // is false we no longer give up — corsUpgrade() reloads it CORS-enabled (see wireElement).
  function isRoutable(element) {
    const src = element.currentSrc || element.src || "";
    if (isSameOriginish(src)) return true;
    return element.crossOrigin === "anonymous" || element.crossOrigin === "use-credentials";
  }

  // Route an element into the graph. Only call this once we expect its audio to be
  // exposable (same-originish, or a CORS-clean cross-origin load) — a tap can't be undone,
  // so tapping a tainted element would silence it permanently.
  function tapElement(element) {
    if (wired.has(element)) return;
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

  // Make a cross-origin (or not-yet-loaded) element tappable by requesting its media WITH
  // CORS. Setting crossOrigin + reloading forces the (current or next) fetch to go out
  // CORS-enabled; if the server allows it the load succeeds and we tap it, if it refuses the
  // element fires `error` and we roll the attribute back so it keeps playing natively.
  //
  // We wait for `loadeddata` before tapping (never tap on a still-tainted element), and for an
  // element with no src yet we just arm the listeners and wait for the page to load something.
  function corsUpgrade(element) {
    if (upgrading.has(element)) return;
    upgrading.add(element);

    const src = element.currentSrc || element.src || "";
    const wasPaused = element.paused;
    const resumeAt = element.currentTime || 0;
    const hadCrossOrigin = element.hasAttribute("crossorigin");

    const cleanup = () => {
      element.removeEventListener("loadeddata", onOk);
      element.removeEventListener("error", onFail);
    };
    const onOk = () => {
      cleanup();
      upgrading.delete(element);
      tapElement(element); // CORS-clean now — route it through the graph
    };
    const onFail = () => {
      cleanup();
      upgrading.delete(element);
      // Server didn't allow CORS: undo the opt-in so the element loads (and plays) natively
      // again — unboosted, but audible.
      skipped.add(element);
      if (!hadCrossOrigin) element.removeAttribute("crossorigin");
      try {
        element.load();
        if (resumeAt) element.currentTime = resumeAt;
        if (!wasPaused) element.play().catch(() => {});
      } catch (err) {
        /* best effort */
      }
    };

    element.addEventListener("loadeddata", onOk, { once: true });
    element.addEventListener("error", onFail, { once: true });

    element.crossOrigin = "anonymous";
    // Reload so the current fetch re-runs CORS-enabled. With no src loaded yet, skip the
    // reload and let the armed listeners fire once the page sets one.
    if (src) {
      try {
        element.load();
        try {
          if (resumeAt) element.currentTime = resumeAt;
        } catch (err) {
          /* seeking not ready yet */
        }
        if (!wasPaused) element.play().catch(() => {});
      } catch (err) {
        /* best effort */
      }
    }
  }

  function wireElement(element) {
    if (wired.has(element) || skipped.has(element) || upgrading.has(element)) return;
    // The baseline (100% + Flat) must be truly native — routing an element through the
    // graph is itself audible, so don't route until the user asks for something. Not marked
    // skipped, so it stays a candidate wireAll picks up the moment we engage.
    if (!processingEngaged()) return;

    const src = element.currentSrc || element.src || "";
    // Something is loaded AND it's tappable as-is (same-originish, or already CORS): route now.
    if (src && isRoutable(element)) {
      tapElement(element);
      return;
    }
    // Otherwise it's cross-origin without a CORS opt-in, or nothing is loaded yet (its future
    // src is unknown). Reload it CORS-enabled and tap on success; corsUpgrade rolls back to
    // native if the server refuses CORS. This is what makes players that swap in a cross-origin
    // src — e.g. a bare <audio> pointed at a CDN — boostable instead of silently skipped.
    corsUpgrade(element);
  }

  // Walk `node` and everything beneath it, CROSSING INTO open shadow roots. The plain
  // querySelectorAll/MutationObserver pair only sees the light DOM, so a player that
  // mounts its <video> inside a web component's shadow root — e.g. BBC's Standard Media
  // Player — is invisible to it and never gets boosted. onMedia fires for each
  // <video>/<audio>; onRoot fires for the document and each shadow root, so callers can
  // observe each for elements added later. Closed shadow roots are unreachable
  // (element.shadowRoot is null) and simply stay native, exactly as before.
  function walk(node, onMedia, onRoot) {
    if (node instanceof Element) {
      if (node.tagName === "VIDEO" || node.tagName === "AUDIO") onMedia?.(node);
      if (node.shadowRoot) walk(node.shadowRoot, onMedia, onRoot); // dive into the shadow tree too
    } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_NODE) {
      onRoot?.(node); // a shadow root, or the document itself
    }
    const kids = node.children; // light-DOM children (undefined for text/comment nodes)
    if (kids) for (const child of kids) walk(child, onMedia, onRoot);
  }

  // Watch one root (the document or a shadow root) for media added later, pulling any
  // shadow roots a newly-added subtree brings into the watch set as well. A subtree
  // MutationObserver can't see across a shadow boundary, so each shadow root needs its
  // own observer. Each root is observed once (observedRoots), so this stays idempotent.
  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    const obs = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => walk(node, wireElement, observeRoot));
      }
    });
    obs.observe(root, { childList: true, subtree: true });
  }

  // Only ever called while the context is running.
  function wireAll() {
    if (!audioContext || audioContext.state !== "running") return;
    if (!processingEngaged()) return; // baseline: leave every element native (see wireElement)
    // Wire every media element (light DOM AND open shadow roots) and watch each root
    // for more that appear later.
    walk(document, wireElement, observeRoot);
    masterGain.gain.value = currentVolume;
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

  // Push the current EQ gains onto the filter nodes (the one place that touches them).
  // Data-driven from EQ_BANDS -> eqNodes, so it needs no edits when a band is added.
  function applyPresetNodes() {
    for (const band of EQ_BANDS) {
      const node = eqNodes[band.gainKey];
      if (node) node.gain.value = eqGains[band.gainKey] || 0;
    }
  }

  // Clamp an EQ gain to the fader range so a stray/hand-crafted message can't push a
  // band outside what the popup can represent.
  const clampEqDb = (db) =>
    Math.min(SETTINGS.eq.maxDb, Math.max(SETTINGS.eq.minDb, Number(db) || 0));

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

  // Tell the background page our current volume + preset + EQ gains — it stamps the
  // toolbar badge and remembers this tab's setting across a refresh. The EQ gains ride
  // along so a hand-tuned ("custom") tone survives a reload too. Fire-and-forget.
  function reportState() {
    try {
      api.runtime
        .sendMessage({
          type: "vol-state",
          volume: Math.round(currentVolume * 100),
          preset: currentPresetName(),
          eq: { ...eqGains },
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
    updateShaperCurve(); // SOFT-CLIP path: rebuild the curve with the new boost baked in
    routeClip(); // engage the shaper only while boosting; bypass it (transparent) at 100%
    routeLowCut(); // engage the high-pass only while boosting; exact passthrough at 100%+Flat
  }

  // Load a named preset's gains into the faders (Flat/Voice/Bass). Unknown names fall
  // back to Flat. This just seeds eqGains, then routes through the shared apply path.
  function applyPreset(name) {
    const preset = SETTINGS.presets[name] || SETTINGS.presets.default;
    eqGains = { ...preset };
    applyEq();
  }

  // Set one or more EQ band gains from the popup's faders. Merges the given bands into
  // the current gains (so moving one fader doesn't reset the other), clamps to range,
  // and routes. The preset name is DERIVED afterwards — matching a preset re-lights its
  // button, anything else reads as "custom".
  function setEq(gains) {
    if (!gains) return;
    for (const band of EQ_BANDS) {
      if (band.gainKey in gains) eqGains[band.gainKey] = clampEqDb(gains[band.gainKey]);
    }
    applyEq();
  }

  // The shared tail for both applyPreset and setEq: bring the graph up, push the gains
  // onto the nodes, and re-point the bypasses. The high-pass and soft clipper drop in
  // whenever any band is lifted, and out again when every band is back to 0 dB.
  function applyEq() {
    engage();
    applyPresetNodes();
    routeLowCut();
    routeClip();
    reportState(); // remember the tone for this tab (and refresh the badge)
  }

  // --- State for the popup ----------------------------------------------

  function countMedia() {
    const media = [];
    walk(document, (element) => media.push(element)); // pierces open shadow roots (see walk)
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
      preset: currentPresetName(),
      // The EQ, described entirely from this side so the popup builds its sliders from
      // one source: the band list (key/label/frequency + current gain) and the shared
      // dB range. Change a band or the range in SETTINGS/EQ_BANDS and the popup follows.
      eqBands: EQ_BANDS.map((b) => ({
        gainKey: b.gainKey,
        label: b.label,
        frequencyHz: b.frequencyHz,
        gainDb: eqGains[b.gainKey] || 0,
      })),
      eqRange: { minDb: SETTINGS.eq.minDb, maxDb: SETTINGS.eq.maxDb, stepDb: SETTINGS.eq.stepDb },
      // Volume range comes from SETTINGS so the popup slider is sized from one place.
      minPercent: SETTINGS.volume.minPercent,
      maxPercent: SETTINGS.volume.maxPercent,
      defaultPercent: SETTINGS.volume.defaultPercent,
      hasMedia: counts.total > 0,
      engaged,
      contextState,
      softClipEnabled: clipEnabled,
      softClipAuto: SETTINGS.softClip.auto,
      compressorEnabled: compressorEnabled,
      // The popup shows a hint when boost is engaged but the context isn't running yet
      // (user needs to click the page), or when some media can't be boosted (cross-origin).
      pending: engaged && contextState !== "running" && counts.routable > 0,
      blockedMedia: counts.blocked,
      // "tricky" = a known streaming host whose DRM audio we PROBABLY can't route (see
      // TRICKY_HOSTS); the popup turns this into a soft "MAY not work" warning.
      tricky: isTrickyHost(),
      // "drmBlocked" = PROVEN un-boostable: the DRM detector saw this tab attach an EME
      // content key to a media element (see SETTINGS.drm). The popup turns this into the
      // definitive "can't be boosted" warning with the reasons behind an info icon.
      drmBlocked,
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
      case "set-eq": // { type: "set-eq", eq: { bassGainDb?, voiceBoostGainDb? } } — fader drag
        setEq(message.eq);
        return Promise.resolve(getState());
      case "set-softclip": // { type: "set-softclip", enabled: true|false }
        setSoftClipEnabled(message.enabled);
        return Promise.resolve(getState());
      case "set-compressor": // { type: "set-compressor", enabled: true|false }
        setCompressorEnabled(message.enabled);
        return Promise.resolve(getState());
      default:
        return undefined;
    }
  });

  // Console test hook, from the content script's devtools context:
  //   __tabVolumeBooster.setSoftClip(false)    // hear the raw, clippable boost
  //   __tabVolumeBooster.setSoftClip(true)     // smooth, protected again
  //   __tabVolumeBooster.setCompressor(false)  // hear the raw, unlevelled dynamics
  //   __tabVolumeBooster.setCompressor(true)   // even out loud/quiet swings (spiky lectures)
  // Boost the slider first (the tails only run while engaged), then flip live to A/B.
  window.__tabVolumeBooster = {
    setSoftClip: setSoftClipEnabled,
    isSoftClipEnabled: () => clipEnabled,
    setCompressor: setCompressorEnabled,
    isCompressorEnabled: () => compressorEnabled,
    // Watch the adaptive threshold while tuning SETTINGS.compressor.marginDb: this reports the
    // running-average level it's tracking and where the threshold currently sits (average + margin).
    compressorLevels: () => ({
      runningAverageDb,
      thresholdDb: compressor ? compressor.threshold.value : null,
      gainReductionDb: compressor ? compressor.reduction : null,
      crestFactorDb: runningPeakDb !== null && runningRmsDb !== null ? runningPeakDb - runningRmsDb : null,
      autoSoftClipActive: clipEnabled,
    }),
  };

  // Restore this tab's last volume/preset (survives a refresh, which keeps the tab id).
  // We run uniformly in EVERY frame — building a graph is cheap and silent (nothing routes
  // until the context runs AND the frame has media, see wireAll), so an empty ad frame just
  // holds an idle graph and every frame with media boosts together.
  function applySaved(saved) {
    // Prefer the exact EQ gains (covers hand-tuned "custom" tones); fall back to the
    // named preset for states saved before the faders existed. Either engages the graph.
    if (saved.eq) setEq(saved.eq);
    else if (saved.preset) applyPreset(saved.preset);
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

  // Listen for the MAIN-world DRM detector (drm-detector.js). Its message is the single
  // 100%-proof signal that this tab's audio is DRM-locked and can never be routed through
  // our graph; getState() forwards it so the popup shows the definitive warning. We only
  // ever latch it true — a tab that once set up DRM stays flagged.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return; // same-window messages only
    const data = event.data;
    if (!data || data.source !== SETTINGS.drm.detectedMessageTag) return;
    drmBlocked = true;
  });
  // The detector runs at document_start; we start listening at document_idle, so a page that
  // locked its audio before now would have shouted to no one. Ask it to replay any detection.
  try {
    window.postMessage({ source: SETTINGS.drm.queryMessageTag }, "*");
  } catch (err) {
    /* postMessage unavailable during teardown — best effort */
  }

  restoreState();
})();
