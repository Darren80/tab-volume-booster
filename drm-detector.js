// Tab Volume Booster - DRM detector (MAIN world, document_start).
//
// This is the ONLY 100%-certain signal that a tab's audio can't be boosted. It runs
// in the PAGE's own JavaScript world (manifest `world: "MAIN"`, supported in Firefox
// 128+) BEFORE the page's scripts, and wraps the two Encrypted Media Extensions (EME)
// calls a page must make to play DRM-protected media:
//
//   • HTMLMediaElement.setMediaKeys(keys)  — attaches a Widevine/PlayReady content key
//     to a media element. Non-null keys == that element's audio is now encrypted and
//     decoded through a protected path the Web Audio API can never read.
//
// The instant the page does this, we postMessage the isolated content script (content.js),
// which flips getState().drmBlocked so the popup can show the definitive "can't be boosted"
// warning. We deliberately do NOT report on capability probes (e.g. a bare
// requestMediaKeySystemAccess), because probing for a CDM is not proof that the audio
// playing right now is encrypted — and the warning must be 100% certain, never a guess.
//
// Why this is needed at all: services like Spotify create the audio element with
// `new Audio()`/`<video>` and NEVER attach it to the DOM, so content.js's DOM scan can't
// see it. Hooking the EME call is the only way to know, for certain, that it's protected.

(() => {
  // ========================================================================
  //  SETTINGS — the only place with tunable strings for this file.
  // ========================================================================
  const DRM_DETECTOR_SETTINGS = {
    // The postMessage "source" tags that form the tiny protocol between this MAIN-world
    // detector and the isolated content script. These two strings MUST stay identical to
    // SETTINGS.drm.detectedMessageTag / SETTINGS.drm.queryMessageTag in content.js — the
    // two scripts run in separate JS worlds and can only agree by matching literals.
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

  // Wrap HTMLMediaElement.prototype.setMediaKeys so we learn the moment the page locks a
  // media element to a content key. We only latch on NON-null keys (setMediaKeys(null)
  // detaches DRM and is not a block).
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

  // The isolated content script loads later (document_idle). If the page attached its key
  // before content.js was listening, content.js asks us to replay on startup — answer it.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== DRM_DETECTOR_SETTINGS.queryMessageTag) return;
    if (drmDetected) announceDrmDetected();
  });
})();
