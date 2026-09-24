// Tab Volume Booster - popup logic.
// Talks to the content script over runtime messaging; injects it only for tabs that predate the add-on.

const api = typeof browser !== "undefined" ? browser : chrome;

// Fallbacks only: the real range comes from SETTINGS.volume in content.js via get-state.
let MAX = 1200; // max volume %
let MIN = 100; // min volume % (boost-only: normal volume is the floor)
let DEFAULT = 100; // "normal"/reset volume %

const REVIEW_URL =
  "https://addons.mozilla.org/firefox/addon/crescendo-tab-volume-booster/reviews/";

const slider = document.getElementById("volume");
const readout = document.getElementById("volumeReadout");
const presetButtons = [...document.querySelectorAll(".preset")];
const tabsList = document.getElementById("tabsList");
const nowPlayingLabel = document.getElementById("nowPlayingLabel");
const tabsSection = tabsList.closest(".tabs"); // whole section, hidden when nothing plays
const statusHint = document.getElementById("statusHint");
const stars = document.getElementById("stars");
const eqPanel = document.getElementById("eqPanel");
const eqTag = document.getElementById("eqTag");
const eqBandsContainer = document.getElementById("eqBands");
const revertButton = document.getElementById("revert");
const revertLabel = document.getElementById("revertLabel");

const EQ_UI = {
  // Hit margin (px) around each EQ track; smaller than the volume slider's so bands don't overlap.
  wheelHitPaddingPixels: 5,
};

// Status-hint copy. Only drmBlocked (hard proof) gets the definite wording and reasons;
// everything else is a "MAY not work" heuristic.
const STATUS_HINT_SETTINGS = {
  drmBlockedMessage: "This tab's audio is protected by DRM, so it can't be boosted.",
  drmBlockedReasonsTitle: "Why it's blocked:",
  drmBlockedReasons: [
    "This tab locked its audio with a DRM content key (services like Spotify and Netflix use Widevine), so the decoded sound is kept out of reach of the page's code entirely.",
    "Firefox forbids sending DRM-protected audio through the Web Audio API — attempting it raises “NotSupportedError” and would silence playback rather than boost it.",
  ],
  infoIconLabel: "Why can't this be boosted?",
  drmMaybeMessage: "This site's audio is protected by DRM — boosting it MAY not work.",
  embeddedPlayerMessage:
    "The audio is playing inside an embedded player — boosting it MAY not work.",
  crossOriginMessage:
    "Some audio here comes from another site — boosting it MAY not work.",
  noMediaMessage: "No audio or video found on this page yet.",
};

// gainKey -> { input, output }, built from the content script's band list.
const eqControls = new Map();
let eqSignature = ""; // the band set currently built, so we only rebuild when it changes

let activeTabId = null;
let activeFrameId = 0; // the frame the popup drives — the one that actually has the media
let framesHaveMedia = false; // did ANY reachable frame report media? (drives the warning)
let currentPreset = "default";
let tabAudible = false; // set by renderNowPlaying: is the current tab making sound?

// --- Revert / restore toggle ------------------------------------------
// revertSnapshot holds the { volume, eq } from just before reverting to 100 % + flat;
// while set, the next click restores it. Any manual change clears it.
let revertSnapshot = null;
let currentEqGains = {}; // mirrors the tab's live EQ so revert can snapshot it
let applyingRevert = false; // true while the button itself drives volume/EQ

function noteEqGains(state) {
  if (!state || !Array.isArray(state.eqBands)) return;
  currentEqGains = {};
  for (const band of state.eqBands) currentEqGains[band.gainKey] = band.gainDb;
}

function clearRevertSnapshot() {
  if (applyingRevert || revertSnapshot === null) return;
  revertSnapshot = null;
  updateRevertButton();
}

