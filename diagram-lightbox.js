(() => {
  const lightbox = document.querySelector("[data-diagram-lightbox]");
  if (!lightbox) return;

  const canvas = lightbox.querySelector("[data-diagram-lightbox-canvas]");
  const stage = lightbox.querySelector("[data-diagram-lightbox-stage]");
  const closeButton = lightbox.querySelector("[data-diagram-lightbox-close]");
  const zoomIn = lightbox.querySelector("[data-diagram-zoom-in]");
  const zoomOut = lightbox.querySelector("[data-diagram-zoom-out]");
  const scaleLabel = lightbox.querySelector("[data-diagram-scale]");
  const pointers = new Map();
  const padding = 16;
  const maxScale = 8;
  let activeDiagram = null;
  let scale = 1;
  let x = 0;
  let y = 0;
  let fitted = true;

  const fitScale = () => Math.min(
    Math.max(1, canvas.clientWidth - padding * 2) / activeDiagram.width,
    Math.max(1, canvas.clientHeight - padding * 2) / activeDiagram.height,
    1
  );
  const minScale = () => Math.min(.1, fitScale() / 2);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const constrainOffset = (offset, size, available) => size <= available - padding * 2
    ? (available - size) / 2
    : clamp(offset, available - padding - size, padding);

  const render = () => {
    if (!activeDiagram) return;
    x = constrainOffset(x, activeDiagram.width * scale, canvas.clientWidth);
    y = constrainOffset(y, activeDiagram.height * scale, canvas.clientHeight);
    stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    scaleLabel.value = `${Math.round(scale * 100)}%`;
    zoomOut.disabled = scale <= minScale();
    zoomIn.disabled = scale >= maxScale;
  };

  const fit = () => {
    if (!activeDiagram) return;
    fitted = true;
    scale = fitScale();
    x = (canvas.clientWidth - activeDiagram.width * scale) / 2;
    y = (canvas.clientHeight - activeDiagram.height * scale) / 2;
    render();
  };

  // Keep the diagram point under the cursor (or pinch midpoint) in place.
  const zoomAt = (nextScale, origin, destination = origin) => {
    if (!activeDiagram) return;
    const next = clamp(nextScale, minScale(), maxScale);
    x = destination.x - (origin.x - x) * next / scale;
    y = destination.y - (origin.y - y) * next / scale;
    scale = next;
    fitted = false;
    render();
  };
  const center = () => ({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 });
  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  document.querySelectorAll("[data-diagram-preview]").forEach((preview) => {
    preview.addEventListener("click", () => {
      const svg = preview.querySelector(".mermaid[data-diagram-ready] svg");
      if (!svg || lightbox.open) return;
      const bounds = svg.viewBox.baseVal;
      const rect = svg.getBoundingClientRect();
      const width = bounds.width || rect.width;
      const height = bounds.height || rect.height;
      if (!width || !height) return;

      const placeholder = document.createComment("diagram-placeholder");
      // Preserve the article's layout while its SVG is in the dialog.
      const previewStyle = preview.getAttribute("style");
      preview.style.height = `${preview.getBoundingClientRect().height}px`;
      svg.before(placeholder);
      activeDiagram = { svg, placeholder, preview, previewStyle, width, height };
      stage.style.width = `${width}px`;
      stage.style.height = `${height}px`;
      stage.append(svg);
      document.body.classList.add("diagram-lightbox-open");
      lightbox.showModal();
      fit();
      canvas.focus({ preventScroll: true });
    });
  });

  zoomIn.addEventListener("click", () => zoomAt(scale * 1.25, center()));
  zoomOut.addEventListener("click", () => zoomAt(scale / 1.25, center()));
  lightbox.querySelector("[data-diagram-fit]").addEventListener("click", fit);

  lightbox.addEventListener("wheel", (event) => {
    if (!activeDiagram) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    const delta = clamp(event.deltaY * unit, -100, 100);
    const origin = canvas.contains(event.target) ? localPoint(event) : center();
    zoomAt(scale * Math.exp(-delta * .002), origin);
  }, { passive: false });

  const gesture = () => {
    const [first, second] = [...pointers.values()];
    if (!second) return { point: first, distance: 0 };
    return {
      point: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      distance: Math.hypot(second.x - first.x, second.y - first.y)
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (!activeDiagram || event.button !== 0 || pointers.size >= 2) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    pointers.set(event.pointerId, localPoint(event));
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    const before = gesture();
    pointers.set(event.pointerId, localPoint(event));
    const after = gesture();
    const ratio = before.distance && after.distance ? after.distance / before.distance : 1;
    zoomAt(scale * ratio, before.point, after.point);
  });
  const releasePointer = (event) => {
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.classList.toggle("is-dragging", pointers.size > 0);
  };
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    canvas.addEventListener(type, releasePointer);
  });

  lightbox.addEventListener("keydown", (event) => {
    if (!activeDiagram || event.altKey) return;
    if (event.key === "+" || event.key === "=") {
      zoomAt(scale * 1.25, center());
    } else if (event.key === "-") {
      zoomAt(scale / 1.25, center());
    } else if (event.key === "0") {
      fit();
    } else if (event.key === "1" && !event.ctrlKey && !event.metaKey) {
      zoomAt(1, center());
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !event.ctrlKey && !event.metaKey) {
      x += event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0;
      y += event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0;
      fitted = false;
      render();
    } else {
      return;
    }
    event.preventDefault();
  });

  new ResizeObserver(() => {
    if (!activeDiagram || !lightbox.open) return;
    if (fitted) fit();
    else {
      scale = clamp(scale, minScale(), maxScale);
      render();
    }
  }).observe(canvas);

  closeButton.addEventListener("click", () => lightbox.close());
  // Close on an empty-background click, while keeping drags and pinches open.
  const onBackdrop = (event) => event.target === lightbox || event.target === canvas;
  let backdropPress = null;
  lightbox.addEventListener("pointerdown", (event) => {
    backdropPress = onBackdrop(event) && event.button === 0 && pointers.size <= 1
      ? { x: event.clientX, y: event.clientY } : null;
  });
  lightbox.addEventListener("pointermove", (event) => {
    if (backdropPress && Math.hypot(event.clientX - backdropPress.x, event.clientY - backdropPress.y) > 5) {
      backdropPress = null;
    }
  });
  lightbox.addEventListener("pointercancel", () => { backdropPress = null; });
  lightbox.addEventListener("click", (event) => {
    if (backdropPress && onBackdrop(event)) lightbox.close();
    backdropPress = null;
  });
  lightbox.addEventListener("close", () => {
    for (const pointerId of pointers.keys()) {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    }
    pointers.clear();
    backdropPress = null;
    canvas.classList.remove("is-dragging");
    if (activeDiagram) {
      const { svg, placeholder, preview, previewStyle } = activeDiagram;
      placeholder.replaceWith(svg);
      if (previewStyle === null) preview.removeAttribute("style");
      else preview.setAttribute("style", previewStyle);
      activeDiagram = null;
      stage.removeAttribute("style");
      preview.querySelector("button").focus({ preventScroll: true });
    }
    document.body.classList.remove("diagram-lightbox-open");
  });
})();
