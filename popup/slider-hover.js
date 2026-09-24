// Slider hover behaviour: the wheel, cursor and click-to-move also work in a small margin
// around the thin track. No styling here — that's popup.css.

const SETTINGS = {
  hitAreaPaddingPixels: 12, // margin around the track that still counts as "on" it
  // Element the listeners sit on. Must enclose the slider plus the padding on every side
  // (.slider-wrap doesn't: it's flush with the track's top).
  hitZoneSelector: ".hero",
  dialSelector: ".dial",
  dialDragPixelsPerStep: 4, // vertical drag on the dial per volume step (lower = more sensitive)
};

// zone must enclose the slider plus padding. snap(value), step(from, direction), commit(value).
// Used for the volume slider and each EQ band.
function attachSliderControls({ slider, zone, snap, step, commit, padding }) {
  const pad = padding ?? SETTINGS.hitAreaPaddingPixels;
  const clampFraction = (fraction) => Math.min(1, Math.max(0, fraction));

  // Shared by wheel, cursor and click so their regions line up.
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

  function valueFromX(clientX) {
    const box = slider.getBoundingClientRect();
    const fraction = clampFraction((clientX - box.left) / box.width);
    return snap(Number(slider.min) + fraction * (Number(slider.max) - Number(slider.min)));
  }

  // One notch = one step; Ctrl = coarse.
  function wheelNudge(event) {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    commit(step(Number(slider.value), direction, event.ctrlKey));
  }

  zone.addEventListener(
    "wheel",
    (event) => {
      if (!nearSlider(event)) return;
      wheelNudge(event);
    },
    { passive: false }
  );

  zone.addEventListener("pointermove", (event) => {
    zone.style.cursor = nearSlider(event) ? "pointer" : "";
  });
  zone.addEventListener("pointerleave", () => {
    zone.style.cursor = "";
  });

  // Clicking in the margin jumps there; holding drags.
  zone.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target === slider || !nearSlider(event)) {
      return; // left button only; native handles clicks on the slider itself
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

function initSliderHover({ slider, snapVolume, stepVolume, commitVolume }) {
  const { hitZoneSelector, dialSelector } = SETTINGS;

  const zone =
    slider.closest(hitZoneSelector) || slider.closest(".slider-wrap") || slider;

  attachSliderControls({
    slider,
    zone,
    snap: snapVolume,
    step: stepVolume,
    commit: commitVolume,
  });

  function wheelNudge(event) {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    commitVolume(stepVolume(Number(slider.value), direction, event.ctrlKey));
  }

  // --- Dial: wheel and vertical drag inside the circle (not its bounding box) ---
  const dial = document.querySelector(dialSelector);
  if (dial) {
    function insideDial(event) {
      if (slider.disabled) return false;
      const dialBox = dial.getBoundingClientRect();
      const radius = dialBox.width / 2;
      const offsetX = event.clientX - (dialBox.left + radius);
      const offsetY = event.clientY - (dialBox.top + radius);
      return Math.hypot(offsetX, offsetY) <= radius;
    }

    let dialDragging = false;
    let dialDragStartY = 0;
    let dialDragStartVolume = 0;

    dial.addEventListener(
      "wheel",
      (event) => {
        if (!insideDial(event)) return;
        wheelNudge(event);
      },
      { passive: false }
    );

    dial.addEventListener("pointermove", (event) => {
      if (!dialDragging) dial.style.cursor = insideDial(event) ? "ns-resize" : "";
    });
    dial.addEventListener("pointerleave", () => {
      if (!dialDragging) dial.style.cursor = "";
    });

    dial.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !insideDial(event)) return;
      event.preventDefault();
      dial.setPointerCapture(event.pointerId);
      dialDragging = true;
      dialDragStartY = event.clientY;
      dialDragStartVolume = Number(slider.value);
      dial.style.cursor = "grabbing";
    });

    dial.addEventListener("pointermove", (event) => {
      if (!dialDragging) return;
      const deltaPixels = dialDragStartY - event.clientY; // up is positive
      const deltaSteps = Math.round(deltaPixels / SETTINGS.dialDragPixelsPerStep);
      const step = Number(slider.step) || 10;
      commitVolume(snapVolume(dialDragStartVolume + deltaSteps * step));
    });

    dial.addEventListener("pointerup", (event) => {
      if (!dialDragging) return;
      dialDragging = false;
      dial.style.cursor = insideDial(event) ? "ns-resize" : "";
    });

    dial.addEventListener("lostpointercapture", () => {
      dialDragging = false;
      dial.style.cursor = "";
    });
  }
}
