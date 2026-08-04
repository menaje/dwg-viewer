import { DetailStreamer } from "./detail-streamer.mjs";
import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction as CoreViewportInteraction,
  WHEEL_ZOOM_RATE,
} from "@menaje/viewer-core/interaction";
import { normalizeWheelGesture } from "./wheel-gesture.mjs";

function createDetailStreamer(...arguments_) {
  return new DetailStreamer(...arguments_);
}

export class ViewportInteraction extends CoreViewportInteraction {
  constructor(scene, canvas, options = {}) {
    const wheelAbortController = new AbortController();
    let interaction = null;
    const handleWheel = (event) => interaction?.handleWheel(event);
    canvas.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
      signal: wheelAbortController.signal,
    });

    try {
      super(scene, canvas, {
        ...options,
        createDetailStreamer,
      });
    } catch (error) {
      wheelAbortController.abort();
      throw error;
    }

    interaction = this;
    this.wheelAbortController = wheelAbortController;
    this.wheelGesture = null;
  }

  handleWheel(event) {
    event.preventDefault();
    event.stopImmediatePropagation?.();

    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const gesture = normalizeWheelGesture(
      event,
      this.wheelGesture,
      { width, height },
    );
    this.wheelGesture = gesture;

    if (gesture.kind === "trackpad-pan") {
      if (gesture.panX === 0 && gesture.panY === 0) {
        return;
      }
      this.camera.panByPixels(
        gesture.panX,
        gesture.panY,
        width,
        height,
      );
    } else {
      if (gesture.zoomFactor === 1) {
        return;
      }
      const offsetX = Number.isFinite(event.offsetX)
        ? event.offsetX
        : width * 0.5;
      const offsetY = Number.isFinite(event.offsetY)
        ? event.offsetY
        : height * 0.5;
      this.camera.zoomAt(
        gesture.zoomFactor,
        offsetX,
        offsetY,
        width,
        height,
      );
    }

    this.scheduleRender();
    this.scheduleDetail();
    this.scheduleViewCommit();
  }

  dispose() {
    this.wheelAbortController?.abort();
    this.wheelGesture = null;
    super.dispose();
  }
}

export {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  WHEEL_ZOOM_RATE,
};
