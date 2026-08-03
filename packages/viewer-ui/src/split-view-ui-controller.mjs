const ORIENTATIONS = Object.freeze(["horizontal", "vertical"]);
const MINIMUM_RATIO = 0.1;
const MAXIMUM_RATIO = 0.9;
const KEYBOARD_RATIO_STEP = 0.05;
const DIVIDER_SIZE_PX = 6;
const MAXIMUM_LABEL_LENGTH = 256;

export const ViewerSplitViewOrientation = Object.freeze({
  HORIZONTAL: ORIENTATIONS[0],
  VERTICAL: ORIENTATIONS[1],
});

export const AllViewerSplitViewOrientations = ORIENTATIONS;

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function requireElement(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    !value.ownerDocument ||
    typeof value.append !== "function"
  ) {
    throw new TypeError(`${label} must be a DOM element`);
  }
  return value;
}

function normalizeOrientation(value) {
  if (!ORIENTATIONS.includes(value)) {
    throw new TypeError(
      "split-view orientation must be horizontal or vertical",
    );
  }
  return value;
}

function normalizeRatio(value) {
  if (
    !Number.isFinite(value) ||
    value < MINIMUM_RATIO ||
    value > MAXIMUM_RATIO
  ) {
    throw new RangeError(
      `split-view ratio must be between ${MINIMUM_RATIO} and ${MAXIMUM_RATIO}`,
    );
  }
  return value;
}

