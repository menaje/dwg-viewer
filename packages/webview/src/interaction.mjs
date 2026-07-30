import { CameraController2D } from "./camera.mjs";
import { DetailStreamer } from "./detail-streamer.mjs";

const DETAIL_DEBOUNCE_MS = 120;
const DETAIL_ZOOM_THRESHOLD = 4;
const WHEEL_ZOOM_RATE = 0.0015;

export class ViewportInteraction {
  constructor(
    scene,
    canvas,
    {
      detailZoomThreshold = DETAIL_ZOOM_THRESHOLD,
      onUpdate = () => {},
      onError = () => {},
    } = {},
  ) {
    this.scene = scene;
    this.canvas = canvas;
    this.camera = new CameraController2D(scene.render.camera);
    this.detailZoomThreshold = detailZoomThreshold;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.lastRender = scene.render;
    this.frameRequest = null;
    this.detailTimer = null;
    this.drag = null;
    this.abortController = new AbortController();
    this.detailStreamer = new DetailStreamer(
      scene.reader,
      scene.renderer,
      scene.metadata.batches,
      scene.instanceGraph,
      {
        onUpdate: (detail) => {
          if (detail.render) {
            this.lastRender = detail.render;
          }
          this.emit(detail);
        },
        onError: (error) => {
          this.onError(error);
        },
      },
    );
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRender();
      this.scheduleDetail();
    });
    this.resizeObserver.observe(canvas);
  }

  bindEvents() {
    const signal = this.abortController.signal;
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const delta = Math.min(Math.max(event.deltaY, -1_000), 1_000);
        this.camera.zoomAt(
          Math.exp(delta * WHEEL_ZOOM_RATE),
          event.offsetX,
          event.offsetY,
          this.canvas.clientWidth,
          this.canvas.clientHeight,
        );
        this.scheduleRender();
        this.scheduleDetail();
      },
      { passive: false, signal },
    );
    this.canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) {
          return;
        }
        this.canvas.setPointerCapture(event.pointerId);
        this.drag = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        };
        this.canvas.classList.add("panning");
      },
      { signal },
    );
    this.canvas.addEventListener(
      "pointermove",
      (event) => {
        if (!this.drag || this.drag.pointerId !== event.pointerId) {
          return;
        }
        const deltaX = event.clientX - this.drag.x;
        const deltaY = event.clientY - this.drag.y;
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        this.camera.panByPixels(
          deltaX,
          deltaY,
          this.canvas.clientWidth,
          this.canvas.clientHeight,
        );
        this.scheduleRender();
        this.scheduleDetail();
      },
      { signal },
    );
    for (const eventName of ["pointerup", "pointercancel"]) {
      this.canvas.addEventListener(
        eventName,
        (event) => {
          if (!this.drag || this.drag.pointerId !== event.pointerId) {
            return;
          }
          this.drag = null;
          this.canvas.classList.remove("panning");
          if (this.canvas.hasPointerCapture(event.pointerId)) {
            this.canvas.releasePointerCapture(event.pointerId);
          }
        },
        { signal },
      );
    }
    this.canvas.addEventListener(
      "dblclick",
      (event) => {
        event.preventDefault();
        this.reset();
      },
      { signal },
    );
  }

  reset() {
    this.camera.reset();
    this.scheduleRender();
    this.scheduleDetail(0);
  }

  zoomBy(factor) {
    this.camera.zoomAt(
      factor,
      this.canvas.clientWidth * 0.5,
      this.canvas.clientHeight * 0.5,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
    );
    this.scheduleRender();
    this.scheduleDetail();
  }

  refresh() {
    this.lastRender = this.scene.renderer.redraw(this.camera.view());
    this.emit(this.detailStreamer.snapshot());
    return this.snapshot();
  }

  scheduleRender() {
    if (this.frameRequest !== null) {
      return;
    }
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      try {
        this.lastRender = this.scene.renderer.redraw(this.camera.view());
        this.emit(this.detailStreamer.snapshot());
      } catch (error) {
        this.onError(error);
      }
    });
  }

  scheduleDetail(delay = DETAIL_DEBOUNCE_MS) {
    if (this.detailTimer !== null) {
      clearTimeout(this.detailTimer);
    }
    this.detailTimer = setTimeout(() => {
      this.detailTimer = null;
      try {
        this.lastRender = this.scene.renderer.redraw(this.camera.view());
        this.detailStreamer.update(this.lastRender.camera, {
          enabled: this.camera.zoom >= this.detailZoomThreshold,
        });
      } catch (error) {
        this.onError(error);
      }
    }, delay);
  }

  snapshot(detail = this.detailStreamer.snapshot()) {
    return Object.freeze({
      zoom: this.camera.zoom,
      camera: this.camera.view(),
      render: this.lastRender,
      detail,
    });
  }

  emit(detail) {
    this.onUpdate(this.snapshot(detail));
  }

  dispose() {
    this.abortController.abort();
    this.resizeObserver.disconnect();
    if (this.frameRequest !== null) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    if (this.detailTimer !== null) {
      clearTimeout(this.detailTimer);
      this.detailTimer = null;
    }
    this.detailStreamer.dispose();
    this.canvas.classList.remove("panning");
  }
}

export {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  WHEEL_ZOOM_RATE,
};
