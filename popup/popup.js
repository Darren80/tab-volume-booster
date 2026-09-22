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

// EQ popup knobs — layout/interaction only (the audio params live in content.js
// SETTINGS). Grouped here so the popup's tunables are also in one place.
const EQ_UI = {
  // How far (px) around each EQ track the wheel / click-in-margin still acts. Smaller
  // than the volume slider's margin so the two bands don't grab each other's scrolls.
  wheelHitPaddingPixels: 5,
};

// All status-hint copy lives here (no message strings inline in renderHint). The DRM
// case is the ONLY definite "cannot be boosted" — it fires solely on state.drmBlocked,
// which the content script sets from hard proof (an EME key was attached; see
// SETTINGS.drm in content.js). Everything else stays a "MAY not work" heuristic. The
// reasons behind the info icon must be things that make boosting 100% impossible — never
// merely unlikely — so keep this list to proven facts only.
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

// Built EQ sliders, keyed by their gain key (e.g. "bassGainDb") -> { input, output }.
// Populated by buildEqRows from the content script's band list; the popup never
// hardcodes which bands exist.
const eqControls = new Map();
let eqSignature = ""; // the band set currently built, so we only rebuild when it changes

let activeTabId = null;
let activeFrameId = 0; // the frame the popup drives — the one that actually has the media
let framesHaveMedia = false; // did ANY reachable frame report media? (drives the warning)
let currentPreset = "default";
let tabAudible = false; // set by renderNowPlaying: is the current tab making sound?

// --- Revert / restore toggle state --------------------------------------
// The revert button is a two-way memory toggle. `revertSnapshot` holds the
// { volume, eq } we were at just before reverting to 100 % + flat; while it's set
// the button is in "restore" mode ("Revert to 250 %") and the next click puts that
// volume and tone back. It's cleared the moment the user changes anything by hand,
// so the button never offers to restore a tone that no longer relates to what they
// hear. `currentEqGains` mirrors the tab's live EQ so we can snapshot it on revert.
let revertSnapshot = null;
let currentEqGains = {};
// True only while the button's own handler drives the volume/EQ, so those
// programmatic changes don't clear the snapshot the way a manual change does.
let applyingRevert = false;

// Mirror the tab's current EQ gains from a state reply (getState always ships the
// full band list), so revert can snapshot the exact tone — presets and custom alike.
function noteEqGains(state) {
  if (!state || !Array.isArray(state.eqBands)) return;
  currentEqGains = {};
  for (const band of state.eqBands) currentEqGains[band.gainKey] = band.gainDb;
}

// Drop the saved state and fall back to plain "revert" mode. Called on any manual
// change (see commitVolume / the preset + EQ handlers) so a stale memory can't linger.
function clearRevertSnapshot() {
  if (applyingRevert || revertSnapshot === null) return;
  revertSnapshot = null;
  updateRevertButton();
}

// Point the button's label + enabled state at what the NEXT click will do:
//  - restore mode (snapshot held): "Revert to <saved> %", always clickable.
//  - revert mode (no snapshot): "Revert to 100 %", enabled only when there's
//    actually something to revert (boosted above 100 % or a non-flat tone).
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
  updateRevertButton(); // its enabled state follows the slider's
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
  updateRevertButton(); // "revert to 100 %" only matters when we're above it
}

function renderPreset(name) {
  currentPreset = name || "default";
  presetButtons.forEach((b) =>
    b.classList.toggle("active", b.dataset.preset === currentPreset)
  );
  updateRevertButton(); // a non-flat tone also counts as "something to revert"
}

// The EQ fader range/step, owned by the content script (SETTINGS.eq) and delivered
// via get-state, so it's defined in one place. These are only fallbacks.
let EQ_MIN = 0;
let EQ_MAX = 18;
let EQ_STEP = 1;

// Boost-only bands, so a positive gain reads "+N dB"; 0 is plain "0 dB".
function formatDb(db) {
  return `${db > 0 ? "+" : ""}${db} dB`;
}

// Position one band's slider + readout from its gain (in dB). Sets the slider's own
// --fill so its gradient fills like the volume slider (which reads --fill off :root;
// an inline value on the element wins for that slider only).
function setFader(input, output, db) {
  input.value = db;
  output.textContent = formatDb(db);
  const span = Number(input.max) - Number(input.min) || 1;
  input.style.setProperty("--fill", `${((db - Number(input.min)) / span) * 100}%`);
}

// Format a band's centre frequency for its label: "120 Hz", "1.5 kHz", "10 kHz".
function formatHz(hz) {
  if (hz >= 1000) {
    const k = hz / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
  }
  return `${hz} Hz`;
}

