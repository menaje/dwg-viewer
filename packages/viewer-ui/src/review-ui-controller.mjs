const MAX_VIEWER_RESULT_ROWS = 128;
const MAX_VIEWER_RESULT_ACTIONS = 16;
const MAX_RESULT_TITLE_LENGTH = 160;
const MAX_RESULT_LABEL_LENGTH = 160;
const MAX_RESULT_VALUE_LENGTH = 2_048;
const MAX_RESULT_DATA_LENGTH = 256;

const SELECTORS = Object.freeze({
  action: "[data-review-action]",
  actionContainer: "[data-review-result-actions]",
  content: "[data-review-content]",
  finish: "[data-review-action='finish']",
  title: "[data-review-title]",
  tool: "[data-review-tool]",
});

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const DATA_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/u;

function boundedText(value, name, maximum, { empty = true } = {}) {
  const text = String(value ?? "");
  if ((!empty && text.length === 0) || text.length > maximum) {
    throw new TypeError(
      `${name} must contain ${empty ? "at most" : "between 1 and"} ${maximum} characters`,
    );
  }
  return text;
}

function normalizedIdentifier(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) {
    return null;
  }
  const identifier = String(value ?? "");
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError(`${name} must be a bounded kebab-case identifier`);
  }
  return identifier;
}

function normalizedAction(action, index) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError(`actions[${index}] must be an object`);
  }
  const id = normalizedIdentifier(action.id, `actions[${index}].id`);
  const inputData = action.data ?? {};
  if (
    !inputData ||
    typeof inputData !== "object" ||
    Array.isArray(inputData)
  ) {
    throw new TypeError(`actions[${index}].data must be an object`);
  }
  const entries = Object.entries(inputData);
  if (entries.length > 8) {
    throw new RangeError(`actions[${index}].data exceeds 8 fields`);
  }
  const data = {};
  for (const [key, value] of entries) {
    if (!DATA_KEY_PATTERN.test(key)) {
      throw new TypeError(
        `actions[${index}].data contains an invalid dataset key`,
      );
    }
    data[key] = boundedText(
      value,
      `actions[${index}].data.${key}`,
      MAX_RESULT_DATA_LENGTH,
    );
  }
  return Object.freeze({
    id,
    data: Object.freeze(data),
  });
}

function normalizedRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("rows must be an array");
  }
  if (rows.length > MAX_VIEWER_RESULT_ROWS) {
    throw new RangeError(
      `rows exceeds ${MAX_VIEWER_RESULT_ROWS} entries`,
    );
  }
  return Object.freeze(
    rows.map((row, index) => {
      if (!Array.isArray(row) || row.length !== 2) {
        throw new TypeError(`rows[${index}] must be a [label, value] pair`);
      }
      return Object.freeze([
        boundedText(
          row[0],
          `rows[${index}][0]`,
          MAX_RESULT_LABEL_LENGTH,
          { empty: false },
        ),
        boundedText(
          row[1],
          `rows[${index}][1]`,
          MAX_RESULT_VALUE_LENGTH,
        ),
      ]);
    }),
  );
}

function normalizedActions(actions) {
  if (!Array.isArray(actions)) {
    throw new TypeError("actions must be an array");
  }
  if (actions.length > MAX_VIEWER_RESULT_ACTIONS) {
    throw new RangeError(
      `actions exceeds ${MAX_VIEWER_RESULT_ACTIONS} entries`,
    );
  }
  const normalized = actions.map(normalizedAction);
  if (new Set(normalized.map((action) => action.id)).size !== normalized.length) {
    throw new TypeError("actions must use unique ids");
  }
  return Object.freeze(normalized);
}

function createViewerResultModel({
  title,
  rows = [],
  actions = [],
  view = null,
} = {}) {
  return Object.freeze({
    title: boundedText(
      title,
      "title",
      MAX_RESULT_TITLE_LENGTH,
      { empty: false },
    ),
    rows: normalizedRows(rows),
    actions: normalizedActions(actions),
    view: normalizedIdentifier(view, "view", { nullable: true }),
  });
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function requireQueryElement(parent, selector, name) {
  const element = parent.querySelector(selector);
  if (!element) {
    throw new TypeError(`${name} is required`);
  }
  return element;
}

function requireDomSurface(value, name) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.querySelector !== "function" ||
    typeof value.querySelectorAll !== "function"
  ) {
    throw new TypeError(`${name} must be a queryable DOM element`);
  }
  return value;
}

