function objectLike(value, label) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function method(value, name, label) {
  if (typeof value[name] !== "function") {
    throw new TypeError(`${label} must implement ${name}()`);
  }
}

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function assertCamera(value, label = "renderer camera") {
  const camera = objectLike(value, label);
  if (
    !Array.isArray(camera.origin) ||
    camera.origin.length < 2 ||
    !camera.origin.every(Number.isFinite) ||
    !Number.isFinite(camera.worldHeight) ||
    camera.worldHeight <= 0
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return camera;
}

function assertRenderFrame(value) {
  const frame = objectLike(value, "renderer frame");
  assertCamera(frame.camera, "renderer frame camera");
  return frame;
}

function sourceId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512
  ) {
    throw new TypeError("renderer detail source ID is invalid");
  }
  return value;
}

export function assertViewerRenderer(value) {
  const renderer = objectLike(value, "Viewer renderer");
  for (const name of [
    "redraw",
    "cameraForView",
    "addDetailBatch",
    "deleteDetailBatch",
    "setDetailSelections",
  ]) {
    method(renderer, name, "Viewer renderer");
  }
  if (
    renderer.fitAllCamera !== undefined &&
    typeof renderer.fitAllCamera !== "function"
  ) {
    throw new TypeError(
      "Viewer renderer fitAllCamera must be a function when provided",
    );
  }
  return renderer;
}

class RendererDetailTarget {
  #controller;
  #sourceId;
  #external;
  #resources = new Set();
  #disposed = false;

  constructor(controller, renderer, detailSourceId) {
    this.#controller = controller;
    this.#sourceId = detailSourceId;
    this.#external = detailSourceId !== "root";
    if (this.#external) {
      for (const name of [
        "addExternalDetailBatch",
        "deleteExternalDetailBatch",
        "setExternalDetailSelections",
      ]) {
        method(renderer, name, "Viewer renderer");
      }
    }
  }

  get sourceId() {
    return this.#sourceId;
  }

  get disposed() {
    return this.#disposed;
  }

  #assertActive() {
    if (this.#disposed) {
      throw invalidState("renderer detail target is disposed");
    }
    this.#controller.assertActive();
  }

  addDetailBatch(batch, vertices) {
    this.#assertActive();
    const renderer = this.#controller.renderer;
    const resource = this.#external
      ? renderer.addExternalDetailBatch(
          this.#sourceId,
          batch,
          vertices,
        )
      : renderer.addDetailBatch(batch, vertices);
    this.#resources.add(batch.id);
    return resource;
  }

  deleteDetailBatch(batchId) {
    if (this.#disposed) {
      return false;
    }
    this.#controller.assertActive();
    this.#resources.delete(batchId);
    const renderer = this.#controller.renderer;
    return this.#external
      ? renderer.deleteExternalDetailBatch(this.#sourceId, batchId)
      : renderer.deleteDetailBatch(batchId);
  }

  setDetailSelections(candidates) {
    this.#assertActive();
    const renderer = this.#controller.renderer;
    return this.#external
      ? renderer.setExternalDetailSelections(
          this.#sourceId,
          candidates,
        )
      : renderer.setDetailSelections(candidates);
  }

  redraw(camera, options) {
    this.#assertActive();
    return this.#controller.redraw(camera, options);
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    const renderer = this.#controller.renderer;
    const empty = Object.freeze([]);
    if (this.#external) {
      renderer.setExternalDetailSelections(this.#sourceId, empty);
      for (const batchId of this.#resources) {
        renderer.deleteExternalDetailBatch(this.#sourceId, batchId);
      }
    } else {
      renderer.setDetailSelections(empty);
      for (const batchId of this.#resources) {
        renderer.deleteDetailBatch(batchId);
      }
    }
    this.#resources.clear();
    this.#disposed = true;
    return true;
  }
}
export class ViewerRendererController {
  #renderer;
  #detailTargets = new Map();
  #disposed = false;

  constructor(renderer) {
    this.#renderer = assertViewerRenderer(renderer);
  }

  get renderer() {
    return this.#renderer;
  }

  get disposed() {
    return this.#disposed;
  }

  assertActive() {
    if (this.#disposed) {
      throw invalidState("Viewer renderer controller is disposed");
    }
  }

  redraw(camera, options) {
    this.assertActive();
    assertCamera(camera);
    return assertRenderFrame(this.#renderer.redraw(camera, options));
  }

  cameraForView(view, targetSize) {
    this.assertActive();
    return assertCamera(
      this.#renderer.cameraForView(view, targetSize),
      "renderer fitted camera",
    );
  }

  fitAllCamera(targetSize) {
    this.assertActive();
    if (typeof this.#renderer.fitAllCamera !== "function") {
      return null;
    }
    return assertCamera(
      this.#renderer.fitAllCamera(targetSize),
      "renderer fit-all camera",
    );
  }

  createDetailTarget(detailSourceId = "root") {
    this.assertActive();
    const id = sourceId(detailSourceId);
    let target = this.#detailTargets.get(id);
    if (!target || target.disposed) {
      target = new RendererDetailTarget(this, this.#renderer, id);
      this.#detailTargets.set(id, target);
    }
    return target;
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    for (const target of this.#detailTargets.values()) {
      target.dispose();
    }
    this.#detailTargets.clear();
    this.#disposed = true;
    return true;
  }
}