// Build one slider row per band from the content script's band list. Rebuilt only
// when the set of bands changes (see eqSignature), so normal updates just re-point
// values. Each row reuses .slider, so it looks and behaves like the volume slider.
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
    wireEqBand(band.gainKey, input, output, row); // native input + shared wheel/click
  }
}

// The EQ panel is the tone control, so it shows only when the tone is non-flat:
// a Voice/Bass preset, or a hand-tuned "custom" mix. On Flat (every band 0 dB)
// there's nothing to edit, so it stays hidden. Sliders and the "Custom" tag follow
// the content script's authoritative gains.
function renderEq(state) {
  const show =
    !!state && state.preset !== "default" && Array.isArray(state.eqBands);
  eqPanel.hidden = !show;
  if (!show) return;

  const range = state.eqRange || { minDb: EQ_MIN, maxDb: EQ_MAX, stepDb: EQ_STEP };
  EQ_MIN = range.minDb;
  EQ_MAX = range.maxDb;
  EQ_STEP = range.stepDb;

  // (Re)build rows only when the band set itself changes.
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
  // Toggle only visibility (space stays reserved) so this never reflows the sliders.
  eqTag.classList.toggle("eq-tag--hidden", state.preset !== "custom");
}

// Build the info icon that sits after a definite warning. Hovering (or focusing) it
// reveals the proven reasons the audio can't be boosted. Reasons are passed in so the
// tooltip only ever lists what actually applies to this case.
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

  // `warn` messages are the honest "out of my hands" cases — audio this add-on
  // physically can't touch — and render in orange. Everything else is a neutral
  // (violet) informational nudge. `reasons`, when set, is the PROVEN list shown
  // behind an info icon; only the definite (DRM) case carries it.
  let message = "";
  let warn = false;
  let reasons = null;

  if (state.drmBlocked) {
    // PROVEN un-boostable: the content script's DRM detector saw this tab attach an
    // EME content key to its audio (see SETTINGS.drm in content.js). Definite, so it
    // gets the plain "can't be boosted" wording plus the reasons behind the info icon.
    warn = true;
    message = STATUS_HINT_SETTINGS.drmBlockedMessage;
    reasons = STATUS_HINT_SETTINGS.drmBlockedReasons;
  } else if (state.tricky) {
    // A known-DRM host, but we haven't yet SEEN it lock its audio this session (e.g.
    // nothing has played). Only a heuristic, so it stays a soft "MAY not work".
    warn = true;
    message = STATUS_HINT_SETTINGS.drmMaybeMessage;
  } else if (tabAudible && !framesHaveMedia) {
    // Sound is coming from the tab, but NO frame we can reach exposes a media
    // element — the audio lives in a frame we can't inject into (a sandboxed or
    // otherwise privileged embed), so it's genuinely out of reach.
    warn = true;
    message = STATUS_HINT_SETTINGS.embeddedPlayerMessage;
  } else if (state.blockedMedia > 0) {
    // Media loaded from another site without CORS: unroutable.
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

// Apply a mutation (set-volume / set-preset / set-eq) to EVERY frame in the tab,
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

// Coalesce a burst of mutating broadcasts into "one in flight, newest wins".
// Callers still update the UI synchronously (so it never lags), but the actual
// message to the tab is collapsed: while one broadcast is in flight, later calls
// only overwrite the pending value instead of queueing. Without this, a fast
// slider drag fires a message per `input` event; the content script drains them
// one by one (each rebuilding the soft-clip curve across every frame), so the
// audio keeps climbing for a beat after you stop. Latest-wins keeps it snappy.
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
    // `settled` = no newer value is queued, so this reply is the final word. UI
    // that moves a control (e.g. the EQ faders) should only follow a settled
    // reply, or a stale one would yank the thumb back mid-drag until the next
    // send lands. Hints, which don't depend on the exact value, can update always.
    onReply?.(reply, pending === null);
    pump(); // send whatever the user asked for while this one was in flight
  }

  return (message, onReply) => {
    pending = { message, onReply };
    pump();
  };
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
    // this tab is silent — collapse the whole section so its top divider doesn't
    // leave a stray line + empty gap between the EQ and the rate section
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
    renderEq(state);
    renderHint(state);
    noteEqGains(state);
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
// A bigger jump for coarse gestures: PageUp/PageDown and Ctrl+mouse-wheel.
const COARSE_STEP = 50;

function clampVolume(value) {
  return Math.min(MAX, Math.max(MIN, value));
}

// Snap a raw value to the nearest 10 %. Used while dragging.
function snapVolume(value) {
  return clampVolume(Math.round(value / STEP) * STEP);
}

