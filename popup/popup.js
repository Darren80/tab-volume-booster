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
let activeFrameId = 0; // the frame the popup drives — the one that actually has the media
let framesHaveMedia = false; // did ANY reachable frame report media? (drives the warning)
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
  } else if (tabAudible && !framesHaveMedia) {
    // Sound is coming from the tab, but NO frame we can reach exposes a media
    // element — the audio lives in a frame we can't inject into (a sandboxed or
    // otherwise privileged embed), so it's genuinely out of reach.
    warn = true;
    message =
      "The audio is playing inside an embedded player I can't reach — boosting it MAY not work.";
  } else if (state.blockedMedia > 0) {
    // Media loaded from another site without CORS: unroutable.
    warn = true;
    message =
      "Some audio here comes from another site — boosting it MAY not work.";
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
    // allFrames so embedded players (cross-origin iframes) get the script too.
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
    return true;
  } catch (err) {
    return false; // privileged page (about:, addons.mozilla.org, PDF viewer, etc.)
  }
}

// Apply a mutation (set-volume / set-preset / reset) to EVERY frame in the tab,
// so all media frames move together — exactly what a reload does when each frame
// restores. Every frame applies uniformly; a frame with no media just holds an
// idle, silent graph (nothing is routed until it's running AND has media). We
// return the driven media frame's reply so the readout and hint reflect the
// frame the user actually hears.
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

// Send to a specific frame (used while probing every frame for its state).
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

// Choose which frame the popup should control: prefer one that actually has
// media (preferring the top frame if it does), otherwise fall back to the top
// frame so the controls still target something sane.
function pickTargetFrame(states) {
  const withMedia = states.filter((r) => r.state.hasMedia);
  if (withMedia.length) {
    return withMedia.find((r) => r.frameId === 0) ?? withMedia[0];
  }
  return states.find((r) => r.frameId === 0) ?? states[0] ?? null;
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

// The content script is normally already present in every frame (declared in the
// manifest with all_frames). For tabs open before the add-on was installed it
// won't be, so we inject it (into all frames) once as a fallback. Returns the
// answering frames' states, or [] if the tab is unreachable.
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
    activeFrameId = target.frameId; // drive whichever frame holds the media
    framesHaveMedia = states.some((r) => r.state.hasMedia); // any reachable frame?
    const state = target.state;
    applyRange(state.minPercent, state.maxPercent, state.defaultPercent);
    renderVolume(state.volume);
    renderPreset(state.preset);
    renderHint(state);
  } else {
    // Couldn't reach the content script in any frame (e.g. page loaded before
    // install). Don't block the user — show a gentle nudge and let them try.
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
  renderHint(await broadcast({ type: "set-volume", value: v }));
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

// The slider track is thin, so we treat a few pixels around it as part of the
// control: the wheel, the cursor, and clicks all respond within this margin.
const SLIDER_PAD = 12; // px of slack around the slider's box
const sliderZone = document.querySelector(".slider-wrap") || slider;

// Is the pointer over the slider, or within SLIDER_PAD of its box?
function nearSlider(event) {
  if (slider.disabled) return false;
  const r = slider.getBoundingClientRect();
  return (
    event.clientX >= r.left - SLIDER_PAD &&
    event.clientX <= r.right + SLIDER_PAD &&
    event.clientY >= r.top - SLIDER_PAD &&
    event.clientY <= r.bottom + SLIDER_PAD
  );
}

// Map a pointer X within the (padded) track to a snapped volume.
function volFromX(clientX) {
  const r = slider.getBoundingClientRect();
  const frac = (clientX - r.left) / r.width;
  return snapVol(MIN + Math.min(1, Math.max(0, frac)) * (MAX - MIN));
}

// Scroll wheel nudges one 10 % stop per notch. Scrolling up (negative deltaY)
// raises the volume, matching the slider labels.
sliderZone.addEventListener(
  "wheel",
  (event) => {
    if (!nearSlider(event)) return;
    event.preventDefault(); // don't scroll the popup while adjusting
    const dir = event.deltaY < 0 ? +1 : -1;
    commitVolume(stepVol(Number(slider.value), dir));
  },
  { passive: false },
);

// Show the slider cursor throughout the margin, not just on the thin track.
sliderZone.addEventListener("pointermove", (event) => {
  sliderZone.style.cursor = nearSlider(event) ? "pointer" : "";
});
sliderZone.addEventListener("pointerleave", () => {
  sliderZone.style.cursor = "";
});

// Clicking in the margin jumps the slider to that spot; holding lets you drag.
sliderZone.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target === slider || !nearSlider(event)) return;
  event.preventDefault();
  sliderZone.setPointerCapture(event.pointerId);
  commitVolume(volFromX(event.clientX));
  const onMove = (e) => commitVolume(volFromX(e.clientX));
  const onUp = () => {
    sliderZone.removeEventListener("pointermove", onMove);
    sliderZone.removeEventListener("pointerup", onUp);
  };
  sliderZone.addEventListener("pointermove", onMove);
  sliderZone.addEventListener("pointerup", onUp);
});

presetButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    const name = button.dataset.preset;
    const state = await broadcast({ type: "set-preset", name });
    renderPreset(state?.preset ?? name);
    if (state) renderVolume(state.volume);
    renderHint(state);
  });
});

resetButton.addEventListener("click", async () => {
  const state = await broadcast({ type: "reset" });
  if (state) {
    renderVolume(state.volume);
    renderPreset(state.preset);
    renderHint(state);
  }
});

// Rating. Each star carries a value 1–5. A happy rating (4–5) goes to the store;
// a lukewarm-or-worse one (1–3) is intercepted — instead of sending a less-than-
// thrilled user straight to a public review, we surface our email and ask them to
// reach out first.
const starEls = [...stars.querySelectorAll(".star")];
const rateHint = document.getElementById("rateHint");
const rateFeedback = document.getElementById("rateFeedback");

// Light up stars 1..n to preview a score (0 clears them).
function paintStars(n) {
  starEls.forEach((el, i) => el.classList.toggle("filled", i < n));
}

function rate(value) {
  if (value <= 3) {
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

// --- First-run coach marks ----------------------------------------------
// Shown once (storage.local "tutorialSeen"): dim the popup and point an arrow
// at the slider, then the presets. Click anywhere to advance / dismiss.
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

// The real gesture also dismisses its own step: dragging the slider clears the
// slider tip, clicking a preset clears the preset tip.
function dismissCoachStep(step) {
  if (!coach.hidden && coachStep === step) nextCoach();
}
slider.addEventListener("input", () => dismissCoachStep(0));
presetButtons.forEach((b) => b.addEventListener("click", () => dismissCoachStep(1)));

init();