// Label + enabled state for what the NEXT click will do (restore or revert).
function updateRevertButton() {
  if (revertSnapshot) {
    revertLabel.textContent = `Revert to ${revertSnapshot.volume} %`;
    revertButton.disabled = slider.disabled;
  } else {
    revertLabel.textContent = `Revert to ${DEFAULT} %`;
    const boosted = Number(slider.value) !== DEFAULT || currentPreset !== "default";
    revertButton.disabled = slider.disabled || !boosted;
  }
}

function setControlsEnabled(enabled) {
  slider.disabled = !enabled;
  presetButtons.forEach((b) => (b.disabled = !enabled));
  for (const { input } of eqControls.values()) input.disabled = !enabled;
  updateRevertButton();
}

function applyRange(min, max, def) {
  MIN = min;
  MAX = max;
  DEFAULT = def;
  slider.min = MIN;
  slider.max = MAX;
  const minLabel = document.getElementById("sliderMin");
  const maxLabel = document.getElementById("sliderMax");
  if (minLabel) minLabel.textContent = `${MIN} %`;
  if (maxLabel) maxLabel.textContent = `${MAX} %`;
}

function renderVolume(percent) {
  slider.value = percent;
  readout.textContent = `${percent}%`;
  const span = MAX - MIN || 1;
  // On :root so both the slider fill and the dial read it.
  document.documentElement.style.setProperty(
    "--fill",
    `${((percent - MIN) / span) * 100}%`
  );
  updateRevertButton();
}

function renderPreset(name) {
  currentPreset = name || "default";
  presetButtons.forEach((b) =>
    b.classList.toggle("active", b.dataset.preset === currentPreset)
  );
  updateRevertButton();
}

// Fallbacks only: the real range comes from SETTINGS.eq in content.js.
let EQ_MIN = 0;
let EQ_MAX = 18;
let EQ_STEP = 1;

function formatDb(db) {
  return `${db > 0 ? "+" : ""}${db} dB`;
}

// Sets the slider's own --fill (overrides the :root one used by the volume slider).
function setFader(input, output, db) {
  input.value = db;
  output.textContent = formatDb(db);
  const span = Number(input.max) - Number(input.min) || 1;
  input.style.setProperty("--fill", `${((db - Number(input.min)) / span) * 100}%`);
}

function formatHz(hz) {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
  }
  return `${hz} Hz`;
}

// One slider row per band; rebuilt only when the band set changes (eqSignature).
function buildEqRows(bands, range) {
  eqBandsContainer.textContent = "";
  eqControls.clear();
  for (const band of bands) {
    const row = document.createElement("div");
    row.className = "eq-band";

    const top = document.createElement("div");
    top.className = "eq-band-top";
    const name = document.createElement("span");
    name.className = "eq-name";
    name.textContent = `${band.label} `;
    const freq = document.createElement("span");
    freq.className = "eq-freq";
    freq.textContent = formatHz(band.frequencyHz);
    name.appendChild(freq);
    const output = document.createElement("output");
    output.className = "eq-val";
    top.append(name, output);

    const input = document.createElement("input");
    input.type = "range";
    input.className = "slider eq-slider";
    input.min = range.minDb;
    input.max = range.maxDb;
    input.step = range.stepDb;
    input.value = band.gainDb;
    input.setAttribute("aria-label", `${band.label} gain in decibels`);

    row.append(top, input);
    eqBandsContainer.appendChild(row);

    eqControls.set(band.gainKey, { input, output });
    wireEqBand(band.gainKey, input, output, row);
  }
}

// The EQ panel shows only for a non-flat tone (a preset or a custom mix).
function renderEq(state) {
  const show =
    !!state && state.preset !== "default" && Array.isArray(state.eqBands);
  eqPanel.hidden = !show;
  if (!show) return;

  const range = state.eqRange || { minDb: EQ_MIN, maxDb: EQ_MAX, stepDb: EQ_STEP };
  EQ_MIN = range.minDb;
  EQ_MAX = range.maxDb;
  EQ_STEP = range.stepDb;

  const signature = state.eqBands.map((b) => b.gainKey).join(",");
  if (signature !== eqSignature) {
    buildEqRows(state.eqBands, range);
    eqSignature = signature;
  }

  for (const band of state.eqBands) {
    const control = eqControls.get(band.gainKey);
    if (!control) continue;
    control.input.min = EQ_MIN;
    control.input.max = EQ_MAX;
    control.input.step = EQ_STEP;
    setFader(control.input, control.output, band.gainDb);
  }
  // Visibility only, so the sliders never reflow.
  eqTag.classList.toggle("eq-tag--hidden", state.preset !== "custom");
}

