// Tab Volume Booster - background (event page).
// Keyed by tab id (which content scripts can't see): paints the toolbar badge/icon and
// remembers each tab's volume/preset across a refresh in storage.session.
// Content scripts run in every frame, so the badge shows the strongest boost across frames.

const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_PERCENT = 100; // at exactly this we clear the badge (normal volume)
const BADGE_BG = "#16a34a"; // green tile behind the number, to match the icon's waves
const BADGE_FG = "#ffffff"; // white number for contrast
const DEFAULT_TITLE = "Crescendo — Tab Volume Booster"; // hover label at normal volume
const PERCENT_TITLE = "Crescendo — "; // hover label when boosted

// Toolbar icon per preset; Flat keeps the plain icon.
const DEFAULT_ICON = "icons/icon.svg";
const PRESET_ICONS = {
  voice: "icons/icon-voice.svg",
  bass: "icons/icon-bass.svg",
  custom: "icons/icon-custom.svg",
};
const iconFor = (preset) => PRESET_ICONS[preset] || DEFAULT_ICON;

const keyFor = (tabId) => `tab-${tabId}`;

// tabId -> Map(frameId -> { percent, preset }). In-memory only: frames re-report as they
// load, so losing it on event-page unload self-heals.
const tabFrames = new Map();

// The badge fits ~3 characters, so 1000%+ is shown as a multiplier ("12x").
function badgeText(percent) {
  if (percent === DEFAULT_PERCENT) return ""; // normal volume → no badge
  if (percent < 1000) return String(percent); // ≤3 digits: fits as a percentage
  const mult = percent / 100; // 4-digit percentage → compact multiplier instead
  return (Number.isInteger(mult) ? String(mult) : mult.toFixed(1)) + "x";
}

function titleText(percent) {
  if (percent === DEFAULT_PERCENT) return DEFAULT_TITLE;
  return `${PERCENT_TITLE}${percent}% boost`;
}

// Paint the badge + icon from the tab's frames. The tab may vanish mid-call, so
// rejections are swallowed.
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
    // Storage is per-tab; with several boosted frames the last write wins, which is fine.
    recordFrameState(tabId, sender.frameId, message.volume, message.preset);
    if (tabId != null) {
      api.storage.session
        .set({
          [keyFor(tabId)]: {
            volume: message.volume,
            preset: message.preset,
            eq: message.eq,
          },
        })
        .catch(() => {});
    }
    return; // no reply needed
  }

  if (message?.type === "vol-restore") {
    if (tabId == null) return Promise.resolve(null);
    return api.storage.session
      .get(keyFor(tabId))
      .then((stored) => stored?.[keyFor(tabId)] ?? null)
      .catch(() => null);
  }

  return undefined;
});

// A top-level navigation starts the frames over; they re-report and repaint the badge.
api.webNavigation?.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // only the main frame resets the whole tab
  tabFrames.delete(details.tabId);
  api.action.setBadgeText({ tabId: details.tabId, text: "" }).catch(() => {});
  api.action.setTitle({ tabId: details.tabId, title: DEFAULT_TITLE }).catch(() => {});
  api.action.setIcon({ tabId: details.tabId, path: DEFAULT_ICON }).catch(() => {});
});

api.tabs.onRemoved.addListener((tabId) => {
  tabFrames.delete(tabId);
  api.storage.session.remove(keyFor(tabId)).catch(() => {});
});
