// Slider hover behaviour, split out of popup.js for cleanliness.
// The slider track is thin (9 px), so we treat a few pixels around it as part of
// the control: the wheel, the cursor, and clicks all respond within this margin.
// This file adds NO styling — the slider's look is owned entirely by popup.css.
//
// popup.js calls initSliderHover(...) once it has the slider and its helpers.
function initSliderHover({ slider, snapVol, stepVol, commitVolume }) {
  const SLIDER_PAD = 12; // px of slack around the slider's box
  const zone = slider.closest(".slider-wrap") || slider;

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

  // Map a pointer X to a snapped volume, reading the live range off the slider.
  function volFromX(clientX) {
    const r = slider.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const min = Number(slider.min);
    const max = Number(slider.max);
    return snapVol(min + frac * (max - min));
  }

  // Scroll wheel nudges one 10 % stop per notch (up = louder).
  zone.addEventListener(
    "wheel",
    (event) => {
      if (!nearSlider(event)) return;
      event.preventDefault(); // don't scroll the popup while adjusting
      commitVolume(stepVol(Number(slider.value), event.deltaY < 0 ? +1 : -1));
    },
    { passive: false }
  );

  // Show the slider cursor throughout the margin, not just on the thin track.
  zone.addEventListener("pointermove", (event) => {
    zone.style.cursor = nearSlider(event) ? "pointer" : "";
  });
  zone.addEventListener("pointerleave", () => {
    zone.style.cursor = "";
  });

  // Clicking in the margin jumps the slider to that spot; holding lets you drag.
  zone.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target === slider || !nearSlider(event)) return;
    event.preventDefault();
    zone.setPointerCapture(event.pointerId);
    commitVolume(volFromX(event.clientX));
    const onMove = (e) => commitVolume(volFromX(e.clientX));
    const onUp = () => {
      zone.removeEventListener("pointermove", onMove);
      zone.removeEventListener("pointerup", onUp);
    };
    zone.addEventListener("pointermove", onMove);
    zone.addEventListener("pointerup", onUp);
  });
}