// Info icon whose hover/focus tooltip lists why the audio can't be boosted.
function buildInfoIcon(reasons, title) {
  const info = document.createElement("span");
  info.className = "info";
  info.tabIndex = 0; // keyboard-focusable so the tooltip isn't hover-only
  info.setAttribute("role", "button");
  info.setAttribute("aria-label", STATUS_HINT_SETTINGS.infoIconLabel);

  const glyph = document.createElement("span");
  glyph.className = "info-glyph";
  glyph.textContent = "i"; // CSS renders this as a circled "i"
  glyph.setAttribute("aria-hidden", "true");

  const pop = document.createElement("span");
  pop.className = "info-pop";
  pop.setAttribute("role", "tooltip");

  const heading = document.createElement("strong");
  heading.className = "info-pop-title";
  heading.textContent = title;
  pop.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "info-pop-list";
  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    list.appendChild(item);
  }
  pop.appendChild(list);

  info.append(glyph, pop);
  return info;
}

function renderHint(state) {
  statusHint.textContent = ""; // clear any previous text + info icon
  if (!state) {
    statusHint.hidden = true;
    statusHint.classList.remove("warn");
    return;
  }

  // warn = audio we can't touch (orange); otherwise a neutral nudge. reasons = proven list (DRM only).
  let message = "";
  let warn = false;
  let reasons = null;

  if (state.drmBlocked) {
    warn = true;
    message = STATUS_HINT_SETTINGS.drmBlockedMessage;
    reasons = STATUS_HINT_SETTINGS.drmBlockedReasons;
  } else if (state.tricky) {
    // Known-DRM host, not yet proven this session.
    warn = true;
    message = STATUS_HINT_SETTINGS.drmMaybeMessage;
  } else if (tabAudible && !framesHaveMedia) {
    // Audible, but no reachable frame has media: it's in a frame we can't inject into.
    warn = true;
    message = STATUS_HINT_SETTINGS.embeddedPlayerMessage;
  } else if (state.blockedMedia > 0) {
    warn = true;
    message = STATUS_HINT_SETTINGS.crossOriginMessage;
  } else if (state.engaged && !state.hasMedia) {
    message = STATUS_HINT_SETTINGS.noMediaMessage;
  }

  if (message === "") {
    statusHint.hidden = true;
    statusHint.classList.remove("warn");
    return;
  }

  const text = document.createElement("span");
  text.className = "status-hint-text";
  text.textContent = reasons ? message + " " : message;
  statusHint.appendChild(text);
  if (reasons && reasons.length) {
    statusHint.appendChild(buildInfoIcon(reasons, STATUS_HINT_SETTINGS.drmBlockedReasonsTitle));
  }
  statusHint.hidden = false;
  statusHint.classList.toggle("warn", warn);
}

// --- Messaging with the active tab's content script ---------------------

async function ensureInjected(tabId) {
  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    return true;
  } catch (err) {
    return false; // privileged page (about:, addons.mozilla.org, PDF viewer, etc.)
  }
}

// Send a mutation to every frame so they move together; return the driven frame's reply.
async function broadcast(message) {
  if (activeTabId == null) return null;
  let ids = [0]; // fall back to the top frame if enumeration fails
  try {
    const frames = await api.webNavigation.getAllFrames({ tabId: activeTabId });
    if (frames && frames.length) ids = frames.map((f) => f.frameId);
  } catch (err) {
    /* keep the top-frame fallback */
  }
  const replies = await Promise.all(ids.map((id) => sendToFrame(id, message)));
  const mine = replies[ids.indexOf(activeFrameId)];
  return mine ?? replies.find((r) => r?.ok) ?? null;
}

