// Tab Volume Booster - popup logic.
// The popup owns the UI. The content script is normally already on the page
// (declared in the manifest); the popup talks to it over runtime messaging and
// only falls back to injecting it for tabs that predate the add-on.

const api = typeof browser !== "undefined" ? browser : chrome;

// These are only *fallbacks*. The real range is owned by the content script's
// SETTINGS.volume block (content.js) and arrives via get-state, so the slider is
// sized from one source. Change the ceiling there, not here.
let MAX = 1200; // max volume %
let MIN = 100; // min volume % (boost-only: normal volume is the floor)
let DEFAULT = 100; // "normal"/reset volume %

// Where the star rating sends people. Once the add-on is live on AMO, replace
// the slug below with the real one from its listing URL (…/addon/<slug>/).
const REVIEW_URL =
  "https://addons.mozilla.org/firefox/addon/crescendo-tab-volume-booster/reviews/";

const slider = document.getElementById("volume");
const readout = document.getElementById("volumeReadout");
const resetButton = document.getElementById("reset");
const presetButtons = [...document.querySelectorAll(".preset")];
const tabsList = document.getElementById("tabsList");
const nowPlayingLabel = document.getElementById("nowPlayingLabel");
const statusHint = document.getElementById("statusHint");
const stars = document.getElementById("stars");

let activeTabId = null;
let currentPreset = "default";
let tabAudible = false; // set by renderNowPlaying: is the current tab making sound?

function setControlsEnabled(enabled) {
  slider.disabled = !enabled;
  presetButtons.forEach((b) => (b.disabled = !enabled));
  resetButton.disabled = !enabled || Number(slider.value) === DEFAULT;
}

// Size the slider and its end labels from the content script's range (called
// once we have state). Keeps the ceiling defined in exactly one place.
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
  // Set on :root so both the slider fill and the circular gauge (.dial) read it.
  document.documentElement.style.setProperty(
    "--fill",
    `${((percent - MIN) / span) * 100}%`
  );
  resetButton.disabled = slider.disabled || percent === DEFAULT;
}

function renderPreset(name) {
  currentPreset = name || "default";
  presetButtons.forEach((b) =>
    b.classList.toggle("active", b.dataset.preset === currentPreset)
  );
}

function renderHint(state) {
  if (!state) {
    statusHint.hidden = true;
    statusHint.classList.remove("warn");
    return;
  }

  // `warn` messages are the honest "out of my hands" cases — audio this add-on
  // physically can't touch — and render in orange. Everything else is a neutral
  // (violet) informational nudge.
  let message = "";
  let warn = false;

  if (state.tricky) {
    // DRM/EME stream (Netflix, Disney+, and the like).
    warn = true;
    message =
      "This site's audio is protected by DRM — boosting it MAY not work.";
  } else if (tabAudible && !state.hasMedia) {
    // Sound is coming from the tab, but from no media element the page exposes —
    // almost always an embedded player inside a cross-origin iframe.
    warn = true;
    message =
      "This audio plays inside an embedded player I can't reach — boosting it MAY not work.";
  } else if (state.blockedMedia > 0) {
    // Media loaded from another site without CORS: unroutable.
    warn = true;
    message =
      "Some audio here comes from another site I'm not allowed to touch — boosting it MAY not work.";
  } else if (state.engaged && !state.hasMedia) {
    message = "No audio or video found on this page yet.";
  }

  statusHint.textContent = message;
  statusHint.hidden = message === "";
  statusHint.classList.toggle("warn", warn && message !== "");
}

// --- Messaging with the active tab's content script ---------------------

