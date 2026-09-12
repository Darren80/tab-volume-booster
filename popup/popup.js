// Tab Volume Booster - popup logic.
// The popup owns the UI. The content script is normally already on the page
// (declared in the manifest); the popup talks to it over runtime messaging and
// only falls back to injecting it for tabs that predate the add-on.

const api = typeof browser !== "undefined" ? browser : chrome;

// These are only *fallbacks*. The real range is owned by the content script's
// SETTINGS.volume block (content.js) and arrives via get-state, so the slider is
// sized from one source. Change the ceiling there, not here.
let MAX = 1200; // max volume %
let MIN = 0; // min volume %
let DEFAULT = 100; // "normal"/reset volume %

// Where the star rating sends people. Once the add-on is live on AMO, replace
// the slug below with the real one from its listing URL (…/addon/<slug>/).
const REVIEW_URL =
  "https://addons.mozilla.org/firefox/addon/crescendo-tab-volume-booster/reviews/";

const slider = document.getElementById("volume");
const readout = document.getElementById("volumeReadout");
const resetButton = document.getElementById("reset");
const presetButtons = [...document.querySelectorAll(".preset")];
const tabsEmpty = document.getElementById("tabsEmpty");
const tabsList = document.getElementById("tabsList");
const statusHint = document.getElementById("statusHint");
const stars = document.getElementById("stars");

let activeTabId = null;
let currentPreset = "default";

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
    return;
  }
  let message = "";
  if (state.blockedMedia > 0) {
    message = "This audio is from another site and can't be boosted above 100%.";
  } else if (state.engaged && !state.hasMedia) {
    message = "No audio or video found on this page yet.";
  }
  statusHint.textContent = message;
  statusHint.hidden = message === "";
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

// --- Audible tabs list --------------------------------------------------

async function renderAudibleTabs() {
  const tabs = await api.tabs.query({ audible: true });
  tabsList.innerHTML = "";

  if (!tabs.length) {
    tabsEmpty.hidden = false;
    tabsList.hidden = true;
    return;
  }

  tabsEmpty.hidden = true;
  tabsList.hidden = false;

  for (const tab of tabs) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "tab-item" + (tab.id === activeTabId ? " current" : "");

    const icon = document.createElement("img");
    icon.src = tab.favIconUrl || "";
    icon.alt = "";
    icon.addEventListener("error", () => (icon.style.visibility = "hidden"));

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url || "Untitled tab";

    button.append(icon, title);
    button.addEventListener("click", async () => {
      await api.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) {
        await api.windows.update(tab.windowId, { focused: true });
      }
      window.close();
    });

    li.appendChild(button);
    tabsList.appendChild(li);
  }
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

  await renderAudibleTabs();

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

// --- Variable step: fine below 100 %, coarse above -----------------------
// Below the default the slider moves in 1 % steps; at/above it, in 10 % steps.
// Boosting is a blunt instrument (10 % is barely audible), while trimming below
// 100 % wants precision — so the grid coarsens exactly where 100 % begins.
const COARSE_FROM = 100; // the boundary: fine steps below it, coarse at/above

function clampVol(v) {
  return Math.min(MAX, Math.max(MIN, v));
}

// Snap a raw value to the nearest valid stop for where it sits: to the nearest
// 1 below the boundary, to the nearest 10 at/above it. Used while dragging.
function snapVol(v) {
  const snapped = v < COARSE_FROM ? Math.round(v) : Math.round(v / 10) * 10;
  return clampVol(snapped);
}

// Move one stop up or down from `from`, honouring the coarse/fine boundary so
// arrow keys land cleanly on 99 → 100 → 110. Used for keyboard nudges.
function stepVol(from, dir) {
  if (dir > 0) {
    const step = from >= COARSE_FROM ? 10 : 1; // 99→100 (fine), 100→110 (coarse)
    return clampVol(from + step);
  }
  const step = from > COARSE_FROM ? 10 : 1; // 110→100 (coarse), 100→99 (fine)
  return clampVol(from - step);
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

// Rating: open the store's review page in a new tab. It's a single link, so
// clicking any star (or activating it by keyboard) does the same thing.
function openReview() {
  api.tabs.create({ url: REVIEW_URL });
  window.close();
}
stars.addEventListener("click", openReview);
stars.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openReview();
  }
});

init();
