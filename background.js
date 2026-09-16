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
// FRAMES: the content script runs in every frame (all_frames), so a single tab
// can report from several frames at once — e.g. the top page AND an embedded
// player in a cross-origin <iframe>. Reports carry sender.frameId, so we track
// each frame's volume separately and badge the tab with the STRONGEST boost
// across its frames (otherwise a top frame sitting at 100% would keep clearing
// the badge a boosted iframe just set).
//
// The indicator is Firefox's plain, built-in badge: setBadgeText draws the number
// in the corner of the toolbar icon. It's not pretty and Firefox controls its
// font/size, but it's reliable and never touches the icon artwork itself. At
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
const DEFAULT_TITLE = "Crescendo — Tab Volume Booster"; // hover label at normal volume
const PERCENT_TITLE = "Crescendo — "; // hover label when boosted

// Per-preset toolbar icon. The Voice and Bass presets swap the plain speaker for
// one carrying a gradient "VB"/"BB" badge, so the active preset shows on the tab's
// icon (independently of the volume badge). "default" (Flat) keeps the plain icon.
const DEFAULT_ICON = "icons/icon.svg";
const PRESET_ICONS = {
  voice: "icons/icon-voice.svg",
  bass: "icons/icon-bass.svg",
};
const iconFor = (preset) => PRESET_ICONS[preset] || DEFAULT_ICON;

const keyFor = (tabId) => `tab-${tabId}`;

// Per-tab, per-frame last-reported state, so the badge can show the tab's strongest
// boost and the icon can reflect the active preset. tabId -> Map(frameId ->
// { percent, preset }). In-memory only: it's purely cosmetic, and frames re-report
// as they load, so losing it (event-page unload) self-heals. It's reset when the
// top frame navigates (see webNavigation below).
const tabFrames = new Map();

// Firefox's badge only fits ~3–4 (narrow) characters. Up to three digits the raw
// percentage fits fine ("360"), so show it as-is. Only four-digit percentages
// (1000%+) overflow and clip ("1200" → "120"), so for those we fall back to a
// compact MULTIPLIER — "10x", "12x" — which stays within the badge's width.
function badgeText(percent) {
  if (percent === DEFAULT_PERCENT) return ""; // normal volume → no badge
  if (percent < 1000) return String(percent); // ≤3 digits: fits as a percentage
  const mult = percent / 100; // 4-digit percentage → compact multiplier instead
  return (Number.isInteger(mult) ? String(mult) : mult.toFixed(1)) + "x";
}

// The icon's hover label. At normal volume it's just the plain name; when a tab
// is boosted we append its strongest boost so the percentage shows on mouse-over.
function titleText(percent) {
  if (percent === DEFAULT_PERCENT) return DEFAULT_TITLE;
  return `${PERCENT_TITLE}${percent}% boost`;
}

// Paint the badge + icon for a tab from its frames. The badge shows the strongest
// boost; the icon reflects the active preset (any non-default preset a frame
// reports — the popup sets the preset tab-wide, so frames agree). Each call is
// wrapped: a tab can vanish (closed/navigated) between a report and here, which
// rejects the promise — harmless, so swallow it.
function refreshBadge(tabId) {
  if (tabId == null) return;
  const frames = tabFrames.get(tabId);
  let peak = DEFAULT_PERCENT;
  let preset = "default";
  if (frames)
    for (const state of frames.values()) {
      if (state.percent > peak) peak = state.percent;
      if (state.preset && state.preset !== "default") preset = state.preset;
    }
  api.action.setBadgeText({ tabId, text: badgeText(peak) }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG }).catch(() => {});
  // setBadgeTextColor isn't in every build; ignore if unavailable.
  api.action.setBadgeTextColor?.({ tabId, color: BADGE_FG }).catch(() => {});
  api.action.setTitle({ tabId, title: titleText(peak) }).catch(() => {});
  api.action.setIcon({ tabId, path: iconFor(preset) }).catch(() => {});
}

function recordFrameState(tabId, frameId, percent, preset) {
  if (tabId == null) return;
  let frames = tabFrames.get(tabId);
  if (!frames) {
    frames = new Map();
    tabFrames.set(tabId, frames);
  }
  frames.set(frameId ?? 0, { percent, preset });
  refreshBadge(tabId);
}

api.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message?.type === "vol-state") {
    // A frame's volume/preset changed: fold it into the tab's badge and remember
    // it. (Storage is per-tab; when several frames are boosted the last write
    // wins, which is fine — restore just needs a boost to re-apply on reload.)
    recordFrameState(tabId, sender.frameId, message.volume, message.preset);
    if (tabId != null) {
      api.storage.session
        .set({ [keyFor(tabId)]: { volume: message.volume, preset: message.preset } })
        .catch(() => {});
    }
    return; // no reply needed
  }

  if (message?.type === "vol-restore") {
    // A frame just (re)loaded and wants whatever this tab had before, if anything.
    if (tabId == null) return Promise.resolve(null);
    return api.storage.session
      .get(keyFor(tabId))
      .then((stored) => stored?.[keyFor(tabId)] ?? null)
      .catch(() => null);
  }

  return undefined;
});

// A top-level navigation (including a refresh) starts the tab's frames over, so
// drop the stale per-frame volumes and clear the badge. The reloaded frames then
// re-report (restoring from storage), repainting the badge from scratch.
api.webNavigation?.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // only the main frame resets the whole tab
  tabFrames.delete(details.tabId);
  api.action.setBadgeText({ tabId: details.tabId, text: "" }).catch(() => {});
  api.action.setTitle({ tabId: details.tabId, title: DEFAULT_TITLE }).catch(() => {});
  api.action.setIcon({ tabId: details.tabId, path: DEFAULT_ICON }).catch(() => {});
});

// Tidy up a tab's saved state when it closes (session storage would clear it on
// browser exit anyway; this just keeps it from lingering during the session).
api.tabs.onRemoved.addListener((tabId) => {
  tabFrames.delete(tabId);
  api.storage.session.remove(keyFor(tabId)).catch(() => {});
});
