const SPLIT_VIEW_SIDES = Object.freeze(["before", "after"]);

export const ViewerSplitViewSide = Object.freeze({
  BEFORE: SPLIT_VIEW_SIDES[0],
  AFTER: SPLIT_VIEW_SIDES[1],
});

export const AllViewerSplitViewSides = SPLIT_VIEW_SIDES;

function invalidState(message) {
  return new DOMException(message, "InvalidStateError");
}

function assertSide(value) {
  if (!SPLIT_VIEW_SIDES.includes(value)) {
    throw new TypeError(
      "split-view camera side must be before or after",
    );
  }
  return value;
}

function oppositeSide(side) {
  return side === ViewerSplitViewSide.BEFORE
    ? ViewerSplitViewSide.AFTER
    : ViewerSplitViewSide.BEFORE;
}

function normalizeCamera(value) {
  if (
    !value ||
    !Array.isArray(value.origin) ||
    value.origin.length < 2 ||
    !value.origin.every(Number.isFinite) ||
    !Number.isFinite(value.worldHeight) ||
    value.worldHeight <= 0
  ) {
    throw new TypeError(
      "split-view camera requires a finite origin and positive worldHeight",
    );
  }
  return Object.freeze({
    origin: Object.freeze([...value.origin]),
    worldHeight: value.worldHeight,
  });
}

function sameCamera(left, right) {
  return (
    left.worldHeight === right.worldHeight &&
    left.origin.length === right.origin.length &&
    left.origin.every((value, axis) => value === right.origin[axis])
  );
}

function assertTarget(value, side) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    typeof value.setCamera !== "function"
  ) {
    throw new TypeError(
      `split-view ${side} target must implement setCamera()`,
    );
  }
  return value;
}

function synchronous(value, label) {
  if (value && typeof value.then === "function") {
    throw new TypeError(`${label} must complete synchronously`);
  }
  return value;
}

function assertInteractive(value) {
  if (typeof value !== "boolean") {
    throw new TypeError(
      "split-view camera interactive option must be a boolean",
    );
  }
  return value;
}

function transitionFailure(error, rollbackErrors) {
  if (rollbackErrors.length === 0) {
    return error;
  }
  return new AggregateError(
    [error, ...rollbackErrors],
    "split-view camera transition and rollback failed",
    { cause: error },
  );
}

export class ViewerSplitViewCameraController {
  #targets;
  #camera;
  #sequence = 0;
  #sourceSide = null;
  #interactive = false;
  #synchronized = false;
  #disposed = false;
  #transitioning = false;
  #applying = null;