// One broadcast in flight, newest wins. Without this a fast drag queues a message per
// input event and the audio keeps climbing after you stop.
function coalesceBroadcast() {
  let inFlight = false;
  let pending = null; // { message, onReply } — only the most recent is kept

  async function pump() {
    if (inFlight || !pending) return;
    inFlight = true;
    const { message, onReply } = pending;
    pending = null;
    let reply = null;
    try {
      reply = await broadcast(message);
    } finally {
      inFlight = false;
    }
    // settled = nothing newer queued. Controls should only follow settled replies, or a
    // stale one yanks the thumb back mid-drag.
    onReply?.(reply, pending === null);
    pump();
  }

  return (message, onReply) => {
    pending = { message, onReply };
    pump();
  };
}

async function sendToFrame(frameId, message) {
  if (activeTabId == null) return null;
  try {
    return await api.tabs.sendMessage(activeTabId, message, { frameId });
  } catch (err) {
    return null; // frame has no content script (privileged/sandboxed) or is gone
  }
}

// Ask every frame in the tab for its state; keep the ones that answered.
async function collectFrameStates(tabId) {
  let frames;
  try {
    frames = await api.webNavigation.getAllFrames({ tabId });
  } catch (err) {
    frames = null;
  }
  if (!frames || !frames.length) frames = [{ frameId: 0 }]; // at least try the top frame
  const results = await Promise.all(
    frames.map(async (f) => ({
      frameId: f.frameId,
      state: await sendToFrame(f.frameId, { type: "get-state" }),
    }))
  );
  return results.filter((r) => r.state?.ok);
}

// Prefer a frame with media (top frame first), else the top frame.
function pickTargetFrame(states) {
  const withMedia = states.filter((r) => r.state.hasMedia);
  if (withMedia.length) {
    return withMedia.find((r) => r.frameId === 0) ?? withMedia[0];
  }
  return states.find((r) => r.frameId === 0) ?? states[0] ?? null;
}

// --- Now-playing row (current tab, only while audible) -------------------

async function renderNowPlaying() {
  tabsList.innerHTML = "";

  const [tab] = await api.tabs.query({
    active: true,
    currentWindow: true,
    audible: true,
  });
  tabAudible = !!tab;
  if (!tab) {
    tabsList.hidden = true;
    nowPlayingLabel.hidden = true;
    tabsSection.hidden = true;
    return;
  }
  tabsSection.hidden = false;

  const li = document.createElement("li");
  li.className = "tab-item current";

  const icon = document.createElement("img");
  icon.src = tab.favIconUrl || "";
  icon.alt = "";
  icon.addEventListener("error", () => (icon.style.visibility = "hidden"));

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title || tab.url || "This tab";

  li.append(icon, title);
  tabsList.appendChild(li);
  tabsList.hidden = false;
  nowPlayingLabel.hidden = false;
}

// --- Init ---------------------------------------------------------------

// Pages where no extension can ever run (Firefox blocks content scripts here).
const RESTRICTED = /^(about:|moz-extension:|resource:|view-source:|chrome:|jar:|data:|https?:\/\/(addons|support)\.mozilla\.org)/i;

// Tabs opened before install have no content script, so inject once as a fallback.
async function syncState(tabId) {
  let states = await collectFrameStates(tabId);
  if (!states.length) {
    await ensureInjected(tabId);
    states = await collectFrameStates(tabId);
  }
  return states;
}

