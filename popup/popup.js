// Tab Volume Booster - popup logic.
// The popup owns the UI. It injects the content script into the active tab on
// demand (activeTab grant) and talks to it over runtime messaging.

const api = typeof browser !== "undefined" ? browser : chrome;

const MAX = 600;
const STEP = 10;

const slider = document.getElementById("volume");
const readout = document.getElementById("volumeReadout");
const resetButton = document.getElementById("reset");
const presetButtons = [...document.querySelectorAll(".preset")];
const tip = document.getElementById("tip");
const tipToggle = document.getElementById("tipToggle");
const tipClose = document.getElementById("tipClose");
const tabsEmpty = document.getElementById("tabsEmpty");
const tabsList = document.getElementById("tabsList");
const statusHint = document.getElementById("statusHint");

let activeTabId = null;
let currentPreset = "default";

function setControlsEnabled(enabled) {
  slider.disabled = !enabled;
  presetButtons.forEach((b) => (b.disabled = !enabled));
  resetButton.disabled = !enabled || Number(slider.value) === 100;
}

function renderVolume(percent) {
  slider.value = percent;
  readout.textContent = `Volume: ${percent} %`;
  slider.style.setProperty("--fill", `${(percent / MAX) * 100}%`);
  resetButton.disabled = slider.disabled || percent === 100;
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
  if (state.pending) {
    message = "Click anywhere on the page once to activate the boost.";
  } else if (state.blockedMedia > 0) {
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

async function init() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;

  await renderAudibleTabs();

  const injected = tab ? await ensureInjected(tab.id) : false;
  if (!injected) {
    setControlsEnabled(false);
    readout.textContent = "Can't control audio here";
    return;
  }

  const state = await send({ type: "get-state" });
  if (!state?.ok) {
    setControlsEnabled(false);
    readout.textContent = "Can't control audio here";
    return;
  }

  setControlsEnabled(true);
  renderVolume(state.volume);
  renderPreset(state.preset);
  renderHint(state);
}

// --- Event wiring -------------------------------------------------------

slider.addEventListener("input", async () => {
  const percent = Number(slider.value);
  renderVolume(percent);
  renderHint(await send({ type: "set-volume", value: percent }));
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

// Arrow keys anywhere in the popup nudge the volume.
document.addEventListener("keydown", async (event) => {
  if (slider.disabled) return;
  let delta = 0;
  if (event.key === "ArrowUp" || event.key === "ArrowRight") delta = STEP;
  else if (event.key === "ArrowDown" || event.key === "ArrowLeft") delta = -STEP;
  else return;

  event.preventDefault();
  const percent = Math.min(MAX, Math.max(0, Number(slider.value) + delta));
  renderVolume(percent);
  renderHint(await send({ type: "set-volume", value: percent }));
});

// Tip visibility (remembered across opens).
tipToggle.addEventListener("click", () => setTipHidden(!tip.hidden ? true : false));
tipClose.addEventListener("click", () => setTipHidden(true));

function setTipHidden(hidden) {
  tip.hidden = hidden;
  try {
    api.storage.local.set({ tipHidden: hidden });
  } catch (err) {
    /* storage may be unavailable in private windows */
  }
}

async function restoreTip() {
  try {
    const { tipHidden } = await api.storage.local.get("tipHidden");
    tip.hidden = Boolean(tipHidden);
  } catch (err) {
    tip.hidden = false;
  }
}

restoreTip();
init();
