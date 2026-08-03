import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VIEWER_RESULT_ROWS,
  ViewerReviewUiController,
  createViewerResultModel,
} from "../src/index.mjs";

class FakeClassList {
  values = new Set();

  toggle(value, force) {
    if (force) {
      this.values.add(value);
    } else {
      this.values.delete(value);
    }
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeElement {
  constructor(ownerDocument, { dataset = {} } = {}) {
    this.ownerDocument = ownerDocument;
    this.dataset = { ...dataset };
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.queries = new Map();
    this.textContent = "";
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    const event = { currentTarget: this, target: this, type };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  querySelectorAll(selector) {
    return this.queries.get(selector) ?? [];
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  createElement() {
    return new FakeElement(this);
  }

  createDocumentFragment() {
    return new FakeElement(this);
  }
}

function makeFixture(callbacks = {}) {
  const document = new FakeDocument();
  const canvas = new FakeElement(document);
  const toolbar = new FakeElement(document);
  const result = new FakeElement(document);
  const title = new FakeElement(document);
  const content = new FakeElement(document);
  const actionContainer = new FakeElement(document);
  const select = new FakeElement(document, {
    dataset: { reviewTool: "select" },
  });
  const path = new FakeElement(document, {
    dataset: { reviewTool: "path" },
  });
  const finish = new FakeElement(document, {
    dataset: { reviewAction: "finish" },
  });
  const clear = new FakeElement(document, {
    dataset: { reviewAction: "clear" },
  });
  const close = new FakeElement(document, {
    dataset: { reviewAction: "close" },
  });
  const isolate = new FakeElement(document, {
    dataset: { reviewAction: "isolate-layer" },
  });
  const restore = new FakeElement(document, {
    dataset: { reviewAction: "restore-layers" },
  });

  toolbar.queries.set("[data-review-tool]", [select, path]);
  toolbar.queries.set("[data-review-action]", [finish, clear]);
  toolbar.queries.set("[data-review-action='finish']", [finish]);
  toolbar.queries.set("button", [select, path, finish, clear]);
  result.queries.set("[data-review-title]", [title]);
  result.queries.set("[data-review-content]", [content]);
  result.queries.set("[data-review-result-actions]", [actionContainer]);
  result.queries.set(
    "[data-review-action]",
    [close, isolate, restore],
  );
  actionContainer.queries.set(
    "[data-review-action]",
    [isolate, restore],
  );

  const controller = new ViewerReviewUiController({
    canvas,
    toolbar,
    result,
    ...callbacks,
  });
  return {
    actionContainer,
    canvas,
    clear,
    close,
    content,
    controller,
    finish,
    isolate,
    path,
    result,
    restore,
    select,
    title,
    toolbar,
  };
}

test("normalizes a bounded source-neutral result model", () => {
  const model = createViewerResultModel({
    title: "Object",
    rows: [["Kind", "Line"]],
    actions: [
      {
        id: "isolate-layer",
        data: { layerIndex: 3 },
      },
    ],
    view: "selection",
  });

  assert.deepEqual(model, {
    title: "Object",
    rows: [["Kind", "Line"]],
    actions: [
      {
        id: "isolate-layer",
        data: { layerIndex: "3" },
      },
    ],
    view: "selection",
  });
  assert.equal(Object.isFrozen(model), true);
  assert.throws(
    () =>
      createViewerResultModel({
        title: "Too many",
        rows: Array.from(
          { length: MAX_VIEWER_RESULT_ROWS + 1 },
          () => ["a", "b"],
        ),
      }),
    /rows exceeds/u,
  );
  assert.throws(
    () =>
      createViewerResultModel({
        title: "Duplicate",
        actions: [{ id: "clear" }, { id: "clear" }],
      }),
    /unique ids/u,
  );
});

test("owns tool accessibility state and emits product-neutral actions", () => {
  const requests = [];
  const actions = [];
  const fixture = makeFixture({
    onToolRequest(tool) {
      requests.push(tool);
    },
    onAction(action) {
      actions.push(action);
    },
  });

  fixture.path.dispatch("click");
  fixture.finish.dispatch("click");
  fixture.close.dispatch("click");
  assert.deepEqual(requests, ["path"]);
  assert.deepEqual(actions, ["finish", "close"]);

  assert.equal(fixture.controller.setActiveTool("path"), true);
  assert.equal(fixture.path.getAttribute("aria-pressed"), "true");
  assert.equal(fixture.select.getAttribute("aria-pressed"), "false");
  assert.equal(fixture.finish.hidden, false);
  assert.equal(fixture.canvas.classList.contains("reviewing"), true);

  fixture.controller.resetTools();
  assert.equal(fixture.path.getAttribute("aria-pressed"), "false");
  assert.equal(fixture.finish.hidden, true);
  assert.equal(fixture.canvas.classList.contains("reviewing"), false);

  fixture.controller.setEnabled(false);
  assert.equal(fixture.toolbar.hidden, true);
  assert.equal(fixture.select.disabled, true);
  assert.equal(fixture.clear.disabled, true);
});

test("renders text-only rows and generic result actions", () => {
  const fixture = makeFixture();
  const model = fixture.controller.showResult({
    title: "Selected object",
    rows: [
      ["Kind", "TEXT"],
      ["Value", "<script>not markup</script>"],
    ],
    actions: [
      {
        id: "isolate-layer",
        data: { layerIndex: 7 },
      },
      { id: "restore-layers" },
    ],
  });

  assert.equal(fixture.result.hidden, false);
  assert.equal(fixture.title.textContent, "Selected object");
  assert.equal(fixture.content.children.length, 1);
  const fragment = fixture.content.children[0];
  assert.equal(fragment.children[0].children[0].textContent, "Kind");
  assert.equal(fragment.children[1].children[1].textContent, "<script>not markup</script>");
  assert.equal(fixture.actionContainer.hidden, false);
  assert.equal(fixture.isolate.hidden, false);
  assert.equal(fixture.isolate.dataset.layerIndex, "7");
  assert.equal(fixture.restore.hidden, false);
  assert.equal(model.rows.length, 2);

  fixture.controller.showResult({
    title: "Measurement",
    rows: [["Length", "5 mm"]],
  });
  assert.equal(fixture.actionContainer.hidden, true);
  assert.equal(fixture.isolate.hidden, true);
  assert.equal("layerIndex" in fixture.isolate.dataset, false);
});

test("supports custom content and disposes listeners idempotently", () => {
  const requests = [];
  const fixture = makeFixture({
    onToolRequest(tool) {
      requests.push(tool);
    },
  });
  const form = new FakeElement(fixture.result.ownerDocument);

  fixture.controller.showContent({
    title: "Settings",
    content: form,
    view: "measurement-settings",
  });
  assert.equal(fixture.content.children[0], form);
  assert.equal(fixture.result.dataset.reviewView, "measurement-settings");

  fixture.controller.setActiveTool("select");
  assert.equal(fixture.controller.dispose(), true);
  assert.equal(fixture.controller.dispose(), false);
  assert.equal(fixture.toolbar.hidden, true);
  assert.equal(fixture.result.hidden, true);
  assert.equal(fixture.select.getAttribute("aria-pressed"), "false");

  fixture.select.dispatch("click");
  assert.deepEqual(requests, []);
  assert.throws(
    () => fixture.controller.setEnabled(true),
    /disposed/u,
  );
});