async function init() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;

  await renderNowPlaying();

  if (!tab || (tab.url && RESTRICTED.test(tab.url))) {
    setControlsEnabled(false);
    readout.textContent = "n/a";
    statusHint.hidden = false;
    statusHint.textContent =
      "Firefox doesn't allow add-ons to run here. Open a normal website (like a YouTube video) and reopen this.";
    return;
  }

  // Be optimistic: let the user drive the controls right away.
  setControlsEnabled(true);
  maybeShowTutorial(); // first run only — fire and forget

  const states = await syncState(tab.id);
  const target = states.length ? pickTargetFrame(states) : null;
  if (target) {
    activeFrameId = target.frameId;
    framesHaveMedia = states.some((r) => r.state.hasMedia);
    const state = target.state;
    applyRange(state.minPercent, state.maxPercent, state.defaultPercent);
    renderVolume(state.volume);
    renderPreset(state.preset);
    renderEq(state);
    renderHint(state);
    noteEqGains(state);
  } else {
    // No frame answered (e.g. page loaded before install). Let the user try anyway.
    renderVolume(DEFAULT);
    statusHint.hidden = false;
    statusHint.textContent =
      "If the slider doesn't change the volume, reload this page once, then try again.";
  }
}

// --- Event wiring -------------------------------------------------------

// --- Slider step ---------------------------------------------------------
const STEP = 10; // about the smallest audible boost step
const COARSE_STEP = 50; // PageUp/PageDown and Ctrl+wheel

function clampVolume(value) {
  return Math.min(MAX, Math.max(MIN, value));
}

function snapVolume(value) {
  return clampVolume(Math.round(value / STEP) * STEP);
}

function stepVolume(from, direction, coarse = false) {
  const size = coarse ? COARSE_STEP : STEP;
  return clampVolume(from + (direction > 0 ? size : -size));
}

// Update the UI instantly, then send (coalesced) to the tab.
const sendVolume = coalesceBroadcast();
function commitVolume(percent) {
  const clamped = clampVolume(percent);
  renderVolume(clamped);
  clearRevertSnapshot();
  sendVolume({ type: "set-volume", value: clamped }, (state) => {
    renderHint(state);
    noteEqGains(state);
  });
}

slider.addEventListener("input", () => {
  commitVolume(snapVolume(Number(slider.value)));
});

// Own the navigation keys so they follow the same step grid as the mouse.
slider.addEventListener("keydown", (event) => {
  const current = Number(slider.value);
  let next;
  switch (event.key) {
    case "ArrowUp":
    case "ArrowRight":
      next = stepVolume(current, +1);
      break;
    case "ArrowDown":
    case "ArrowLeft":
      next = stepVolume(current, -1);
      break;
    case "PageUp":
      next = stepVolume(current, +1, true);
      break;
    case "PageDown":
      next = stepVolume(current, -1, true);
      break;
    case "Home":
      next = MIN;
      break;
    case "End":
      next = MAX;
      break;
    default:
      return;
  }
  event.preventDefault();
  commitVolume(next);
});

initSliderHover({ slider, snapVolume, stepVolume, commitVolume });

presetButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    clearRevertSnapshot();
    const name = button.dataset.preset;
    const state = await broadcast({ type: "set-preset", name });
    renderPreset(state?.preset ?? name);
    if (state) renderVolume(state.volume);
    renderEq(state);
    renderHint(state);
    noteEqGains(state);
  });
});

revertButton.addEventListener("click", async () => {
  if (revertButton.disabled) return;
  applyingRevert = true;
  try {
    let state;
    if (revertSnapshot) {
      const saved = revertSnapshot;
      revertSnapshot = null;
      await broadcast({ type: "set-eq", eq: saved.eq });
      state = await broadcast({ type: "set-volume", value: saved.volume });
    } else {
      revertSnapshot = { volume: Number(slider.value), eq: { ...currentEqGains } };
      await broadcast({ type: "set-preset", name: "default" });
      state = await broadcast({ type: "set-volume", value: DEFAULT });
    }
    if (state) {
      renderVolume(state.volume);
      renderPreset(state.preset);
      renderEq(state);
      renderHint(state);
      noteEqGains(state);
    }
  } finally {
    applyingRevert = false;
    updateRevertButton();
  }
});

