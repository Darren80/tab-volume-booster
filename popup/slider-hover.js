// Slider hover behaviour, split out of popup.js for cleanliness.
// The slider track is thin, so we treat a few pixels around it as part of the
// control: the wheel, the cursor, and clicks all respond within this margin.
// This file adds NO styling — the slider's look is owned entirely by popup.css.
//
// Every listener is attached to a container that fully surrounds the padded hit
// region on ALL four sides. That matters: .slider-wrap begins flush with the top
// of the track, so a listener there gets no events above the slider (no top hit
// area) and its element edge can disagree with the padded box by a pixel at the
// bottom. The hero has real room above and below, so the cursor and the wheel
// share one consistent region.
//
// ─── Settings ───────────────────────────────────────────────────────────
// The knobs you'd actually change. Everything else below is just wiring.
const SETTINGS = {
  // How many pixels around the thin slider track still count as "on" it, so the
  // wheel / cursor / click work in a small margin instead of only dead-on.
  hitAreaPaddingPixels: 12,

  // The element the listeners sit on. It must be big enough to enclose the
  // slider PLUS hitAreaPaddingPixels on every side (above the track too) — the hero is,
  // the slider-wrap is not. Falls back to .slider-wrap, then the slider.
  hitZoneSelector: ".hero",

  // The circular gauge — a second, wheel-only scroll target.
  dialSelector: ".dial",
};
// ────────────────────────────────────────────────────────────────────────

// Give a horizontal slider the "feels bigger than it looks" behaviour: the wheel,
// the cursor, and click-to-move all work within hitAreaPaddingPixels of the thin
// track. `zone` is the element the listeners sit on — it must enclose the slider
// plus that padding on all four sides. `snap`/`step`/`commit` mirror the volume
// helpers: snap(value)→grid value, step(from, dir)→one notch, commit(value)→apply.
// Reused for the volume slider AND each EQ band, so they all behave identically.
function attachSliderControls({ slider, zone, snap, step, commit, padding }) {
  const pad = padding ?? SETTINGS.hitAreaPaddingPixels;
  const clampFraction = (fraction) => Math.min(1, Math.max(0, fraction));

  // Is the pointer over the slider, or within `pad` of its box? The wheel, the
  // cursor, and click-to-move all share this one test, so their active regions
  // line up exactly on every side.
  function nearSlider(event) {
    if (slider.disabled) return false;
    const box = slider.getBoundingClientRect();
    return (
      event.clientX >= box.left - pad &&
      event.clientX <= box.right + pad &&
      event.clientY >= box.top - pad &&
      event.clientY <= box.bottom + pad
    );
  }

  // Map a pointer X to a snapped value, reading the live range off the slider.
  function valueFromX(clientX) {
    const box = slider.getBoundingClientRect();
    const fraction = clampFraction((clientX - box.left) / box.width);
    return snap(Number(slider.min) + fraction * (Number(slider.max) - Number(slider.min)));
  }

  // One wheel notch = one step (up = more).
  function wheelNudge(event) {
    event.preventDefault(); // don't scroll the popup while adjusting
    const direction = event.deltaY < 0 ? 1 : -1; // wheel up → increase
    commit(step(Number(slider.value), direction));
  }

  zone.addEventListener(
    "wheel",
    (event) => {
      if (!nearSlider(event)) return;
      wheelNudge(event);
    },
    { passive: false }
  );

  // Cursor tracks the same region as the wheel; cleared whenever we're not near.
  zone.addEventListener("pointermove", (event) => {
    zone.style.cursor = nearSlider(event) ? "pointer" : "";
  });
  zone.addEventListener("pointerleave", () => {
    zone.style.cursor = "";
  });

  // Clicking in the margin jumps the slider to that spot; holding lets you drag.
  zone.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target === slider || !nearSlider(event)) {
      return; // left button only; let native handle clicks on the slider itself
    }
    event.preventDefault();
    zone.setPointerCapture(event.pointerId);
    commit(valueFromX(event.clientX));
    const onMove = (moveEvent) => commit(valueFromX(moveEvent.clientX));
    const onUp = () => {
      zone.removeEventListener("pointermove", onMove);
      zone.removeEventListener("pointerup", onUp);
    };
    zone.addEventListener("pointermove", onMove);
    zone.addEventListener("pointerup", onUp);
  });
}

// popup.js calls initSliderHover(...) once it has the volume slider and its helpers.
function initSliderHover({ slider, snapVolume, stepVolume, commitVolume }) {
  const { hitZoneSelector, dialSelector } = SETTINGS;

  const zone =
    slider.closest(hitZoneSelector) || slider.closest(".slider-wrap") || slider;

  // The volume slider gets the shared wheel + cursor + click-to-move behaviour.
  attachSliderControls({
    slider,
    zone,
    snap: snapVolume,
    step: stepVolume,
    commit: commitVolume,
  });

  // One wheel notch on the dial nudges the volume too (dial is wheel-only).
  function wheelNudge(event) {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    commitVolume(stepVolume(Number(slider.value), direction));
  }

  // --- Circular gauge: wheel anywhere inside the ring ---------------------
  // Hit-test against the circle (not its bounding box) so the corners outside
  // the ring don't count. The wheel and the cursor share this one test, so the
  // ↕ cursor appears exactly where scrolling actually adjusts the volume.
  // A wheel here also bubbles to the zone handler above, but that returns early
  // because the dial sits well outside nearSlider.
  const dial = document.querySelector(dialSelector);
  if (dial) {
    // Is the pointer inside the inscribed circle (and the control live)?
    function insideDial(event) {
      if (slider.disabled) return false;
      const dialBox = dial.getBoundingClientRect();
      const radius = dialBox.width / 2;
      const offsetX = event.clientX - (dialBox.left + radius);
      const offsetY = event.clientY - (dialBox.top + radius);
      return Math.hypot(offsetX, offsetY) <= radius;
    }

    dial.addEventListener(
      "wheel",
      (event) => {
        if (!insideDial(event)) return; // outside the circle, or disabled
        wheelNudge(event);
      },
      { passive: false }
    );

    // ns-resize (↕) signals scroll-up/down to change the value — the dial is
    // wheel-only, so "pointer" (click me) would misdescribe it.
    dial.addEventListener("pointermove", (event) => {
      dial.style.cursor = insideDial(event) ? "ns-resize" : "";
    });
    dial.addEventListener("pointerleave", () => {
      dial.style.cursor = "";
    });
  }
}
