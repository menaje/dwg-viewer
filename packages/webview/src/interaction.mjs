import { CameraController2D } from "./camera.mjs";
import { DetailStreamer } from "./detail-streamer.mjs";

const DETAIL_DEBOUNCE_MS = 650;
const DETAIL_ZOOM_THRESHOLD = 0;
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
    this.frameInteractive = false;
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
          this.emit(this.detailSnapshot());
        },
        onError: (error) => {
          this.onError(error);
        },
      },
    );
    this.externalDetailStreamers = new Map();
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleRender({ interactive: false });
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
          this.scheduleDetail(0);
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
    if (typeof this.scene.renderer.fitAllCamera === "function") {
      this.camera.updateFit(this.scene.renderer.fitAllCamera(), {
        resetIfFitted: false,
      });
    }
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
    const interactive =
      this.drag !== null ||
      this.detailTimer !== null ||
      (this.frameRequest !== null && this.frameInteractive);
    this.cancelScheduledRender();
    this.lastRender = this.scene.renderer.redraw(
      this.camera.view(),
      { interactive },
    );
    this.syncDetailRenderCamera(this.lastRender.camera, {
      interactive,
    });
    this.emit(this.detailSnapshot());
    return this.snapshot();
  }

  updateFit(fitCamera) {
    this.cancelScheduledRender();
    this.camera.updateFit(fitCamera);
    this.lastRender = this.scene.renderer.redraw(this.camera.view());
    this.syncDetailRenderCamera(this.lastRender.camera);
    this.scheduleDetail(0);
    this.emit(this.detailSnapshot());
    return this.snapshot();
  }

  addExternalDetailSource(id, reader, batches, instanceGraph) {
    this.externalDetailStreamers.get(id)?.dispose();
    const renderer = {
      addDetailBatch: (batch, vertices) =>
        this.scene.renderer.addExternalDetailBatch(id, batch, vertices),
      deleteDetailBatch: (batchId) =>
        this.scene.renderer.deleteExternalDetailBatch(id, batchId),
      setDetailSelections: (candidates) =>
        this.scene.renderer.setExternalDetailSelections(id, candidates),
      redraw: (camera, options) =>
        this.scene.renderer.redraw(camera, options),
    };
    const streamer = new DetailStreamer(
      reader,
      renderer,
      batches,
      instanceGraph,
      {
        maximumCacheBytes: 24 * 1024 * 1024,
        maximumVisibleBytes: 8 * 1024 * 1024,
        concurrency: 1,
        onUpdate: (detail) => {
          if (detail.render) {
            this.lastRender = detail.render;
          }
          this.emit(this.detailSnapshot());
        },
        onError: (error) => this.onError(error),
      },
    );
    this.externalDetailStreamers.set(id, streamer);
    streamer.setRenderCamera(this.camera.view());
    this.scheduleDetail(0);
    return streamer;
  }

  syncDetailRenderCamera(camera, renderOptions = {}) {
    this.detailStreamer.setRenderCamera(camera, renderOptions);
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.setRenderCamera(camera, renderOptions);
    }
  }

  cancelScheduledRender() {
    if (this.frameRequest === null) {
      return false;
    }
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = null;
    this.frameInteractive = false;
    return true;
  }

  scheduleRender({ interactive = true } = {}) {
    const camera = this.camera.view();
    this.syncDetailRenderCamera(camera, { interactive });
    if (this.frameRequest !== null) {
      this.frameInteractive &&= Boolean(interactive);
      return;
    }
    this.frameInteractive = Boolean(interactive);
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      const renderInteractive = this.frameInteractive;
      this.frameInteractive = false;
      try {
        this.lastRender = this.scene.renderer.redraw(
          this.camera.view(),
          { interactive: renderInteractive },
        );
        this.syncDetailRenderCamera(this.lastRender.camera, {
          interactive: renderInteractive,
        });
        this.emit(this.detailSnapshot());
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
        this.cancelScheduledRender();
        const camera = this.scene.renderer.cameraForView(
          this.camera.view(),
        );
        const enabled = this.camera.zoom >= this.detailZoomThreshold;
        this.syncDetailRenderCamera(camera);
        this.detailStreamer.update(camera, {
          enabled,
          redraw: false,
          emit: false,
        });
        for (const streamer of this.externalDetailStreamers.values()) {
          streamer.update(camera, {
            enabled,
            redraw: false,
            emit: false,
          });
        }
        this.lastRender = this.scene.renderer.redraw(camera);
        this.syncDetailRenderCamera(this.lastRender.camera);
        this.emit(this.detailSnapshot());
      } catch (error) {
        this.onError(error);
      }
    }, delay);
  }

  detailSnapshot() {
    const snapshots = [
      this.detailStreamer.snapshot(),
      ...[...this.externalDetailStreamers.values()].map((streamer) =>
        streamer.snapshot(),
      ),
    ];
    return Object.freeze({
      revision: Math.max(...snapshots.map((value) => value.revision)),
      selectedBatches: snapshots.reduce(
        (total, value) => total + value.selectedBatches,
        0,
      ),
      selectedBytes: snapshots.reduce(
        (total, value) => total + value.selectedBytes,
        0,
      ),
      selectedInstances: snapshots.reduce(
        (total, value) => total + value.selectedInstances,
        0,
      ),
      loading: snapshots.reduce(
        (total, value) => total + value.loading,
        0,
      ),
      cache: Object.freeze({
        entries: snapshots.reduce(
          (total, value) => total + value.cache.entries,
          0,
        ),
        bytes: snapshots.reduce(
          (total, value) => total + value.cache.bytes,
          0,
        ),
      }),
      render: this.lastRender,
      error: snapshots.find((value) => value.error)?.error ?? null,
    });
  }

  snapshot(detail = this.detailSnapshot()) {
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
    this.cancelScheduledRender();
    if (this.detailTimer !== null) {
      clearTimeout(this.detailTimer);
      this.detailTimer = null;
    }
    this.detailStreamer.dispose();
    for (const streamer of this.externalDetailStreamers.values()) {
      streamer.dispose();
    }
    this.externalDetailStreamers.clear();
    this.canvas.classList.remove("panning");
  }
}

export {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  WHEEL_ZOOM_RATE,
};