  constructor({ camera, before, after } = {}) {
    const beforeTarget = assertTarget(
      before,
      ViewerSplitViewSide.BEFORE,
    );
    const afterTarget = assertTarget(
      after,
      ViewerSplitViewSide.AFTER,
    );
    if (beforeTarget === afterTarget) {
      throw new TypeError(
        "split-view camera targets must be distinct",
      );
    }
    this.#targets = new Map([
      [ViewerSplitViewSide.BEFORE, beforeTarget],
      [ViewerSplitViewSide.AFTER, afterTarget],
    ]);
    this.#camera = normalizeCamera(camera);
  }

  get disposed() {
    return this.#disposed;
  }

  #assertOpen() {
    if (this.#disposed) {
      throw invalidState(
        "Viewer split-view camera controller is disposed",
      );
    }
  }

  #assertIdle() {
    if (this.#transitioning) {
      throw invalidState(
        "split-view camera transition is already active",
      );
    }
  }

  #view() {
    return Object.freeze({
      sequence: this.#sequence,
      camera: this.#camera,
      sourceSide: this.#sourceSide,
      interactive: this.#interactive,
      synchronized: this.#synchronized,
    });
  }

  snapshot() {
    this.#assertOpen();
    return this.#view();
  }

  #apply(side, camera, context) {
    this.#applying = Object.freeze({ side, camera });
    try {
      return synchronous(
        this.#targets.get(side).setCamera(
          camera,
          Object.freeze({ side, ...context }),
        ),
        `split-view ${side} target setCamera`,
      );
    } finally {
      this.#applying = null;
    }
  }

  #rollback(camera, sourceSide, interactive) {
    const rollbackErrors = [];
    const sides = sourceSide
      ? [oppositeSide(sourceSide), sourceSide]
      : [...SPLIT_VIEW_SIDES].reverse();
    for (const side of sides) {
      try {
        this.#apply(side, camera, {
          sourceSide,
          sequence: this.#sequence,
          interactive,
          phase: "rollback",
        });
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    this.#synchronized = rollbackErrors.length === 0;
    return rollbackErrors;
  }

  synchronize({ interactive = false } = {}) {
    this.#assertOpen();
    this.#assertIdle();
    assertInteractive(interactive);
    this.#transitioning = true;
    const errors = [];
    try {
      for (const side of SPLIT_VIEW_SIDES) {
        try {
          this.#apply(side, this.#camera, {
            sourceSide: null,
            sequence: this.#sequence,
            interactive,
            phase: "synchronize",
          });
        } catch (error) {
          errors.push(error);
        }
      }
      this.#synchronized = errors.length === 0;
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "split-view camera synchronization failed",
        );
      }
      this.#interactive = interactive;
      return this.#view();
    } finally {
      this.#transitioning = false;
    }
  }

  setCamera(camera, { interactive = false } = {}) {
    this.#assertOpen();
    this.#assertIdle();
    assertInteractive(interactive);
    const nextCamera = normalizeCamera(camera);
    if (
      this.#synchronized &&
      sameCamera(this.#camera, nextCamera) &&
      this.#interactive === interactive
    ) {
      return this.#view();
    }
    const nextSequence = this.#sequence + 1;
    this.#transitioning = true;
    try {
      for (const side of SPLIT_VIEW_SIDES) {
        this.#apply(side, nextCamera, {
          sourceSide: null,
          sequence: nextSequence,
          interactive,
          phase: "apply",
        });
      }
      this.#camera = nextCamera;
      this.#sequence = nextSequence;
      this.#sourceSide = null;
      this.#interactive = interactive;
      this.#synchronized = true;
      return this.#view();
    } catch (error) {
      const rollbackErrors = this.#rollback(
        this.#camera,
        null,
        this.#interactive,
      );
      throw transitionFailure(error, rollbackErrors);
    } finally {
      this.#transitioning = false;
    }
  }

  setCameraFrom(side, camera, { interactive = false } = {}) {
    this.#assertOpen();
    const sourceSide = assertSide(side);
    assertInteractive(interactive);
    const nextCamera = normalizeCamera(camera);
    if (this.#applying) {
      if (
        this.#applying.side === sourceSide &&
        sameCamera(this.#applying.camera, nextCamera)
      ) {
        return this.#view();
      }
      throw invalidState(
        "split-view target changed the camera during synchronization",
      );
    }
    this.#assertIdle();
    if (
      this.#synchronized &&
      sameCamera(this.#camera, nextCamera) &&
      this.#interactive === interactive
    ) {
      return this.#view();
    }
    const targetSide = oppositeSide(sourceSide);
    const nextSequence = this.#sequence + 1;
    this.#transitioning = true;
    try {
      this.#apply(targetSide, nextCamera, {
        sourceSide,
        sequence: nextSequence,
        interactive,
        phase: "apply",
      });
      this.#camera = nextCamera;
      this.#sequence = nextSequence;
      this.#sourceSide = sourceSide;
      this.#interactive = interactive;
      this.#synchronized = true;
      return this.#view();
    } catch (error) {
      const rollbackErrors = this.#rollback(
        this.#camera,
        sourceSide,
        this.#interactive,
      );
      throw transitionFailure(error, rollbackErrors);
    } finally {
      this.#transitioning = false;
    }
  }

  dispose() {
    if (this.#disposed) {
      return false;
    }
    this.#assertIdle();
    this.#targets.clear();
    this.#disposed = true;
    return true;
  }
}
