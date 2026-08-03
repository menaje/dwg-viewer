const DEFAULT_MINIMUM_SCALE = 1e-6;
const DEFAULT_MAXIMUM_SCALE = 100;

function requirePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export class CameraController2D {
  constructor(
    fitCamera,
    {
      minimumScale = DEFAULT_MINIMUM_SCALE,
      maximumScale = DEFAULT_MAXIMUM_SCALE,
    } = {},
  ) {
    if (!fitCamera || !Array.isArray(fitCamera.origin)) {
      throw new TypeError("CameraController2D requires a fitted camera");
    }
    this.fitOrigin = [...fitCamera.origin];
    this.fitWorldHeight = requirePositive(
      fitCamera.worldHeight,
      "fit camera world height",
    );
    this.minimumWorldHeight =
      this.fitWorldHeight * requirePositive(minimumScale, "minimum scale");
    this.maximumWorldHeight =
      this.fitWorldHeight * requirePositive(maximumScale, "maximum scale");
    if (this.minimumWorldHeight > this.maximumWorldHeight) {
      throw new RangeError("camera minimum scale is above its maximum scale");
    }
    this.origin = [...this.fitOrigin];
    this.worldHeight = this.fitWorldHeight;
  }

  get zoom() {
    return this.fitWorldHeight / this.worldHeight;
  }

  view() {
    return Object.freeze({
      origin: [...this.origin],
      worldHeight: this.worldHeight,
      zoom: this.zoom,
    });
  }

  reset() {
    this.origin = [...this.fitOrigin];
    this.worldHeight = this.fitWorldHeight;
    return this.view();
  }

  updateFit(fitCamera, { resetIfFitted = true } = {}) {
    if (!fitCamera || !Array.isArray(fitCamera.origin)) {
      throw new TypeError("camera fit update requires a fitted camera");
    }
    const wasFitted =
      Math.abs(this.worldHeight - this.fitWorldHeight) <=
        this.fitWorldHeight * 1e-9 &&
      this.origin.every(
        (value, axis) =>
          Math.abs(value - this.fitOrigin[axis]) <=
          Math.max(this.fitWorldHeight, 1) * 1e-9,
      );
    const minimumScale =
      this.minimumWorldHeight / this.fitWorldHeight;
    const maximumScale =
      this.maximumWorldHeight / this.fitWorldHeight;
    this.fitOrigin = [...fitCamera.origin];
    this.fitWorldHeight = requirePositive(
      fitCamera.worldHeight,
      "fit camera world height",
    );
    this.minimumWorldHeight = this.fitWorldHeight * minimumScale;
    this.maximumWorldHeight = this.fitWorldHeight * maximumScale;
    if (resetIfFitted && wasFitted) {
      return this.reset();
    }
    this.worldHeight = clamp(
      this.worldHeight,
      this.minimumWorldHeight,
      this.maximumWorldHeight,
    );
    return this.view();
  }

  focus(point, worldHeight = this.worldHeight) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      throw new TypeError("camera focus requires a finite point");
    }
    this.origin = [
      point[0],
      point[1],
      Number.isFinite(point[2]) ? point[2] : this.origin[2],
    ];
    this.worldHeight = clamp(
      requirePositive(worldHeight, "camera focus world height"),
      this.minimumWorldHeight,
      this.maximumWorldHeight,
    );
    return this.view();
  }

  panByPixels(deltaX, deltaY, width, height) {
    requirePositive(width, "camera viewport width");
    requirePositive(height, "camera viewport height");
    const worldPerPixel = this.worldHeight / height;
    this.origin[0] -= deltaX * worldPerPixel;
    this.origin[1] += deltaY * worldPerPixel;
    return this.view();
  }

  zoomAt(factor, screenX, screenY, width, height) {
    requirePositive(factor, "camera zoom factor");
    requirePositive(width, "camera viewport width");
    requirePositive(height, "camera viewport height");
    const aspect = width / height;
    const normalizedX = screenX / width - 0.5;
    const normalizedY = 0.5 - screenY / height;
    const oldHeight = this.worldHeight;
    const newHeight = clamp(
      oldHeight * factor,
      this.minimumWorldHeight,
      this.maximumWorldHeight,
    );
    const oldOffsetX = normalizedX * aspect * oldHeight;
    const oldOffsetY = normalizedY * oldHeight;
    const newOffsetX = normalizedX * aspect * newHeight;
    const newOffsetY = normalizedY * newHeight;
    this.origin[0] += oldOffsetX - newOffsetX;
    this.origin[1] += oldOffsetY - newOffsetY;
    this.worldHeight = newHeight;
    return this.view();
  }

  focusScreenRect(
    startX,
    startY,
    endX,
    endY,
    width,
    height,
    { minimumPixels = 8, padding = 1.04 } = {},
  ) {
    for (const [value, label] of [
      [startX, "rectangle start x"],
      [startY, "rectangle start y"],
      [endX, "rectangle end x"],
      [endY, "rectangle end y"],
    ]) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`${label} must be finite`);
      }
    }
    requirePositive(width, "camera viewport width");
    requirePositive(height, "camera viewport height");
    requirePositive(minimumPixels, "rectangle minimum pixels");
    requirePositive(padding, "rectangle padding");
    const rectangleWidth = Math.abs(endX - startX);
    const rectangleHeight = Math.abs(endY - startY);
    if (
      rectangleWidth < minimumPixels ||
      rectangleHeight < minimumPixels
    ) {
      return null;
    }
    const worldPerPixel = this.worldHeight / height;
    const aspect = width / height;
    const centerX = (startX + endX) * 0.5;
    const centerY = (startY + endY) * 0.5;
    const nextOrigin = [
      this.origin[0] +
        (centerX / width - 0.5) * aspect * this.worldHeight,
      this.origin[1] +
        (0.5 - centerY / height) * this.worldHeight,
      this.origin[2],
    ];
    const selectedWorldHeight = Math.max(
      rectangleHeight * worldPerPixel,
      (rectangleWidth * worldPerPixel) / aspect,
    );
    return this.focus(nextOrigin, selectedWorldHeight * padding);
  }
}

export function cameraViewportBounds(camera) {
  if (
    !camera ||
    !Array.isArray(camera.origin) ||
    !Number.isFinite(camera.worldHeight) ||
    !Number.isFinite(camera.worldWidth)
  ) {
    throw new TypeError("camera viewport bounds require a rendered camera");
  }
  const halfWidth = camera.worldWidth * 0.5;
  const halfHeight = camera.worldHeight * 0.5;
  return Object.freeze({
    min: [
      camera.origin[0] - halfWidth,
      camera.origin[1] - halfHeight,
      -Infinity,
    ],
    max: [
      camera.origin[0] + halfWidth,
      camera.origin[1] + halfHeight,
      Infinity,
    ],
  });
}

export { DEFAULT_MAXIMUM_SCALE, DEFAULT_MINIMUM_SCALE };