function clampDb(db) {
  return Math.min(EQ_MAX, Math.max(EQ_MIN, db));
}
function snapDb(db) {
  return clampDb(Math.round(db / EQ_STEP) * EQ_STEP);
}
function stepDb(from, direction) {
  return clampDb(from + (direction > 0 ? EQ_STEP : -EQ_STEP));
}

// Send only the band that moved; the content script merges it.
const sendEq = coalesceBroadcast();
function commitEq(band, input, output, db) {
  const snapped = snapDb(db);
  setFader(input, output, snapped);
  clearRevertSnapshot();
  sendEq({ type: "set-eq", eq: { [band]: snapped } }, (state, settled) => {
    if (!state || !settled) return;
    renderPreset(state.preset);
    renderEq(state);
    renderHint(state);
    noteEqGains(state);
  });
}

function wireEqBand(band, input, output, zone) {
  const commit = (db) => commitEq(band, input, output, db);
  input.addEventListener("input", () => commit(Number(input.value)));
  attachSliderControls({
    slider: input,
    zone,
    snap: snapDb,
    step: stepDb,
    commit,
    padding: EQ_UI.wheelHitPaddingPixels,
  });
}

// Rating: 4–5 stars go to the store; 1–3 show a "contact us first" note instead.
const starEls = [...stars.querySelectorAll(".star")];
const rateHint = document.getElementById("rateHint");
const rateFeedback = document.getElementById("rateFeedback");

function paintStars(n) {
  starEls.forEach((el, i) => el.classList.toggle("filled", i < n));
}

function rate(value) {
  if (value <= 3) {
    paintStars(value);
    rateHint.hidden = true;
    rateFeedback.hidden = false;
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  } else {
    api.tabs.create({ url: REVIEW_URL });
    window.close();
  }
}

starEls.forEach((el) => {
  const value = Number(el.dataset.value);
  el.addEventListener("mouseenter", () => paintStars(value));
  el.addEventListener("focus", () => paintStars(value));
  el.addEventListener("click", () => rate(value));
});
stars.addEventListener("mouseleave", () => paintStars(0));
stars.addEventListener("focusout", (event) => {
  if (!stars.contains(event.relatedTarget)) paintStars(0);
});

// --- First-run coach marks (shown once) ----------------------------------
const coach = document.getElementById("coach");
const coachTip = document.getElementById("coachTip");
const coachText = document.getElementById("coachText");
const COACH_STEPS = [
  { el: document.querySelector(".slider-wrap"), text: "Drag this slider to boost audio!" },
  { el: document.querySelector(".presets"), text: "Click a preset to boost a voice or increase bass." },
];
let coachStep = -1;

function nextCoach() {
  COACH_STEPS[coachStep]?.el.classList.remove("coach-target");
  if (++coachStep >= COACH_STEPS.length) {
    coach.hidden = true;
    try { api.storage.local.set({ tutorialSeen: true }); } catch (e) {}
    return;
  }
  const { el, text } = COACH_STEPS[coachStep];
  el.classList.add("coach-target");
  coachText.textContent = text;
  const r = el.getBoundingClientRect();
  const below = r.bottom + 12 + coachTip.offsetHeight < window.innerHeight;
  coachTip.classList.toggle("below", below);
  coachTip.classList.toggle("above", !below);
  coachTip.style.top = `${below ? r.bottom + 12 : r.top - 12 - coachTip.offsetHeight}px`;
  coachTip.style.setProperty("--arrow", `${r.left + r.width / 2 - 22}px`);
}

async function maybeShowTutorial() {
  try {
    if ((await api.storage.local.get("tutorialSeen")).tutorialSeen) return;
  } catch (e) { /* storage unavailable — just show it */ }
  coach.hidden = false;
  nextCoach();
}
coach.addEventListener("click", nextCoach);

// Doing the real gesture also dismisses its step.
function dismissCoachStep(step) {
  if (!coach.hidden && coachStep === step) nextCoach();
}
slider.addEventListener("input", () => dismissCoachStep(0));
presetButtons.forEach((b) => b.addEventListener("click", () => dismissCoachStep(1)));

init();