function normalizeLabel(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_LABEL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function requireCallback(value) {
  if (typeof value !== "function") {
    throw new TypeError(
      "split-view onRatioChange must be a function",
    );
  }
  return value;
}

function clampRatio(value) {
  return Math.min(MAXIMUM_RATIO, Math.max(MINIMUM_RATIO, value));
}

function placement(element) {
  return Object.freeze({
    element,
    parent: element.parentNode ?? null,
    nextSibling: element.nextSibling ?? null,
  });
}

function restorePlacement(value) {
  const { element, parent, nextSibling } = value;
  if (!parent) {
    element.remove?.();
    return;
  }
  if (
    nextSibling &&
    nextSibling.parentNode === parent &&
    typeof parent.insertBefore === "function"
  ) {
    parent.insertBefore(element, nextSibling);
    return;
  }
  parent.append(element);
}

function createPanel(document, side, label, surface) {
  const panel = document.createElement("section");
  panel.setAttribute("data-viewer-split-panel", side);
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", label);
  panel.style.display = "grid";
  panel.style.gridTemplateRows = "auto minmax(0, 1fr)";
  panel.style.minWidth = "0";
  panel.style.minHeight = "0";
  panel.style.overflow = "hidden";

  const heading = document.createElement("div");
  heading.setAttribute("data-viewer-split-label", side);
  heading.textContent = label;

  const viewport = document.createElement("div");
  viewport.setAttribute("data-viewer-split-surface", side);
  viewport.style.position = "relative";
  viewport.style.minWidth = "0";
  viewport.style.minHeight = "0";
  viewport.style.overflow = "hidden";
  viewport.append(surface);

  panel.append(heading, viewport);
  return Object.freeze({ panel, heading, viewport });
}

export class ViewerSplitViewUiController {
  #container;
  #beforeSurface;
  #afterSurface;
  #placements;
  #root;
  #divider;
  #before;
  #after;
  #label;
  #beforeLabel;
  #afterLabel;
  #orientation;
  #ratio;
  #active;
  #onRatioChange;
  #listeners = [];
  #dragging = false;
  #disposed = false;

  constructor({
    container,
    beforeSurface,
    afterSurface,
    label = "Revision comparison",
    beforeLabel = "Before",
    afterLabel = "After",
    orientation = ViewerSplitViewOrientation.HORIZONTAL,
    ratio = 0.5,
    active = true,
    onRatioChange = () => {},
  } = {}) {
    this.#container = requireElement(
      container,
      "split-view container",
    );
    this.#beforeSurface = requireElement(
      beforeSurface,
      "split-view before surface",
    );
    this.#afterSurface = requireElement(
      afterSurface,
      "split-view after surface",
    );
    if (this.#beforeSurface === this.#afterSurface) {
      throw new TypeError(
        "split-view surfaces must be distinct",
      );
    }
    const document = this.#container.ownerDocument;
    if (
      this.#beforeSurface.ownerDocument !== document ||
      this.#afterSurface.ownerDocument !== document ||
      typeof document.createElement !== "function"
    ) {
      throw new TypeError(
        "split-view elements must share one ownerDocument",
      );
    }
    if (typeof active !== "boolean") {
      throw new TypeError(
        "split-view active option must be a boolean",
      );
    }
    this.#label = normalizeLabel(label, "split-view label");
    this.#beforeLabel = normalizeLabel(
      beforeLabel,
      "split-view before label",
    );
    this.#afterLabel = normalizeLabel(
      afterLabel,
      "split-view after label",
    );
    this.#orientation = normalizeOrientation(orientation);
    this.#ratio = normalizeRatio(ratio);
    this.#active = active;
    this.#onRatioChange = requireCallback(onRatioChange);
    this.#placements = Object.freeze([
      placement(this.#beforeSurface),
      placement(this.#afterSurface),
    ]);

    this.#root = document.createElement("section");
    this.#root.setAttribute("data-viewer-split-view", "");
    this.#root.setAttribute("role", "group");
    this.#root.setAttribute("aria-label", this.#label);
    this.#root.style.display = "grid";
    this.#root.style.width = "100%";
    this.#root.style.height = "100%";
    this.#root.style.minWidth = "0";
    this.#root.style.minHeight = "0";

    this.#before = createPanel(
      document,
      "before",
      this.#beforeLabel,
      this.#beforeSurface,
    );
    this.#after = createPanel(
      document,
      "after",
      this.#afterLabel,
      this.#afterSurface,
    );
    this.#divider = document.createElement("div");
    this.#divider.setAttribute("data-viewer-split-divider", "");
    this.#divider.setAttribute("role", "separator");
    this.#divider.setAttribute("tabindex", "0");
    this.#divider.setAttribute("aria-valuemin", "10");
    this.#divider.setAttribute("aria-valuemax", "90");

    this.#root.append(
      this.#before.panel,
      this.#divider,
      this.#after.panel,
    );
    this.#container.append(this.#root);
    this.#listen(this.#divider, "keydown", (event) => {
      this.#onKeyDown(event);
    });
    this.#listen(this.#divider, "pointerdown", (event) => {
      this.#onPointerDown(event);
    });
    this.#listen(this.#root, "pointermove", (event) => {
      this.#onPointerMove(event);
    });
    this.#listen(this.#root, "pointerup", () => {
      this.#dragging = false;
    });
    this.#listen(this.#root, "pointercancel", () => {
      this.#dragging = false;
    });
    this.#applyLayout();
    this.#applyActive();
  }

  get disposed() {
    return this.#disposed;
  }

  get element() {
    this.#assertOpen();
    return this.#root;
  }

  get divider() {
    this.#assertOpen();
    return this.#divider;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState(
        "Viewer split-view UI controller is disposed",
      );
    }
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push({ target, type, listener });
  }

  #applyLayout() {
    const before = String(this.#ratio);
    const after = String(1 - this.#ratio);
    this.#root.setAttribute(
      "data-viewer-split-orientation",
      this.#orientation,
    );
    this.#divider.setAttribute(
      "aria-valuenow",
      String(Math.round(this.#ratio * 100)),
    );
    if (
      this.#orientation === ViewerSplitViewOrientation.HORIZONTAL
    ) {
      this.#root.style.gridTemplateColumns =
        `${before}fr ${DIVIDER_SIZE_PX}px ${after}fr`;
      this.#root.style.gridTemplateRows = "minmax(0, 1fr)";
      this.#divider.setAttribute("aria-orientation", "vertical");
      this.#divider.style.cursor = "col-resize";
    } else {
      this.#root.style.gridTemplateColumns = "minmax(0, 1fr)";
      this.#root.style.gridTemplateRows =
        `${before}fr ${DIVIDER_SIZE_PX}px ${after}fr`;
      this.#divider.setAttribute("aria-orientation", "horizontal");
      this.#divider.style.cursor = "row-resize";
    }
  }

  #applyActive() {
    this.#root.hidden = !this.#active;
    this.#root.setAttribute(
      "aria-hidden",
      String(!this.#active),
    );
  }

  #emitRatioChange(interactive) {
    this.#onRatioChange(
      Object.freeze({
        ratio: this.#ratio,
        orientation: this.#orientation,
        interactive,
      }),
    );
  }

  #onKeyDown(event) {
    let ratio = this.#ratio;
    const decrease =
      this.#orientation === ViewerSplitViewOrientation.HORIZONTAL
        ? event.key === "ArrowLeft"
        : event.key === "ArrowUp";
    const increase =
      this.#orientation === ViewerSplitViewOrientation.HORIZONTAL
        ? event.key === "ArrowRight"
        : event.key === "ArrowDown";
    if (decrease) {
      ratio -= KEYBOARD_RATIO_STEP;
    } else if (increase) {
      ratio += KEYBOARD_RATIO_STEP;
    } else if (event.key === "Home") {
      ratio = MINIMUM_RATIO;
    } else if (event.key === "End") {
      ratio = MAXIMUM_RATIO;
    } else {
      return;
    }
    event.preventDefault?.();
    this.setRatio(clampRatio(ratio), { interactive: true });
  }

  #onPointerDown(event) {
    if (
      event.button !== undefined &&
      event.button !== 0
    ) {
      return;
    }
    this.#dragging = true;
    this.#divider.setPointerCapture?.(event.pointerId);
    event.preventDefault?.();
  }

  #onPointerMove(event) {
    if (!this.#dragging) {
      return;
    }
    const bounds = this.#root.getBoundingClientRect?.();
    if (
      !bounds ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    ) {
      return;
    }
    const ratio =
      this.#orientation === ViewerSplitViewOrientation.HORIZONTAL
        ? (event.clientX - bounds.left) / bounds.width
        : (event.clientY - bounds.top) / bounds.height;
    if (Number.isFinite(ratio)) {
      this.setRatio(clampRatio(ratio), { interactive: true });
    }
  }

  snapshot() {
    this.#assertOpen();
    return Object.freeze({
      active: this.#active,
      orientation: this.#orientation,
      ratio: this.#ratio,
      label: this.#label,
      beforeLabel: this.#beforeLabel,
      afterLabel: this.#afterLabel,
    });
  }

  setRatio(ratio, { interactive = false } = {}) {
    this.#assertOpen();
    if (typeof interactive !== "boolean") {
      throw new TypeError(
        "split-view interactive option must be a boolean",
      );
    }
    const normalized = normalizeRatio(ratio);
    if (normalized === this.#ratio) {
      return this.snapshot();
    }
    this.#ratio = normalized;
    this.#applyLayout();
    this.#emitRatioChange(interactive);
    return this.snapshot();
  }

  setOrientation(orientation) {
    this.#assertOpen();
    const normalized = normalizeOrientation(orientation);
    if (normalized === this.#orientation) {
      return this.snapshot();
    }
    this.#orientation = normalized;
    this.#applyLayout();
    return this.snapshot();
  }

  setLabels({
    label = this.#label,
    beforeLabel = this.#beforeLabel,
    afterLabel = this.#afterLabel,
  } = {}) {
    this.#assertOpen();
    this.#label = normalizeLabel(label, "split-view label");
    this.#beforeLabel = normalizeLabel(
      beforeLabel,
      "split-view before label",
    );
    this.#afterLabel = normalizeLabel(
      afterLabel,
      "split-view after label",
    );
    this.#root.setAttribute("aria-label", this.#label);
    this.#before.panel.setAttribute(
      "aria-label",
      this.#beforeLabel,
    );
    this.#after.panel.setAttribute(
      "aria-label",
      this.#afterLabel,
    );
    this.#before.heading.textContent = this.#beforeLabel;
    this.#after.heading.textContent = this.#afterLabel;
    return this.snapshot();
  }

  setActive(active) {
    this.#assertOpen();
    if (typeof active !== "boolean") {
      throw new TypeError(
        "split-view active state must be a boolean",
      );
    }
    if (active === this.#active) {
      return this.snapshot();
    }
    this.#active = active;
    this.#applyActive();
    return this.snapshot();
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    for (const { target, type, listener } of this.#listeners) {
      target.removeEventListener(type, listener);
    }
    this.#listeners = [];
    this.#dragging = false;
    this.#root.remove?.();
    for (const value of [...this.#placements].reverse()) {
      restorePlacement(value);
    }
    this.#disposed = true;
    return true;
  }
}
