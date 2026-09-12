// Tab Volume Booster - background (event page).
// Two small jobs, both keyed to a TAB:
//
//   1. The toolbar badge — the small number in the corner of the icon showing the
//      tab's volume when it's boosted.
//   2. Per-tab memory — so a tab keeps its volume/preset across a refresh.
//
// Both live here because both need the tab id, which a content script can't see
// for itself. Each content script REPORTS its volume+preset to us; we badge its
// tab and stash the values under that tab's id. When the script loads again
// (fresh tab, or after a refresh — a refresh keeps the SAME tab id) it asks us
// to RESTORE, and we hand back whatever that tab last had.
//
// The indicator is Firefox's plain, built-in badge: setBadgeText draws the number
// in the corner of the toolbar icon. It's not pretty and Firefox controls its
// font/size, but it's reliable and never touches the icon artwork itself. (An
// earlier version PAINTED the number as the whole icon; that's been removed.) At
// exactly 100% (normal volume) we clear the badge so the tab looks untouched.
//
// Storage is storage.session: it lives in memory for the browser session and is
// wiped when the browser closes. That's exactly per-tab semantics — tab ids are
// only meaningful within a session, so a value can never leak onto a reused id
// after a restart.

const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_PERCENT = 100; // at exactly this we clear the badge (normal volume)
const BADGE_BG = "#16a34a"; // green tile behind the number, to match the icon's waves
const BADGE_FG = "#ffffff"; // white number for contrast

const keyFor = (tabId) => `tab-${tabId}`;

function setIndicator(tabId, percent) {
  if (tabId == null) return;
  // Boosted → show the number; normal volume → clear the badge. Each call is
  // wrapped: a tab can vanish (closed/navigated) between the report and here,
  // which rejects the promise — harmless, so swallow it.
  const text = percent === DEFAULT_PERCENT ? "" : String(percent);
  api.action.setBadgeText({ tabId, text }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG }).catch(() => {});
  // setBadgeTextColor isn't in every build; ignore if unavailable.
  api.action.setBadgeTextColor?.({ tabId, color: BADGE_FG }).catch(() => {});
}

api.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message?.type === "vol-state") {
    // A tab's volume/preset changed: reflect it on the icon and remember it.
    setIndicator(tabId, message.volume);
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
