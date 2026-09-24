// Tab Volume Booster - content script
// Routes each <video>/<audio> element through a Web Audio graph:
//   source -> lowCutFilter -> bassFilter -> voiceBoostFilter -> [compressor -> makeupCompensation] -> tail -> destination
// The tail is the soft clipper (shaper) or masterGain (hard clip). Auto mode picks soft clip
// when the crest factor (peak − RMS) exceeds 14.4 dB. The compressor (leveller) is switched
// in/out by routeClip.

(() => {
  if (window.__tabVolumeBoosterInjected) return;
  window.__tabVolumeBoosterInjected = true;

  const api = typeof browser !== "undefined" ? browser : chrome;

  // ==========================================================================
  //  SETTINGS — every tunable number lives here.
  //  Edit a value, then reload the add-on in about:debugging to hear the change.
  // ==========================================================================
  const SETTINGS = {
    // Volume slider range, in percent. 100 = the tab's normal volume. The popup sizes its
    // slider from these, so this is the only place to change the range.
    volume: {
      minPercent: 100, // boost-only: never cuts below normal
      maxPercent: 1200,
      defaultPercent: 100,
      // Time constant for gain/EQ changes, so fader moves glide instead of clicking.
      gainSmoothingSeconds: 0.015,
    },

    // EQ bands. Band placement lives here; how hard each preset pushes them is in `presets`.
    // High-pass: removes sub-bass rumble but keeps the voice's body (a low-shelf cut would
    // leave a thin "telephone" voice). On only while an EQ band is lifted.
    lowCutBand: {
      type: "highpass",
      frequencyHz: 80,
      q: 0.707, // Butterworth: no resonant bump at the corner
    },
    bassBand: {
      type: "lowshelf",
      frequencyHz: 120,
    },
    // Voice boost: one broad bell, copied from Volume Master v1.14.x (peaking @ 1500 Hz, Q 1).
    voiceBoostBand: {
      type: "peaking",
      frequencyHz: 1500,
      q: 1.0,
    },

    // Band gains per preset, in dB (0 = flat, +6 dB ≈ twice as loud for that band).
    presets: {
      default: { bassGainDb: 0, voiceBoostGainDb: 0 },
      bass: { bassGainDb: 14, voiceBoostGainDb: 0 },
      voice: { bassGainDb: 0, voiceBoostGainDb: 12 },
    },

    // dB range of the popup's EQ faders (boost-only). Presets are points inside this range;
    // anything else reads as "custom".
    eq: {
      minDb: 0,
      maxDb: 18,
      stepDb: 1,
    },

    // Soft clipper: rounds off peaks pushed past full scale instead of chopping them square.
    // A WaveShaper clamps its input to ±1, so the boost is baked into the curve.
    softClip: {
      enabled: true,
      kneeStartDb: -1, // where the curve starts to bend (dB below ceiling)
      ceilingDb: 0,
      curveSamples: 8192,
      oversample: "2x",
      // Auto mode: soft clip only when the audio is spiky. Crest factor (peak − RMS) above
      // the threshold = spiky (lectures, sharp transients); below = smooth (mastered music),
      // which sounds punchier hard-clipped. 14.4 dB was the crossover across 10 test sources.
      auto: true,
      autoCrestFactorThresholdDb: 14.4,
      autoCrestFactorSmoothingSeconds: 2.0, // slower = won't flicker on a single loud syllable
    },

    // Leveller (adaptive limiter): tracks the running-average peak level and clamps anything
    // more than marginDb above it. The average rises fast (speech after a pause isn't flagged)
    // and falls slowly (pauses don't drag it down, screams can't chase it up).
    // Toggle live in the console: __tabVolumeBooster.setCompressor(true/false)
    compressor: {
      enabled: true,
      marginDb: 7, // how far above the average peak counts as a spike (▲ 12 lenient, ▼ 6 aggressive)
      ratio: 16, // how hard spikes are squashed (▲ 20 harder wall, ▼ 4 screams poke out)
      riseSeconds: 0.15, // ▲ 0.3 screams can't escape but slower after pauses, ▼ 0.05 screams escape
      fallSeconds: 3.0, // ▲ 5.0 holds longer through quiet sections, ▼ 1.5 adapts faster
      releaseSeconds: 0.25, // ▲ 0.5 can duck the word after a scream, ▼ 0.1 may pump
      kneeDb: 4, // ▲ 10 gradual (compressor-like), ▼ 2 sudden (limiter-like)
      attackSeconds: 0.003, // ▲ 0.01 lets a shout's first pop through, ▼ 0.001 risks distortion

      // Measurement plumbing — correct as-is.
      silenceGateDb: -40, // readings below this are silence and don't move the average
      updateIntervalMilliseconds: 50,
      levelMeterFftSize: 2048, // must be a power of two
      minimumThresholdDb: -60,
      maximumThresholdDb: 0, // the Web Audio node's upper limit; also the "clamp nothing" resting value
    },

    // DRM detection. These MUST match DRM_DETECTOR_SETTINGS in drm-detector.js.
    drm: {
      detectedMessageTag: "crescendo-drm-detected",
      queryMessageTag: "crescendo-drm-query",
    },
  };
  // ==========================================================================

  let audioContext = null;
  let masterGain = null;
  let lowCutFilter = null;
  let bassFilter = null;
  let voiceBoostFilter = null;
  let shaper = null; // soft-clip WaveShaper, boost baked into its curve
  let clipEnabled = SETTINGS.softClip.enabled;
  let compressor = null;
  let makeupCompensation = null; // GainNode cancelling the compressor's built-in makeup gain
  let compressorEnabled = SETTINGS.compressor.enabled;
  let levelMeter = null; // AnalyserNode tapping the compressor's input
  let levelMeterSamples = null;
  let runningAverageDb = null; // null = not measured yet
  let adaptiveThresholdTimerId = null;
  let runningPeakDb = null; // for the auto soft-clip crest factor
  let runningRmsDb = null;
  let eqNodes = {}; // gainKey -> BiquadFilter
  let gesturesHooked = false;
  let drmBlocked = false; // latched once the DRM detector reports an EME key

  const wired = new WeakSet(); // elements routed through the graph
  const skipped = new WeakSet(); // elements left native (CORS upgrade failed / untouchable)
  const upgrading = new WeakSet(); // elements mid CORS-upgrade
  const observedRoots = new WeakSet(); // document + open shadow roots being watched

  let currentVolume = SETTINGS.volume.defaultPercent / 100; // 1.0 == 100%
  // EQ gains (dB) are the source of truth for the tone; the preset name is derived from them.
  let eqGains = { ...SETTINGS.presets.default };
  let engaged = false;

  // The EQ bands the popup shows as faders, in display order. getState ships this list,
  // so the popup builds itself from it.
  const EQ_BANDS = [
    { gainKey: "bassGainDb", label: "Bass", frequencyHz: SETTINGS.bassBand.frequencyHz },
    { gainKey: "voiceBoostGainDb", label: "Voice", frequencyHz: SETTINGS.voiceBoostBand.frequencyHz },
  ];

  // The preset whose gains match exactly, else "custom".
  function presetNameFor(gains) {
    for (const [name, preset] of Object.entries(SETTINGS.presets)) {
      if (EQ_BANDS.every((b) => (preset[b.gainKey] || 0) === (gains[b.gainKey] || 0))) {
        return name;
      }
    }
    return "custom";
  }
  const currentPresetName = () => presetNameFor(eqGains);

  // Streaming hosts whose DRM audio we probably can't route; the popup shows a soft warning.
  // Not all EME (software Widevine often routes fine), so only these hosts.
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
    lowCutFilter.Q.value = SETTINGS.lowCutBand.q;

    bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = SETTINGS.bassBand.type;
    bassFilter.frequency.value = SETTINGS.bassBand.frequencyHz;
    bassFilter.gain.value = 0;

    voiceBoostFilter = audioContext.createBiquadFilter();
    voiceBoostFilter.type = SETTINGS.voiceBoostBand.type;
    voiceBoostFilter.frequency.value = SETTINGS.voiceBoostBand.frequencyHz;
    voiceBoostFilter.Q.value = SETTINGS.voiceBoostBand.q;
    voiceBoostFilter.gain.value = 0;

    compressor = audioContext.createDynamicsCompressor();
    compressor.knee.value = SETTINGS.compressor.kneeDb;
    compressor.ratio.value = SETTINGS.compressor.ratio;
    compressor.attack.value = SETTINGS.compressor.attackSeconds;
    compressor.release.value = SETTINGS.compressor.releaseSeconds;
    // Start at the top so nothing is clamped until the tracker has measured the audio.
    // (Starting at the floor squashed everything for the first few hundred ms: the dip.)
    compressor.threshold.value = SETTINGS.compressor.maximumThresholdDb;

    makeupCompensation = audioContext.createGain();
    makeupCompensation.gain.value = compressorMakeupCompensation(SETTINGS.compressor.maximumThresholdDb);
    compressor.connect(makeupCompensation);

    levelMeter = audioContext.createAnalyser();
    levelMeter.fftSize = SETTINGS.compressor.levelMeterFftSize;
    levelMeterSamples = new Float32Array(levelMeter.fftSize);
    voiceBoostFilter.connect(levelMeter);

    eqNodes = { bassGainDb: bassFilter, voiceBoostGainDb: voiceBoostFilter };

    // Two tails, both wired to the speakers; routeClip feeds exactly one.
    //  SOFT-CLIP : -> shaper -> destination      (boost baked into the curve)
    //  RAW/BASE  : -> masterGain -> destination  (transparent at 100%, raw clippable boost above)
    masterGain = audioContext.createGain();
    masterGain.gain.value = currentVolume;

    shaper = audioContext.createWaveShaper();
    shaper.oversample = SETTINGS.softClip.oversample;
    updateShaperCurve();

    lowCutFilter.connect(bassFilter);
    bassFilter.connect(voiceBoostFilter);
    masterGain.connect(audioContext.destination);
    shaper.connect(audioContext.destination);
    routeClip();
    routeLowCut();

    applyPresetNodes();

    // When the context becomes runnable (after a page gesture), take over.
    audioContext.addEventListener("statechange", () => {
      if (audioContext.state === "running") wireAll();
      syncAdaptiveThresholdTracker();
    });
  }

  const dbToLinear = (db) => Math.pow(10, db / 20);
  const linearToDb = (linear) => 20 * Math.log10(linear);

  // Glide an AudioParam to a new value instead of stepping it (a step clicks).
  function glideParameter(parameter, value) {
    parameter.setTargetAtTime(value, audioContext.currentTime, SETTINGS.volume.gainSmoothingSeconds);
  }

  // Constants of the browser's DynamicsCompressorNode curve (Firefox's
  // dom/media/webaudio/blink/DynamicsCompressorKernel.cpp). Not tunable — they must match
  // the browser for compressorMakeupGain to cancel its makeup gain exactly.
  const BROWSER_COMPRESSOR_CURVE = {
    slopeProbeFactor: 1.001,
    kneeSharpnessMinimum: 0.1,
    kneeSharpnessMaximum: 10000,
    kneeSharpnessInitial: 5,
    kneeSharpnessSearchIterations: 15,
    makeupGainExponent: 0.6,
  };

  // DynamicsCompressorNode applies automatic makeup gain that can't be turned off, and it
  // grows as the threshold drops (≈ +7 dB at a −13 dB threshold). Since the adaptive tracker
  // moves the threshold constantly, that gain would make the leveller boost and pump on its
  // own. This mirrors the browser's curve to compute the exact makeup gain for a threshold.
  function compressorMakeupGain(thresholdDb) {
    const { kneeDb, ratio } = SETTINGS.compressor;
    const linearThreshold = dbToLinear(thresholdDb);
    const kneeEndDb = thresholdDb + kneeDb;
    const kneeEnd = dbToLinear(kneeEndDb);
    const slope = 1 / ratio;

    const kneeCurve = (input, kneeSharpness) => {
      if (input < linearThreshold) return input;
      return linearThreshold + (1 - Math.exp(-kneeSharpness * (input - linearThreshold))) / kneeSharpness;
    };
    const slopeAt = (input, kneeSharpness) => {
      if (input < linearThreshold) return 1;
      const probedInput = input * BROWSER_COMPRESSOR_CURVE.slopeProbeFactor;
      const outputDbDelta =
        linearToDb(kneeCurve(probedInput, kneeSharpness)) - linearToDb(kneeCurve(input, kneeSharpness));
      return outputDbDelta / (linearToDb(probedInput) - linearToDb(input));
    };

    // Find the knee sharpness whose slope at the knee's end matches 1/ratio.
    let minimumSharpness = BROWSER_COMPRESSOR_CURVE.kneeSharpnessMinimum;
    let maximumSharpness = BROWSER_COMPRESSOR_CURVE.kneeSharpnessMaximum;
    let kneeSharpness = BROWSER_COMPRESSOR_CURVE.kneeSharpnessInitial;
    for (let iteration = 0; iteration < BROWSER_COMPRESSOR_CURVE.kneeSharpnessSearchIterations; iteration++) {
      if (slopeAt(kneeEnd, kneeSharpness) < slope) maximumSharpness = kneeSharpness;
      else minimumSharpness = kneeSharpness;
      kneeSharpness = Math.sqrt(minimumSharpness * maximumSharpness);
    }

    // The curve's output for a full-scale input.
    let fullRangeGain;
    if (1 < kneeEnd) {
      fullRangeGain = kneeCurve(1, kneeSharpness);
    } else {
      const kneeEndOutputDb = linearToDb(kneeCurve(kneeEnd, kneeSharpness));
      fullRangeGain = dbToLinear(kneeEndOutputDb + slope * (0 - kneeEndDb));
    }
    return Math.pow(1 / fullRangeGain, BROWSER_COMPRESSOR_CURVE.makeupGainExponent);
  }

  function compressorMakeupCompensation(thresholdDb) {
    return 1 / compressorMakeupGain(thresholdDb);
  }

  // |u| <= knee passes through; above it, eases toward `ceiling` without crossing it.
  function softClipSample(u, knee, ceiling) {
    const mag = Math.abs(u);
    if (mag <= knee) return u;
    const sign = u < 0 ? -1 : 1;
    return sign * (knee + (ceiling - knee) * Math.tanh((mag - knee) / (ceiling - knee)));
  }

  // curve[x] = softClip(volume * x). Rebuilt on every volume change.
  function updateShaperCurve() {
    if (!shaper) return;
    const n = SETTINGS.softClip.curveSamples;
    const knee = dbToLinear(SETTINGS.softClip.kneeStartDb);
    const ceiling = dbToLinear(SETTINGS.softClip.ceilingDb);
    const drive = currentVolume;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1; // table index -> input sample in [-1, 1]
      curve[i] = softClipSample(drive * x, knee, ceiling);
    }
    shaper.curve = curve;
  }

  function eqEngaged() {
    return EQ_BANDS.some((b) => (eqGains[b.gainKey] || 0) !== 0);
  }

  // "The user has asked us to alter the sound": a boost past 100% or any EQ band lifted.
  // When false, the chain is a bit-for-bit passthrough.
  function processingEngaged() {
    return currentVolume > 1 || eqEngaged();
  }

  // Baseline uses masterGain at 1.0 (transparent); when engaged, the shaper if soft clip is on.
  function activeTail() {
    if (!processingEngaged()) return masterGain;
    if (clipEnabled) return shaper;
    return masterGain;
  }

  function compressorActive() {
    return compressorEnabled && processingEngaged();
  }

  // Point the last EQ node at the active tail, through the leveller when it's active.
  function routeClip() {
    if (!voiceBoostFilter || !masterGain || !shaper || !compressor || !makeupCompensation || !levelMeter) return;
    try {
      voiceBoostFilter.disconnect(); // also drops the levelMeter tap
    } catch (err) {
      /* nothing connected yet */
    }
    try {
      makeupCompensation.disconnect();
    } catch (err) {
      /* nothing connected yet */
    }
    voiceBoostFilter.connect(levelMeter);
    const tail = activeTail();
    if (compressorActive()) {
      voiceBoostFilter.connect(compressor);
      makeupCompensation.connect(tail);
    } else {
      voiceBoostFilter.connect(tail);
    }
    syncAdaptiveThresholdTracker();
  }

  // The high-pass is part of the EQ, so it's only on while a band is lifted. At other times
  // it becomes a 0 dB peaking filter, an exact identity. A plain volume boost leaves the bass alone.
  function routeLowCut() {
    if (!lowCutFilter) return;
    if (eqEngaged()) {
      lowCutFilter.type = SETTINGS.lowCutBand.type;
      lowCutFilter.frequency.value = SETTINGS.lowCutBand.frequencyHz;
      lowCutFilter.Q.value = SETTINGS.lowCutBand.q;
    } else {
      lowCutFilter.type = "peaking";
      lowCutFilter.gain.value = 0;
    }
  }

  // An explicit toggle turns auto mode off so the user's choice sticks.
  function setSoftClipEnabled(on) {
    SETTINGS.softClip.auto = false;
    clipEnabled = !!on;
    routeClip();
    return clipEnabled;
  }

  function setCompressorEnabled(on) {
    compressorEnabled = !!on;
    routeClip();
    return compressorEnabled;
  }

  const ADAPTIVE_RISE_ALPHA = 1 - Math.exp(
    -(SETTINGS.compressor.updateIntervalMilliseconds / 1000) / SETTINGS.compressor.riseSeconds
  );
  const ADAPTIVE_FALL_ALPHA = 1 - Math.exp(
    -(SETTINGS.compressor.updateIntervalMilliseconds / 1000) / SETTINGS.compressor.fallSeconds
  );
  const CREST_FACTOR_ALPHA = 1 - Math.exp(
    -(SETTINGS.compressor.updateIntervalMilliseconds / 1000) / SETTINGS.softClip.autoCrestFactorSmoothingSeconds
  );

  // Peak and RMS of the compressor's input in dBFS, or null when silent.
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

  // One tracker tick: fold the latest reading into the running averages, aim the compressor
  // threshold at (average peak + marginDb), and let auto soft-clip pick the tail.
  function updateAdaptiveThreshold() {
    if (!audioContext) return;
    const measurement = measureLevel();
    if (measurement === null) return;
    const { peakDb, rmsDb } = measurement;
    if (peakDb < SETTINGS.compressor.silenceGateDb) return; // hold the averages through pauses

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
      // Glide the threshold and its makeup compensation together so loudness stays put.
      const glideSeconds = SETTINGS.compressor.updateIntervalMilliseconds / 1000;
      compressor.threshold.setTargetAtTime(targetThresholdDb, audioContext.currentTime, glideSeconds);
      makeupCompensation.gain.setTargetAtTime(
        compressorMakeupCompensation(targetThresholdDb),
        audioContext.currentTime,
        glideSeconds
      );
    }

    if (SETTINGS.softClip.auto) {
      if (runningPeakDb === null || runningRmsDb === null) {
        runningPeakDb = peakDb;
        runningRmsDb = rmsDb;
      } else {
        runningPeakDb += CREST_FACTOR_ALPHA * (peakDb - runningPeakDb);
        runningRmsDb += CREST_FACTOR_ALPHA * (rmsDb - runningRmsDb);
      }
      const crestFactorDb = runningPeakDb - runningRmsDb;
      const shouldSoftClip = crestFactorDb >= SETTINGS.softClip.autoCrestFactorThresholdDb;
      if (shouldSoftClip !== clipEnabled) {
        clipEnabled = shouldSoftClip;
        routeClip();
      }
    }
  }

  // Run the tracker only while the leveller or auto soft-clip needs it and audio is flowing.
  // When it stops, the compressor goes back to clamping nothing.
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
      if (compressor && makeupCompensation) {
        const now = audioContext.currentTime;
        compressor.threshold.cancelScheduledValues(now);
        compressor.threshold.setValueAtTime(SETTINGS.compressor.maximumThresholdDb, now);
        makeupCompensation.gain.cancelScheduledValues(now);
        makeupCompensation.gain.setValueAtTime(
          compressorMakeupCompensation(SETTINGS.compressor.maximumThresholdDb),
          now
        );
      }
    }
  }

  // blob:/data:/MSE and same-origin media are never tainted; an empty src counts too.
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

  // Can this element be tapped as-is without Web Audio silencing it?
  function isRoutable(element) {
    const src = element.currentSrc || element.src || "";
    if (isSameOriginish(src)) return true;
    return element.crossOrigin === "anonymous" || element.crossOrigin === "use-credentials";
  }

  // A tap can't be undone, and tapping a tainted element silences it permanently, so only
  // call this for elements whose audio is exposable. The element's own volume is left alone:
  // it still applies inside the graph, so the page's volume setting multiplies with the boost.
  function tapElement(element) {
    if (wired.has(element)) return;
    try {
      const source = audioContext.createMediaElementSource(element);
      source.connect(lowCutFilter);
      wired.add(element);
    } catch (err) {
      skipped.add(element);
    }
  }

  // Make a cross-origin element tappable by reloading it with CORS. If the server allows it
  // we tap on `loadeddata`; if not, roll the attribute back so it keeps playing natively.
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
      tapElement(element);
    };
    const onFail = () => {
      cleanup();
      upgrading.delete(element);
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
    // With no src loaded yet, skip the reload and let the listeners fire once the page sets one.
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
    // Routing is itself audible, so the baseline stays native until the user asks for something.
    if (!processingEngaged()) return;

    const src = element.currentSrc || element.src || "";
    if (src && isRoutable(element)) {
      tapElement(element);
      return;
    }
    corsUpgrade(element);
  }

  // Walk `node` and its subtree, crossing into open shadow roots (e.g. BBC's player mounts
  // its <video> in one). onMedia fires per <video>/<audio>; onRoot per document/shadow root.
  function walk(node, onMedia, onRoot) {
    if (node instanceof Element) {
      if (node.tagName === "VIDEO" || node.tagName === "AUDIO") onMedia?.(node);
      if (node.shadowRoot) walk(node.shadowRoot, onMedia, onRoot);
    } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE || node.nodeType === Node.DOCUMENT_NODE) {
      onRoot?.(node);
    }
    const kids = node.children;
    if (kids) for (const child of kids) walk(child, onMedia, onRoot);
  }

  // A MutationObserver can't see across a shadow boundary, so each root gets its own.
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

  function wireAll() {
    if (!audioContext || audioContext.state !== "running") return;
    if (!processingEngaged()) return;
    walk(document, wireElement, observeRoot);
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
    document.addEventListener("play", resume, { capture: true, passive: true });
  }

  function applyPresetNodes() {
    for (const band of EQ_BANDS) {
      const node = eqNodes[band.gainKey];
      if (node) glideParameter(node.gain, eqGains[band.gainKey] || 0);
    }
  }

  const clampEqDb = (db) =>
    Math.min(SETTINGS.eq.maxDb, Math.max(SETTINGS.eq.minDb, Number(db) || 0));

  // Build the graph and take over if we can. A tab never boosted builds nothing, so it stays native.
  function engage() {
    if (!processingEngaged() && !audioContext) return;
    buildGraph();
    hookGestures();
    audioContext.resume().catch(() => {});
    engaged = true;
    if (audioContext.state === "running") wireAll();
  }

  // Tell the background page our state, for the badge and to restore it after a refresh.
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
      /* messaging unavailable (e.g. during teardown) */
    }
  }

  function setVolume(percent) {
    const clamped = Math.min(
      SETTINGS.volume.maxPercent,
      Math.max(SETTINGS.volume.minPercent, percent)
    );
    currentVolume = clamped / 100;
    reportState();
    engage();
    if (masterGain) glideParameter(masterGain.gain, currentVolume);
    updateShaperCurve();
    routeClip();
    routeLowCut();
  }

  function applyPreset(name) {
    const preset = SETTINGS.presets[name] || SETTINGS.presets.default;
    eqGains = { ...preset };
    applyEq();
  }

  // Merge the given band gains into the current ones, so moving one fader keeps the other.
  function setEq(gains) {
    if (!gains) return;
    for (const band of EQ_BANDS) {
      if (band.gainKey in gains) eqGains[band.gainKey] = clampEqDb(gains[band.gainKey]);
    }
    applyEq();
  }

  function applyEq() {
    engage();
    applyPresetNodes();
    routeLowCut();
    routeClip();
    reportState();
  }

  // --- State for the popup ----------------------------------------------

  function countMedia() {
    const media = [];
    walk(document, (element) => media.push(element));
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
      eqBands: EQ_BANDS.map((b) => ({
        gainKey: b.gainKey,
        label: b.label,
        frequencyHz: b.frequencyHz,
        gainDb: eqGains[b.gainKey] || 0,
      })),
      eqRange: { minDb: SETTINGS.eq.minDb, maxDb: SETTINGS.eq.maxDb, stepDb: SETTINGS.eq.stepDb },
      minPercent: SETTINGS.volume.minPercent,
      maxPercent: SETTINGS.volume.maxPercent,
      defaultPercent: SETTINGS.volume.defaultPercent,
      hasMedia: counts.total > 0,
      engaged,
      contextState,
      softClipEnabled: clipEnabled,
      softClipAuto: SETTINGS.softClip.auto,
      compressorEnabled: compressorEnabled,
      // Engaged but the context isn't running yet: the user needs to click the page.
      pending: engaged && contextState !== "running" && counts.routable > 0,
      blockedMedia: counts.blocked,
      tricky: isTrickyHost(), // probably DRM (host guess)
      drmBlocked, // definitely DRM (detector saw an EME key)
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
      case "set-eq":
        setEq(message.eq);
        return Promise.resolve(getState());
      case "set-softclip":
        setSoftClipEnabled(message.enabled);
        return Promise.resolve(getState());
      case "set-compressor":
        setCompressorEnabled(message.enabled);
        return Promise.resolve(getState());
      default:
        return undefined;
    }
  });

  // Console hooks for A/B testing (boost the slider first; the tails only run while engaged).
  window.__tabVolumeBooster = {
    setSoftClip: setSoftClipEnabled,
    isSoftClipEnabled: () => clipEnabled,
    setCompressor: setCompressorEnabled,
    isCompressorEnabled: () => compressorEnabled,
    compressorLevels: () => ({
      runningAverageDb,
      thresholdDb: compressor ? compressor.threshold.value : null,
      gainReductionDb: compressor ? compressor.reduction : null,
      makeupCompensationDb: makeupCompensation ? linearToDb(makeupCompensation.gain.value) : null,
      crestFactorDb: runningPeakDb !== null && runningRmsDb !== null ? runningPeakDb - runningRmsDb : null,
      autoSoftClipActive: clipEnabled,
    }),
  };

  // Restore this tab's last volume/preset (a refresh keeps the tab id).
  function applySaved(saved) {
    if (saved.eq) setEq(saved.eq);
    else if (saved.preset) applyPreset(saved.preset); // states saved before the faders existed
    setVolume(saved.volume);
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
          applySaved(saved);
        } else {
          reportState();
        }
      })
      .catch(() => reportState());
  }

  // Latch the MAIN-world DRM detector's report (see drm-detector.js).
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SETTINGS.drm.detectedMessageTag) return;
    drmBlocked = true;
  });
  // The detector runs earlier than us, so ask it to replay anything it already saw.
  try {
    window.postMessage({ source: SETTINGS.drm.queryMessageTag }, "*");
  } catch (err) {
    /* best effort */
  }

  restoreState();
})();
