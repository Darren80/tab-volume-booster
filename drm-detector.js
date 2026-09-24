// Tab Volume Booster - DRM detector (MAIN world, document_start).
// Wraps HTMLMediaElement.setMediaKeys: a non-null key means that element's audio is
// DRM-encrypted and unreachable by Web Audio. We tell content.js, which shows the
// definitive "can't be boosted" warning. This also catches players like Spotify's that
// never attach their media element to the DOM. Capability probes are deliberately ignored.

(() => {
  // ========================================================================
  //  SETTINGS — the only place with tunable strings for this file.
  // ========================================================================
  const DRM_DETECTOR_SETTINGS = {
    // MUST match SETTINGS.drm in content.js (separate JS worlds, so literals are the protocol).
    detectedMessageTag: "crescendo-drm-detected", // detector -> content: "this tab is DRM-locked"
    queryMessageTag: "crescendo-drm-query", // content -> detector: "did you already detect it?"
  };
  // ========================================================================

  let drmDetected = false; // latched true the first time the page attaches a DRM key

  // Tell the isolated content script this tab's audio is DRM-protected.
  function announceDrmDetected() {
    try {
      window.postMessage({ source: DRM_DETECTOR_SETTINGS.detectedMessageTag }, "*");
    } catch (error) {
      /* postMessage can throw in rare teardown states — best effort */
    }
  }

  // setMediaKeys(null) detaches DRM, so only non-null keys count.
  const mediaElementPrototype =
    window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  if (mediaElementPrototype && typeof mediaElementPrototype.setMediaKeys === "function") {
    const originalSetMediaKeys = mediaElementPrototype.setMediaKeys;
    mediaElementPrototype.setMediaKeys = function (mediaKeys) {
      if (mediaKeys && !drmDetected) {
        drmDetected = true;
        announceDrmDetected();
      }
      return originalSetMediaKeys.apply(this, arguments);
    };
  }

  // content.js loads later and asks us to replay anything it missed.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== DRM_DETECTOR_SETTINGS.queryMessageTag) return;
    if (drmDetected) announceDrmDetected();
  });
})();