async function ensureInjected(tabId) {
  try {
    await api.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (err) {
    return false; // privileged page (about:, addons.mozilla.org, PDF viewer, etc.)
  }
}

async function send(message) {
  if (activeTabId == null) return null;
  try {
    return await api.tabs.sendMessage(activeTabId, message);
  } catch (err) {
    return null;
  }
}

// --- Now-playing row ----------------------------------------------------
// We surface a single row for the CURRENT tab, and only while it's actually
// making sound. (Listing other audible tabs to jump between them added clutter
// for little value — the popup already acts on the tab you're looking at.)

async function renderNowPlaying() {
  tabsList.innerHTML = "";

  const [tab] = await api.tabs.query({
    active: true,
    currentWindow: true,
    audible: true,
  });
  tabAudible = !!tab; // remembered so renderHint can spot the "audible but no reachable media" case
  if (!tab) {
    // this tab is silent — show nothing at all (no label, no row)
    tabsList.hidden = true;
    nowPlayingLabel.hidden = true;
    return;
  }

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

// The content script is normally already present (declared in the manifest).
// For tabs that were open before the add-on was installed/updated it won't be,
// so we inject it once as a fallback. Returns the state, or null if unreachable.
async function syncState(tabId) {
  let state = await send({ type: "get-state" });
  if (!state?.ok) {
    await ensureInjected(tabId);
    state = await send({ type: "get-state" });
  }
  return state;
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

  const state = await syncState(tab.id);
  if (state?.ok) {
    applyRange(state.minPercent, state.maxPercent, state.defaultPercent);
    renderVolume(state.volume);
    renderPreset(state.preset);
    renderHint(state);
  } else {
    // Couldn't reach the content script (e.g. the page loaded before install).
    // Don't block the user — show a gentle nudge and let them try.
    renderVolume(100);
    statusHint.hidden = false;
    statusHint.textContent =
      "If the slider doesn't change the volume, reload this page once, then try again.";
  }
}

// --- Event wiring -------------------------------------------------------

// --- Slider step ---------------------------------------------------------
// The slider only ever boosts (100 % → MAX), so it moves in a single coarse
// 10 % grid the whole way: 10 % is about the smallest boost step that's audible,
// and there's no sub-100 % region left that would need finer control.
const STEP = 10;

function clampVol(v) {
  return Math.min(MAX, Math.max(MIN, v));
}

// Snap a raw value to the nearest 10 %. Used while dragging.
function snapVol(v) {
  return clampVol(Math.round(v / STEP) * STEP);
}

// Move one 10 % stop up or down. Used for keyboard nudges.
function stepVol(from, dir) {
  return clampVol(from + (dir > 0 ? STEP : -STEP));
}

// One place to apply a new volume: reflect it in the UI and tell the tab.
async function commitVolume(percent) {
  const v = clampVol(percent);
  renderVolume(v);
  renderHint(await send({ type: "set-volume", value: v }));
}

slider.addEventListener("input", () => {
  commitVolume(snapVol(Number(slider.value)));
});

// Own the arrow / page / home-end keys so their steps follow the same grid the
// mouse does (native range steps are a single fixed size and can't vary).
slider.addEventListener("keydown", (event) => {
  const current = Number(slider.value);
  let next;
  switch (event.key) {
    case "ArrowUp":
    case "ArrowRight":
      next = stepVol(current, +1);
      break;
    case "ArrowDown":
    case "ArrowLeft":
      next = stepVol(current, -1);
      break;
    case "PageUp":
      next = snapVol(current + 50);
      break;
    case "PageDown":
      next = snapVol(current - 50);
      break;
    case "Home":
      next = MIN;
      break;
    case "End":
      next = MAX;
      break;
    default:
      return; // let every other key behave normally
  }
  event.preventDefault(); // stop the native single-step move
  commitVolume(next);
});

presetButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const name = button.dataset.preset;
    const state = await send({ type: "set-preset", name });
    renderPreset(state?.preset ?? name);
    if (state) renderVolume(state.volume);
    renderHint(state);
  });
});

resetButton.addEventListener("click", async () => {
  const state = await send({ type: "reset" });
  if (state) {
    renderVolume(state.volume);
    renderPreset(state.preset);
    renderHint(state);
  }
});

// Rating. Each star carries a value 1–5. A happy rating (3–5) goes to the store;
// a low one (1–2) is intercepted — instead of sending an unhappy user straight
// to a public review, we surface our email and ask them to reach out first.
const starEls = [...stars.querySelectorAll(".star")];
const rateHint = document.getElementById("rateHint");
const rateFeedback = document.getElementById("rateFeedback");

// Light up stars 1..n to preview a score (0 clears them).
function paintStars(n) {
  starEls.forEach((el, i) => el.classList.toggle("filled", i < n));
}

function rate(value) {
  if (value <= 2) {
    paintStars(value); // leave the chosen stars lit as acknowledgement
    rateHint.hidden = true;
    rateFeedback.hidden = false; // show the "contact us first" note; stay in the popup
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
// Clear the hover preview when the pointer or focus leaves the row.
stars.addEventListener("mouseleave", () => paintStars(0));
stars.addEventListener("focusout", (event) => {
  if (!stars.contains(event.relatedTarget)) paintStars(0);
});

init();
