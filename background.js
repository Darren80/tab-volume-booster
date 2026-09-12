// Tab Volume Booster - background (event page).
// Two small jobs, both keyed to a TAB:
//
//   1. The toolbar badge — the number under the icon showing the tab's volume
//      when it's boosted or cut.
//   2. Per-tab memory — so a tab keeps its volume/preset across a refresh.
//
// Both live here because both need the tab id, which a content script can't see
// for itself. Each content script REPORTS its volume+preset to us; we badge its
// tab and stash the values under that tab's id. When the script loads again
// (fresh tab, or after a refresh — a refresh keeps the SAME tab id) it asks us
// to RESTORE, and we hand back whatever that tab last had.
//
// NOTE on the badge: Firefox draws the badge text in its own fixed system font,
// so we can't make it bold or bigger — only set its colours. We tried painting a
// custom icon with the number baked in (full control of weight/size), but at the
// 16 px the toolbar actually renders, the number came out too small to read. The
// badge's number is larger, so we use the badge and just give it strong colours.
//
// Storage is storage.session: it lives in memory for the browser session and is
// wiped when the browser closes. That's exactly per-tab semantics — tab ids are
// only meaningful within a session, so a value can never leak onto a reused id
// after a restart.

const api = typeof browser !== "undefined" ? browser : chrome;

// Badge look. Violet to match the popup's accent, white text for contrast.
const BADGE_BG = "#6d5cff";
const BADGE_TEXT_COLOR = "#ffffff";
const DEFAULT_PERCENT = 100; // at exactly this we show NO badge (clean icon)

const keyFor = (tabId) => `tab-${tabId}`;

function setBadge(tabId, percent) {
  if (tabId == null) return;
  // Only label a tab that's actually been pushed off normal volume.
  const text = percent === DEFAULT_PERCENT ? "" : String(percent);
  // Wrap each call: a tab can vanish (closed/navigated) between the report and
  // here, which rejects the promise — harmless, so swallow it.
  api.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) {
    api.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG }).catch(() => {});
    // setBadgeTextColor is Firefox/Chrome-recent; ignore if unavailable.
    api.action.setBadgeTextColor?.({ tabId, color: BADGE_TEXT_COLOR }).catch(() => {});
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message?.type === "vol-state") {
    // A tab's volume/preset changed: reflect it on the badge and remember it.
    setBadge(tabId, message.volume);
    if (tabId != null) {
      api.storage.session
        .set({ [keyFor(tabId)]: { volume: message.volume, preset: message.preset } })
        .catch(() => {});
    }
    return; // no reply needed
  }

  if (message?.type === "vol-restore") {
    // A tab just (re)loaded and wants whatever it had before, if anything.
    if (tabId == null) return Promise.resolve(null);
    return api.storage.session
      .get(keyFor(tabId))
      .then((stored) => stored?.[keyFor(tabId)] ?? null)
      .catch(() => null);
  }

  return undefined;
});

// Tidy up a tab's saved state when it closes (session storage would clear it on
// browser exit anyway; this just keeps it from lingering during the session).
api.tabs.onRemoved.addListener((tabId) => {
  api.storage.session.remove(keyFor(tabId)).catch(() => {});
});
