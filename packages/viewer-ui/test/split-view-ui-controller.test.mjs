import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerSplitViewOrientation,
  ViewerSplitViewUiController,
} from "@dwg-viewer/viewer-ui/split-view";

class FakeElement {
  constructor(ownerDocument, tagName = "div") {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.textContent = "";
    this.bounds = {
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
    };
  }

  get nextSibling() {
    if (!this.parentNode) {
      return null;
    }
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] ?? null;
  }

  #detach(child) {
    if (!child.parentNode) {
      return;
    }
    const siblings = child.parentNode.children;
    const index = siblings.indexOf(child);
    if (index >= 0) {
      siblings.splice(index, 1);
    }
    child.parentNode = null;
  }

  append(...children) {
    for (const child of children) {
      this.#detach(child);
      this.children.push(child);
      child.parentNode = this;
    }
  }

  insertBefore(child, reference) {
    const referenceIndex = this.children.indexOf(reference);
    if (referenceIndex < 0) {
      throw new Error("reference is not a child");
    }
    this.#detach(child);
    const nextIndex = this.children.indexOf(reference);
    this.children.splice(nextIndex, 0, child);
    child.parentNode = this;
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    this.parentNode.#detach(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, properties = {}) {
    let prevented = false;
    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {
        prevented = true;
      },
      ...properties,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return prevented;
  }

  getBoundingClientRect() {
    return this.bounds;
  }
}

class FakeDocument {
  createElement(tagName) {
    return new FakeElement(this, tagName);
  }
}

function fixture(options = {}) {
  const document = new FakeDocument();
  const originalParent = document.createElement("main");
  const container = document.createElement("aside");
  const prefix = document.createElement("div");
  const before = document.createElement("canvas");
  const middle = document.createElement("div");
  const after = document.createElement("canvas");
  const suffix = document.createElement("div");
  originalParent.append(prefix, before, middle, after, suffix);
  const changes = [];
  const controller = new ViewerSplitViewUiController({
    container,
    beforeSurface: before,
    afterSurface: after,
    onRatioChange(change) {
      changes.push(change);
    },
    ...options,
  });
  return {
    after,
    before,
    changes,
    container,
    controller,
    middle,
    originalParent,
    prefix,
    suffix,
  };
}

test("composes two distinct surfaces into an accessible split layout", () => {
  const value = fixture();
  const root = value.controller.element;
  const [beforePanel, divider, afterPanel] = root.children;

  assert.equal(value.container.children[0], root);
  assert.equal(
    root.getAttribute("data-viewer-split-orientation"),
    ViewerSplitViewOrientation.HORIZONTAL,
  );
  assert.equal(root.getAttribute("role"), "group");
  assert.equal(root.getAttribute("aria-hidden"), "false");
  assert.equal(root.hidden, false);
  assert.equal(root.style.display, "grid");
  assert.equal(
    root.style.gridTemplateColumns,
    "0.5fr 6px 0.5fr",
  );
  assert.equal(
    beforePanel.getAttribute("data-viewer-split-panel"),
    "before",
  );
  assert.equal(
    afterPanel.getAttribute("data-viewer-split-panel"),
    "after",
  );
  assert.equal(beforePanel.children[1].children[0], value.before);
  assert.equal(afterPanel.children[1].children[0], value.after);
  assert.notEqual(
    beforePanel.children[1],
    afterPanel.children[1],
  );
  assert.equal(divider.getAttribute("role"), "separator");
  assert.equal(
    divider.getAttribute("aria-orientation"),
    "vertical",
  );
  assert.equal(divider.getAttribute("aria-valuenow"), "50");
});

test("updates ratio, orientation, labels, and visibility without replacing surfaces", () => {
  const value = fixture();
  const root = value.controller.element;
  const beforeViewport = root.children[0].children[1];
  const afterViewport = root.children[2].children[1];

  value.controller.setRatio(0.6);
  assert.equal(
    root.style.gridTemplateColumns,
    "0.6fr 6px 0.4fr",
  );
  assert.deepEqual(value.changes, [
    {
      ratio: 0.6,
      orientation: ViewerSplitViewOrientation.HORIZONTAL,
      interactive: false,
    },
  ]);

  value.controller.setOrientation(
    ViewerSplitViewOrientation.VERTICAL,
  );
  assert.equal(root.style.gridTemplateColumns, "minmax(0, 1fr)");
  assert.equal(
    root.style.gridTemplateRows,
    "0.6fr 6px 0.4fr",
  );
  assert.equal(
    value.controller.divider.getAttribute("aria-orientation"),
    "horizontal",
  );
  value.controller.setLabels({
    label: "Base and preview",
    beforeLabel: "Base",
    afterLabel: "Preview",
  });
  assert.equal(root.getAttribute("aria-label"), "Base and preview");
  assert.equal(root.children[0].getAttribute("aria-label"), "Base");
  assert.equal(root.children[2].getAttribute("aria-label"), "Preview");

  value.controller.setActive(false);
  assert.equal(root.hidden, true);
  assert.equal(root.getAttribute("aria-hidden"), "true");
  assert.equal(beforeViewport.children[0], value.before);
  assert.equal(afterViewport.children[0], value.after);
});

test("supports keyboard and pointer divider interaction within bounded ratios", () => {
  const value = fixture();
  const root = value.controller.element;
  const divider = value.controller.divider;

  assert.equal(
    divider.dispatch("keydown", { key: "ArrowRight" }),
    true,
  );
  assert.equal(value.controller.snapshot().ratio, 0.55);
  assert.equal(value.changes.at(-1).interactive, true);

  divider.dispatch("keydown", { key: "End" });
  assert.equal(value.controller.snapshot().ratio, 0.9);
  divider.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(value.controller.snapshot().ratio, 0.9);

  divider.dispatch("pointerdown", {
    button: 0,
    pointerId: 3,
  });
  root.dispatch("pointermove", {
    clientX: 250,
    clientY: 100,
  });
  assert.equal(value.controller.snapshot().ratio, 0.25);
  root.dispatch("pointerup");
  root.dispatch("pointermove", {
    clientX: 800,
    clientY: 100,
  });
  assert.equal(value.controller.snapshot().ratio, 0.25);
});

test("restores both original surface placements and listeners on disposal", () => {
  const value = fixture();
  const divider = value.controller.divider;
  const root = value.controller.element;

  assert.equal(value.controller.dispose(), true);
  assert.deepEqual(value.originalParent.children, [
    value.prefix,
    value.before,
    value.middle,
    value.after,
    value.suffix,
  ]);
  assert.deepEqual(value.container.children, []);
  assert.equal(
    [...divider.listeners.values()].every(
      (listeners) => listeners.size === 0,
    ),
    true,
  );
  assert.equal(
    [...root.listeners.values()].every(
      (listeners) => listeners.size === 0,
    ),
    true,
  );
  assert.equal(value.controller.dispose(), false);
  assert.throws(() => value.controller.snapshot(), /disposed/u);
});

test("rejects shared surfaces and invalid layout inputs", () => {
  const document = new FakeDocument();
  const container = document.createElement("div");
  const surface = document.createElement("canvas");

  assert.throws(
    () =>
      new ViewerSplitViewUiController({
        container,
        beforeSurface: surface,
        afterSurface: surface,
      }),
    /must be distinct/u,
  );
  assert.throws(
    () => fixture({ ratio: 0.95 }),
    /ratio must be between/u,
  );
  assert.throws(
    () => fixture({ orientation: "diagonal" }),
    /must be horizontal or vertical/u,
  );
});
