// Tab Volume Booster - content script
// Routes each <video>/<audio> element through a Web Audio graph:
//   source -> bassFilter (lowshelf) -> voiceFilter (peaking) -> masterGain -> destination
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

  let audioContext = null;
  let masterGain = null;
  let bassFilter = null;
  let voiceFilter = null;
  let observer = null;
  let gesturesHooked = false;

  const wired = new WeakSet(); // elements routed through the graph
  const skipped = new WeakSet(); // elements we deliberately left native (cross-origin)

  let currentVolume = 1.0; // gain multiplier: 1.0 == 100%
  let currentPreset = "default";
  let engaged = false; // the user has asked us to take over

  // --- Graph -------------------------------------------------------------

  function buildGraph() {
    if (audioContext) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    bassFilter = audioContext.createBiquadFilter();
    bassFilter.type = "lowshelf";
    bassFilter.frequency.value = 200;
    bassFilter.gain.value = 0;

    voiceFilter = audioContext.createBiquadFilter();
    voiceFilter.type = "peaking";
    voiceFilter.frequency.value = 2500;
    voiceFilter.Q.value = 1;
    voiceFilter.gain.value = 0;

    masterGain = audioContext.createGain();
    masterGain.gain.value = currentVolume;

    bassFilter.connect(voiceFilter);
    voiceFilter.connect(masterGain);
    masterGain.connect(audioContext.destination);

    applyPresetNodes();

    // When the context becomes runnable (after a page gesture), take over.
    audioContext.addEventListener("statechange", () => {
      if (audioContext.state === "running") wireAll();
    });
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
    if (currentPreset === "bass") {
      bassFilter.gain.value = 12;
      voiceFilter.gain.value = 0;
    } else if (currentPreset === "voice") {
      bassFilter.gain.value = -3;
      voiceFilter.gain.value = 8;
    } else {
      bassFilter.gain.value = 0;
      voiceFilter.gain.value = 0;
    }
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
    currentVolume = Math.max(0, percent) / 100;
    engage();
    if (masterGain) masterGain.gain.value = currentVolume;
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
      hasMedia: counts.total > 0,
      engaged,
      contextState,
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
      default:
        return undefined;
    }
  });
})();