// Move one stop up or down. `coarse` (Ctrl held / Page keys) uses the 50 % grid,
// otherwise the fine 10 % grid. Used for keyboard nudges and the wheel.
function stepVolume(from, direction, coarse = false) {
  const size = coarse ? COARSE_STEP : STEP;
  return clampVolume(from + (direction > 0 ? size : -size));
}

// One place to apply a new volume: reflect it in the UI instantly, then tell the
// tab. The send is coalesced (see coalesceBroadcast) so a fast drag never backs
// up a queue of set-volume messages — the tab always converges to the last value.
const sendVolume = coalesceBroadcast();
function commitVolume(percent) {
  const clamped = clampVolume(percent);
  renderVolume(clamped); // instant, every event — the UI must not wait on the tab
  clearRevertSnapshot(); // a hand-moved slider makes any saved "restore" stale (no-op during our own revert)
  sendVolume({ type: "set-volume", value: clamped }, (state) => {
    renderHint(state);
    noteEqGains(state);
  });
}

slider.addEventListener("input", () => {
  commitVolume(snapVolume(Number(slider.value)));
});

// Own the arrow / page / home-end keys so their steps follow the same grid the
// mouse does (native range steps are a single fixed size and can't vary).
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
      return; // let every other key behave normally
  }
  event.preventDefault(); // stop the native single-step move
  commitVolume(next);
});

// Slider hover behaviour (wheel + cursor + click-to-move over a small margin
// around the thin track) lives in slider-hover.js. Wire it up with the helpers
// it needs; it adds no styling of its own.
initSliderHover({ slider, snapVolume, stepVolume, commitVolume });

presetButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    clearRevertSnapshot(); // picking a tone by hand drops any saved "restore" state
    const name = button.dataset.preset;
    const state = await broadcast({ type: "set-preset", name });
    renderPreset(state?.preset ?? name);
    if (state) renderVolume(state.volume);
    renderEq(state);
    renderHint(state);
    noteEqGains(state);
  });
});

// Revert / restore toggle. First click (revert): remember the current volume + tone,
// then drop to 100 % and flatten the EQ; the label flips to "Revert to <that> %".
// Next click (restore): put the remembered volume + tone back and reset the label.
// A manual change to the slider or the tone in between clears the memory (see the
// commit paths above), so the button only ever restores what it itself put away.
revertButton.addEventListener("click", async () => {
  if (revertButton.disabled) return;
  applyingRevert = true; // our own volume/EQ writes must not clear the snapshot
  try {
    let state;
    if (revertSnapshot) {
      // Restore: re-apply the saved tone first (covers custom mixes), then the volume.
      const saved = revertSnapshot;
      revertSnapshot = null;
      await broadcast({ type: "set-eq", eq: saved.eq });
      state = await broadcast({ type: "set-volume", value: saved.volume });
    } else {
      // Revert: snapshot where we are, then go to 100 % + flat tone.
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
    updateRevertButton(); // reflect the new mode/label even if a broadcast returned null
  }
});

// EQ bands: each slider behaves exactly like the volume slider — drag the thumb,
// click in the margin, or mouse-wheel over it. The dB grid mirrors the volume grid.
function clampDb(db) {
  return Math.min(EQ_MAX, Math.max(EQ_MIN, db));
}
function snapDb(db) {
  return clampDb(Math.round(db / EQ_STEP) * EQ_STEP);
}
function stepDb(from, direction) {
  return clampDb(from + (direction > 0 ? EQ_STEP : -EQ_STEP));
}

// Apply a band's new gain: reflect it instantly, tell the tab, then re-sync the
// preset highlight + "Custom" tag from the reply. We send only the band that moved
// (the content script merges it), so the other band stays put.
const sendEq = coalesceBroadcast();
function commitEq(band, input, output, db) {
  const snapped = snapDb(db);
  setFader(input, output, snapped); // instant feedback; the reply confirms it
  clearRevertSnapshot(); // hand-tuning the tone makes any saved "restore" stale
  // Coalesced like the volume send, so dragging a band doesn't queue a message
  // per input event. The content script merges each set-eq, so latest-wins is safe.
  sendEq({ type: "set-eq", eq: { [band]: snapped } }, (state, settled) => {
    if (!state || !settled) return; // ignore stale replies so the fader doesn't jump back
    renderPreset(state.preset);
    renderEq(state);
    renderHint(state);
    noteEqGains(state);
  });
}

// Wire one band (called by buildEqRows for each slider it creates): native
// drag/keyboard fire "input"; slider-hover adds the shared wheel + click-in-margin
// behaviour, using the band row as its hit zone with the EQ's own smaller margin.
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
    // The note appears at the very bottom, so scroll the page down to it.
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