function requireButton(button, name) {
  if (
    !button ||
    typeof button.addEventListener !== "function" ||
    typeof button.removeEventListener !== "function" ||
    typeof button.setAttribute !== "function"
  ) {
    throw new TypeError(`${name} must be an interactive DOM element`);
  }
  return button;
}

class ViewerReviewUiController {
  #actionButtons;
  #actionContainer;
  #actionDataKeys = new WeakMap();
  #activeTool = null;
  #canvas;
  #content;
  #disposed = false;
  #document;
  #finishTools;
  #listeners = [];
  #onAction;
  #onToolRequest;
  #result;
  #resultActionButtons;
  #title;
  #toolbar;
  #toolButtons;

  constructor({
    canvas,
    toolbar,
    result,
    finishTools = ["path", "area"],
    onToolRequest = () => {},
    onAction = () => {},
  } = {}) {
    if (
      !canvas ||
      typeof canvas !== "object" ||
      typeof canvas.classList?.toggle !== "function" ||
      typeof canvas.classList?.remove !== "function"
    ) {
      throw new TypeError("canvas must expose a DOMTokenList classList");
    }
    this.#canvas = canvas;
    this.#toolbar = requireDomSurface(toolbar, "toolbar");
    this.#result = requireDomSurface(result, "result");
    this.#title = requireQueryElement(
      this.#result,
      SELECTORS.title,
      "result title",
    );
    this.#content = requireQueryElement(
      this.#result,
      SELECTORS.content,
      "result content",
    );
    if (typeof this.#content.replaceChildren !== "function") {
      throw new TypeError("result content must support replaceChildren()");
    }
    this.#actionContainer = this.#result.querySelector(
      SELECTORS.actionContainer,
    );
    this.#document = this.#result.ownerDocument;
    if (
      !this.#document ||
      typeof this.#document.createElement !== "function" ||
      typeof this.#document.createDocumentFragment !== "function"
    ) {
      throw new TypeError("result must belong to a DOM document");
    }
    this.#onToolRequest = requireFunction(
      onToolRequest,
      "onToolRequest",
    );
    this.#onAction = requireFunction(onAction, "onAction");
    if (!Array.isArray(finishTools)) {
      throw new TypeError("finishTools must be an array");
    }
    this.#finishTools = new Set(
      finishTools.map((tool, index) =>
        normalizedIdentifier(tool, `finishTools[${index}]`),
      ),
    );

    this.#toolButtons = [
      ...this.#toolbar.querySelectorAll(SELECTORS.tool),
    ];
    const toolIds = new Set();
    for (const [index, button] of this.#toolButtons.entries()) {
      requireButton(button, `toolButtons[${index}]`);
      const tool = normalizedIdentifier(
        button.dataset?.reviewTool,
        `toolButtons[${index}].dataset.reviewTool`,
      );
      if (toolIds.has(tool)) {
        throw new TypeError(`duplicate review tool: ${tool}`);
      }
      toolIds.add(tool);
      this.#listen(button, "click", (event) => {
        this.#onToolRequest(tool, { button, event });
      });
    }

    this.#actionButtons = [
      ...new Set([
        ...this.#toolbar.querySelectorAll(SELECTORS.action),
        ...this.#result.querySelectorAll(SELECTORS.action),
      ]),
    ];
    for (const [index, button] of this.#actionButtons.entries()) {
      requireButton(button, `actionButtons[${index}]`);
      const action = normalizedIdentifier(
        button.dataset?.reviewAction,
        `actionButtons[${index}].dataset.reviewAction`,
      );
      this.#listen(button, "click", (event) => {
        this.#onAction(action, { button, event });
      });
    }
    this.#resultActionButtons = this.#actionContainer
      ? [...this.#actionContainer.querySelectorAll(SELECTORS.action)]
      : [];
    this.#applyActiveTool(null);
  }

  get activeTool() {
    return this.#activeTool;
  }

  get disposed() {
    return this.#disposed;
  }

  #assertActive() {
    if (this.#disposed) {
      throw new Error("ViewerReviewUiController is disposed");
    }
  }

  #listen(target, type, listener) {
    target.addEventListener(type, listener);
    this.#listeners.push({ target, type, listener });
  }

  #applyActiveTool(tool) {
    this.#activeTool = tool;
    this.#canvas.classList.toggle("reviewing", Boolean(tool));
    for (const button of this.#toolButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.reviewTool === tool),
      );
    }
    const finishButton = this.#toolbar.querySelector(SELECTORS.finish);
    if (finishButton) {
      finishButton.hidden = !this.#finishTools.has(tool);
    }
  }

  setActiveTool(tool) {
    this.#assertActive();
    const normalized = normalizedIdentifier(
      tool,
      "tool",
      { nullable: true },
    );
    const changed = normalized !== this.#activeTool;
    this.#applyActiveTool(normalized);
    return changed;
  }

  resetTools() {
    return this.setActiveTool(null);
  }

  setEnabled(enabled) {
    this.#assertActive();
    const next = Boolean(enabled);
    this.#toolbar.hidden = !next;
    for (const button of this.#toolbar.querySelectorAll("button")) {
      button.disabled = !next;
    }
    return next;
  }

  #resolveActions(actions) {
    if (actions.length > 0 && !this.#actionContainer) {
      throw new Error("result action container is required");
    }
    const available = new Map();
    for (const button of this.#resultActionButtons) {
      const id = normalizedIdentifier(
        button.dataset?.reviewAction,
        "result action id",
      );
      if (available.has(id)) {
        throw new Error(`duplicate result action element: ${id}`);
      }
      available.set(id, button);
    }
    const resolved = [];
    for (const action of actions) {
      const button = available.get(action.id);
      if (!button) {
        throw new Error(`missing result action element: ${action.id}`);
      }
      resolved.push([action, button]);
    }
    return { available, resolved };
  }

  #applyResultShell(model) {
    const { available, resolved } = this.#resolveActions(model.actions);
    if (model.view) {
      this.#result.dataset.reviewView = model.view;
    } else {
      delete this.#result.dataset.reviewView;
    }
    this.#title.textContent = model.title;

    const activeIds = new Set(model.actions.map((action) => action.id));
    for (const [id, button] of available) {
      button.hidden = !activeIds.has(id);
      const previousKeys = this.#actionDataKeys.get(button) ?? [];
      for (const key of previousKeys) {
        delete button.dataset[key];
      }
      this.#actionDataKeys.delete(button);
    }
    for (const [action, button] of resolved) {
      const keys = Object.keys(action.data);
      for (const key of keys) {
        button.dataset[key] = action.data[key];
      }
      this.#actionDataKeys.set(button, keys);
    }
    if (this.#actionContainer) {
      this.#actionContainer.hidden = model.actions.length === 0;
    }
  }

  showResult(input) {
    this.#assertActive();
    const model = createViewerResultModel(input);
    this.#applyResultShell(model);
    const fragment = this.#document.createDocumentFragment();
    for (const [label, value] of model.rows) {
      const row = this.#document.createElement("div");
      const term = this.#document.createElement("span");
      const description = this.#document.createElement("strong");
      term.textContent = label;
      description.textContent = value;
      row.append(term, description);
      fragment.append(row);
    }
    this.#content.replaceChildren(fragment);
    this.#result.hidden = false;
    return model;
  }

  showContent({
    title,
    content,
    actions = [],
    view = null,
  } = {}) {
    this.#assertActive();
    if (!content || typeof content !== "object") {
      throw new TypeError("content must be a DOM node");
    }
    const model = createViewerResultModel({
      title,
      actions,
      view,
    });
    this.#applyResultShell(model);
    this.#content.replaceChildren(content);
    this.#result.hidden = false;
    return model;
  }

  hideResult() {
    this.#assertActive();
    const changed = !this.#result.hidden;
    this.#result.hidden = true;
    return changed;
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    for (const { target, type, listener } of this.#listeners.splice(0)) {
      target.removeEventListener(type, listener);
    }
    this.#applyActiveTool(null);
    this.#toolbar.hidden = true;
    this.#result.hidden = true;
    this.#disposed = true;
    return true;
  }
}

export {
  MAX_VIEWER_RESULT_ACTIONS,
  MAX_VIEWER_RESULT_ROWS,
  ViewerReviewUiController,
  createViewerResultModel,
};
