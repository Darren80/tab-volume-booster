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

// popup.js calls initSliderHover(...) once it has the slider and its helpers.
function initSliderHover({ slider, snapVolume, stepVolume, commitVolume }) {
  const { hitAreaPaddingPixels, hitZoneSelector, dialSelector } = SETTINGS;

  const zone =
    slider.closest(hitZoneSelector) || slider.closest(".slider-wrap") || slider;

  const clampFraction = (fraction) => Math.min(1, Math.max(0, fraction));

  // Is the pointer over the slider, or within hitAreaPaddingPixels of its box? The wheel,
  // the cursor, and click-to-move all share this one test, so their active
  // regions line up exactly on every side.
  function nearSlider(event) {
    if (slider.disabled) return false;
    const sliderBox = slider.getBoundingClientRect();
    return (
      event.clientX >= sliderBox.left - hitAreaPaddingPixels &&
      event.clientX <= sliderBox.right + hitAreaPaddingPixels &&
      event.clientY >= sliderBox.top - hitAreaPaddingPixels &&
      event.clientY <= sliderBox.bottom + hitAreaPaddingPixels
    );
  }

  // Map a pointer X to a snapped volume, reading the live range off the slider.
  function volumeFromX(clientX) {
    const sliderBox = slider.getBoundingClientRect();
    const fraction = clampFraction((clientX - sliderBox.left) / sliderBox.width);
    const rangeMin = Number(slider.min);
    const rangeMax = Number(slider.max);
    return snapVolume(rangeMin + fraction * (rangeMax - rangeMin));
  }

  // One wheel notch = one step (up = louder). Shared by the slider and the dial.
  function wheelNudge(event) {
    event.preventDefault(); // don't scroll the popup while adjusting
    const direction = event.deltaY < 0 ? 1 : -1; // wheel up → louder
    commitVolume(stepVolume(Number(slider.value), direction));
  }

  // --- Slider: wheel + cursor + click over the padded hit region ----------

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
    commitVolume(volumeFromX(event.clientX));
    const onMove = (moveEvent) => commitVolume(volumeFromX(moveEvent.clientX));
    const onUp = () => {
      zone.removeEventListener("pointermove", onMove);
      zone.removeEventListener("pointerup", onUp);
    };
    zone.addEventListener("pointermove", onMove);
    zone.addEventListener("pointerup", onUp);
  });

  // --- Circular gauge: wheel anywhere inside the ring ---------------------
  // Hit-test against the circle (not its bounding box) so the corners outside
  // the ring don't count. A wheel here also bubbles to the zone handler above,
  // but that returns early because the dial sits well outside nearSlider.
  const dial = document.querySelector(dialSelector);
  if (dial) {
    dial.addEventListener(
      "wheel",
      (event) => {
        if (slider.disabled) return;
        const dialBox = dial.getBoundingClientRect();
        const radiusX = dialBox.width / 2;
        const radiusY = dialBox.height / 2;
        const offsetX = event.clientX - (dialBox.left + radiusX);
        const offsetY = event.clientY - (dialBox.top + radiusY);
        if (Math.hypot(offsetX, offsetY) > radiusX) return; // outside the circle
        wheelNudge(event);
      },
      { passive: false }
    );
  }
}
