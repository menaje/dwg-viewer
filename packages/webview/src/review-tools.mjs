import {
  OverviewSnapIndex,
  screenToWorld,
  worldToScreen,
} from "./measurement.mjs";

const TOOL_LABELS = Object.freeze({
  select: "객체 선택",
  distance: "두 점 거리",
  coordinate: "점 좌표",
});

const SNAP_LABELS = Object.freeze({
  endpoint: "끝점",
  midpoint: "중간점",
  quadrant: "사분점",
  nearest: "근처점",
});

const MAX_DETAIL_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_REVIEW_BATCHES = 96;
const MAX_EXACT_CURVE_REVIEW_BYTES = 4 * 1024 * 1024;

const UNIT_LABELS = Object.freeze({
  1: "in",
  2: "ft",
  3: "mi",
  4: "mm",
  5: "cm",
  6: "m",
  7: "km",
  8: "µin",
  9: "mil",
  10: "yd",
  11: "Å",
  12: "nm",
  13: "µm",
  14: "dm",
  15: "dam",
  16: "hm",
  17: "Gm",
  18: "AU",
  19: "ly",
  20: "pc",
  21: "US ft",
  22: "US in",
  23: "US yd",
  24: "US mi",
});

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const normalized = Math.abs(value) < 1e-9 ? 0 : value;
  const magnitude = Math.abs(normalized);
  const maximumFractionDigits =
    magnitude >= 10_000 ? 1 : magnitude >= 100 ? 2 : 4;
  return new Intl.NumberFormat("ko-KR", {
    maximumFractionDigits,
    useGrouping: true,
  }).format(normalized);
}

function unitLabel(code) {
  return UNIT_LABELS[code] ?? "도면 단위";
}

function pointText(point, unit) {
  return (
    `X ${formatNumber(point[0])} · ` +
    `Y ${formatNumber(point[1])} · ` +
    `Z ${formatNumber(point[2])} ${unit}`
  );
}

function resultRows(rows) {
  const fragment = document.createDocumentFragment();
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    const term = document.createElement("span");
    const description = document.createElement("strong");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    fragment.append(row);
  }
  return fragment;
}

function pointerPosition(event, canvas) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
}

function sameInstanceSelection(left, right) {
  if (left === right || (!left && !right)) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function candidateRank(candidate) {
  return {
    endpoint: 0,
    midpoint: 1,
    quadrant: 2,
    nearest: 3,
  }[candidate?.kind] ?? 4;
}

function betterCandidate(current, candidate) {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }
  const currentRank = candidateRank(current);
  const nextRank = candidateRank(candidate);
  return nextRank < currentRank ||
    (nextRank === currentRank &&
      candidate.distancePixels < current.distancePixels)
    ? candidate
    : current;
}

export class ReviewTools {
  constructor({
    canvas,
    overlay,
    toolbar,
    result,
    scene,
    instanceGraph,
    getCamera,
    getLayerVisibility,
    onFit = () => {},
    onReviewModeChange = () => {},
    onStatus = () => {},
  }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.toolbar = toolbar;
    this.result = result;
    this.scene = scene;
    this.instanceGraph = instanceGraph;
    this.getCamera = getCamera;
    this.getLayerVisibility = getLayerVisibility;
    this.onFit = onFit;
    this.onReviewModeChange = onReviewModeChange;
    this.onStatus = onStatus;
    this.sources = new Map();
    this.index = null;
    this.detailSelections = new Map();
    this.detailEntries = new Map();
    this.detailBytes = 0;
    this.curveStates = new Map();
    this.curveBytes = 0;
    this.curveRevision = 0;
    this.curveLoadPromise = Promise.resolve();
    this.activeTool = null;
    this.hover = null;
    this.firstPoint = null;
    this.selection = null;
    this.camera = getCamera();
    this.abortController = new AbortController();
    this.addSource("root", {
      id: "root",
      label: "현재 도면",
      batches: scene.metadata.batches,
      vertices: scene.overview,
      instanceGraph,
      layers: scene.metadata.layers,
      reader: scene.reader,
    });
    this.bind();
    this.setEnabled(true);
  }

  bind() {
    const signal = this.abortController.signal;
    for (const button of this.toolbar.querySelectorAll("[data-review-tool]")) {
      button.addEventListener(
        "click",
        () => this.activate(button.dataset.reviewTool),
        { signal },
      );
    }
    this.toolbar
      .querySelector("[data-review-action='fit']")
      ?.addEventListener(
        "click",
        () => {
          this.onFit();
          this.onStatus("도면 전체가 보이도록 화면을 맞췄습니다.");
        },
        { signal },
      );
    this.toolbar
      .querySelector("[data-review-action='clear']")
      ?.addEventListener("click", () => this.clear(), { signal });
    this.result
      .querySelector("[data-review-action='close']")
      ?.addEventListener(
        "click",
        () => {
          this.result.hidden = true;
          this.clear({ keepResult: true });
        },
        { signal },
      );
    this.canvas.addEventListener(
      "pointermove",
      (event) => this.handlePointerMove(event),
      { capture: true, signal },
    );
    this.canvas.addEventListener(
      "pointerleave",
      () => {
        this.hover = null;
        this.redraw();
      },
      { capture: true, signal },
    );
    this.canvas.addEventListener(
      "pointerdown",
      (event) => this.handlePointerDown(event),
      { capture: true, signal },
    );
    this.canvas.addEventListener(
      "dblclick",
      (event) => {
        if (!this.activeTool) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !this.activeTool) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.firstPoint) {
          this.firstPoint = null;
          this.hover = null;
          this.onStatus("첫 번째 점 선택을 취소했습니다.");
          this.redraw();
        } else {
          this.activate(null);
        }
      },
      { capture: true, signal },
    );
  }

  setEnabled(enabled) {
    this.toolbar.hidden = !enabled;
    for (const button of this.toolbar.querySelectorAll("button")) {
      button.disabled = !enabled;
    }
  }

  addSource(id, source) {
    this.removeDetailSource(id);
    this.removeCurveSource(id);
    const curveState = {
      curves: new Map(),
      byteLength: 0,
      state: "idle",
    };
    this.curveStates.set(id, curveState);
    this.sources.set(
      id,
      Object.freeze({
        ...source,
        exactCurves: curveState.curves,
      }),
    );
    this.index = null;
    if (this.activeTool) {
      this.loadExactCurves();
    }
  }

  removeSource(id) {
    this.sources.delete(id);
    this.removeDetailSource(id);
    this.removeCurveSource(id);
    this.index = null;
  }

  removeCurveSource(sourceId) {
    const state = this.curveStates.get(sourceId);
    if (!state) {
      return false;
    }
    this.curveStates.delete(sourceId);
    this.curveBytes = Math.max(
      this.curveBytes - state.byteLength,
      0,
    );
    state.curves.clear();
    return true;
  }

  clearExactCurves() {
    this.curveRevision += 1;
    this.curveBytes = 0;
    for (const state of this.curveStates.values()) {
      state.curves.clear();
      state.byteLength = 0;
      state.state = "idle";
    }
  }

  loadExactCurves() {
    if (!this.activeTool) {
      return this.curveLoadPromise;
    }
    const revision = this.curveRevision;
    this.curveLoadPromise = this.curveLoadPromise
      .catch(() => undefined)
      .then(async () => {
        for (const [sourceId, source] of this.sources) {
          if (
            revision !== this.curveRevision ||
            !this.activeTool ||
            this.curveBytes >= MAX_EXACT_CURVE_REVIEW_BYTES
          ) {
            return;
          }
          const state = this.curveStates.get(sourceId);
          if (
            !state ||
            state.state !== "idle" ||
            typeof source.reader?.readReviewCurves !== "function"
          ) {
            continue;
          }
          state.state = "loading";
          try {
            const loaded = await source.reader.readReviewCurves({
              maximumBytes:
                MAX_EXACT_CURVE_REVIEW_BYTES - this.curveBytes,
            });
            if (
              revision !== this.curveRevision ||
              !this.activeTool ||
              this.sources.get(sourceId) !== source
            ) {
              return;
            }
            for (const [handle, curve] of loaded.curves) {
              state.curves.set(handle, curve);
            }
            state.byteLength = loaded.byteLength;
            state.state = "ready";
            state.truncated = loaded.truncated;
            this.curveBytes += loaded.byteLength;
          } catch {
            if (
              revision === this.curveRevision &&
              this.sources.get(sourceId) === source
            ) {
              state.state = "error";
            }
          }
        }
      });
    return this.curveLoadPromise;
  }

  detailKey(sourceId, batchId) {
    return `${sourceId}:${batchId}`;
  }

  removeDetailEntry(key) {
    const entry = this.detailEntries.get(key);
    if (!entry) {
      return false;
    }
    this.detailEntries.delete(key);
    this.detailBytes = Math.max(this.detailBytes - entry.byteLength, 0);
    return true;
  }

  removeDetailBatch(sourceId, batchId) {
    return this.removeDetailEntry(this.detailKey(sourceId, batchId));
  }

  removeDetailSource(sourceId) {
    this.detailSelections.delete(sourceId);
    for (const [key, entry] of this.detailEntries) {
      if (entry.sourceId === sourceId) {
        this.removeDetailEntry(key);
      }
    }
  }

  setDetailSelection(sourceId, candidates) {
    const selected = new Map(
      [...(candidates ?? [])].map((candidate) => [
        candidate.batch.id,
        candidate,
      ]),
    );
    this.detailSelections.set(sourceId, selected);
    for (const [key, entry] of this.detailEntries) {
      if (entry.sourceId !== sourceId) {
        continue;
      }
      const candidate = selected.get(entry.batch.id);
      if (!candidate) {
        this.removeDetailEntry(key);
        continue;
      }
      if (
        !sameInstanceSelection(
          entry.candidate.instanceIndices,
          candidate.instanceIndices,
        )
      ) {
        entry.candidate = candidate;
        entry.index = null;
      }
    }
  }

  addDetailBatch(sourceId, batch, vertices, candidate) {
    const source = this.sources.get(sourceId);
    const selection = this.detailSelections.get(sourceId);
    const selected = selection
      ? selection.get(batch?.id)
      : candidate;
    const byteLength = vertices?.byteLength ?? vertices?.buffer?.byteLength;
    if (
      !this.activeTool ||
      !source ||
      !selected ||
      !(vertices?.buffer instanceof ArrayBuffer) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength <= 0 ||
      byteLength > MAX_DETAIL_REVIEW_BYTES ||
      !Number.isInteger(vertices.recordSize) ||
      vertices.recordSize < 32
    ) {
      return false;
    }
    const key = this.detailKey(sourceId, batch.id);
    this.removeDetailEntry(key);
    while (
      this.detailEntries.size >= MAX_DETAIL_REVIEW_BATCHES ||
      this.detailBytes > MAX_DETAIL_REVIEW_BYTES - byteLength
    ) {
      const oldest = this.detailEntries.keys().next().value;
      if (oldest === undefined) {
        return false;
      }
      this.removeDetailEntry(oldest);
    }
    this.detailEntries.set(key, {
      sourceId,
      batch,
      vertices,
      candidate: selected,
      byteLength,
      index: null,
    });
    this.detailBytes += byteLength;
    return true;
  }

  detailIndex(entry) {
    if (entry.index) {
      return entry.index;
    }
    const source = this.sources.get(entry.sourceId);
    if (!source) {
      return null;
    }
    const batch = Object.freeze({
      ...entry.batch,
      firstVertex: 0,
      lodLevel: 0,
    });
    entry.index = new OverviewSnapIndex(
      [
        {
          ...source,
          batches: [batch],
          vertices: entry.vertices,
          instanceIndices: entry.candidate.instanceIndices,
        },
      ],
      {
        layerZeroIndex: this.scene.renderer.layerZeroIndex,
        getLayerVisibility: this.getLayerVisibility,
      },
    );
    return entry.index;
  }

  ensureIndex() {
    if (this.index) {
      return this.index;
    }
    const started = performance.now();
    this.index = new OverviewSnapIndex([...this.sources.values()], {
      layerZeroIndex: this.scene.renderer.layerZeroIndex,
      getLayerVisibility: this.getLayerVisibility,
    });
    const snapshot = this.index.snapshot();
    const elapsed = performance.now() - started;
    this.onStatus(
      `검토 인덱스 ${snapshot.segments.toLocaleString()}개 선분 준비 · ` +
        `${elapsed.toFixed(0)} ms` +
        (snapshot.truncated ? " · 인스턴스 상한 적용" : ""),
    );
    return this.index;
  }

  activate(tool) {
    const next = tool === this.activeTool ? null : tool;
    this.activeTool = next;
    this.firstPoint = null;
    this.hover = null;
    this.canvas.classList.toggle("reviewing", Boolean(next));
    for (const button of this.toolbar.querySelectorAll("[data-review-tool]")) {
      const pressed = button.dataset.reviewTool === next;
      button.setAttribute("aria-pressed", String(pressed));
    }
    this.onReviewModeChange(Boolean(next));
    if (next) {
      this.loadExactCurves();
      this.ensureIndex();
      this.onStatus(
        next === "distance"
          ? "첫 번째 점을 선택하세요. 끝점·중간점·사분점·근처점에 자동 스냅됩니다."
          : next === "coordinate"
            ? "좌표를 확인할 객체의 점을 선택하세요."
            : "속성을 확인할 선형 객체를 선택하세요.",
      );
    } else {
      this.clearExactCurves();
      this.onStatus("검토 도구를 종료했습니다. 마우스로 도면을 이동할 수 있습니다.");
    }
    this.redraw();
  }

  clear({ keepResult = false } = {}) {
    this.firstPoint = null;
    this.hover = null;
    this.selection = null;
    if (!keepResult) {
      this.result.hidden = true;
    }
    this.redraw();
  }

  find(event, snapKinds) {
    const camera = this.camera ?? this.getCamera();
    if (!camera) {
      return null;
    }
    const pointer = pointerPosition(event, this.canvas);
    const world = screenToWorld(
      camera,
      pointer.x,
      pointer.y,
      pointer.width,
      pointer.height,
    );
    const options = {
      width: pointer.width,
      height: pointer.height,
      snapKinds,
    };
    let best = this.ensureIndex().find(world, camera, options);
    for (const entry of this.detailEntries.values()) {
      best = betterCandidate(
        best,
        this.detailIndex(entry)?.find(world, camera, options),
      );
    }
    return best;
  }

  handlePointerMove(event) {
    if (!this.activeTool) {
      return;
    }
    this.hover = this.find(
      event,
      this.activeTool === "select"
        ? ["nearest"]
        : [
            "endpoint",
            "midpoint",
            "quadrant",
            "nearest",
          ],
    );
    this.redraw();
  }

  handlePointerDown(event) {
    if (!this.activeTool || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const candidate =
      this.hover ??
      this.find(
        event,
        this.activeTool === "select"
          ? ["nearest"]
          : [
              "endpoint",
              "midpoint",
              "quadrant",
              "nearest",
            ],
      );
    if (!candidate) {
      this.onStatus("표시된 선 가까이에서 다시 선택하세요.");
      return;
    }
    if (this.activeTool === "select") {
      this.selection = candidate;
      this.showSelection(candidate);
    } else if (this.activeTool === "coordinate") {
      this.selection = candidate;
      this.showCoordinate(candidate);
    } else {
      this.selectDistancePoint(candidate);
    }
    this.redraw();
  }

  showSelection(candidate) {
    const handle = candidate.handle.toString(16).toUpperCase();
    const rows = [
      ["핸들", handle ? `0x${handle}` : "—"],
      ["레이어", candidate.layerName || `#${candidate.layerIndex}`],
      ["참조", candidate.sourceLabel || "현재 도면"],
      ["스냅", SNAP_LABELS[candidate.kind] ?? candidate.kind],
    ];
    if (candidate.approximated) {
      rows.push(["정밀도", "화면 근사 형상"]);
    }
    this.showResult(
      `${candidate.sourceKindName} 선택`,
      rows,
    );
    this.onStatus(
      `${candidate.sourceKindName} · ${candidate.layerName || "레이어 없음"} · 핸들 0x${handle}`,
    );
  }

  showCoordinate(candidate) {
    const unit = unitLabel(this.scene.metadata.drawing.insertionUnits);
    const rows = [
      ["X", `${formatNumber(candidate.measurementPoint[0])} ${unit}`],
      ["Y", `${formatNumber(candidate.measurementPoint[1])} ${unit}`],
      ["Z", `${formatNumber(candidate.measurementPoint[2])} ${unit}`],
      ["스냅", SNAP_LABELS[candidate.kind] ?? candidate.kind],
    ];
    if (candidate.approximated) {
      rows.push(["정밀도", "화면 근사 형상"]);
    }
    this.showResult("점 좌표", rows);
    this.onStatus(pointText(candidate.measurementPoint, unit));
  }

  selectDistancePoint(candidate) {
    if (!this.firstPoint) {
      this.firstPoint = candidate;
      this.onStatus(
        `첫 점: ${SNAP_LABELS[candidate.kind] ?? candidate.kind} · 두 번째 점을 선택하세요.`,
      );
      return;
    }
    if (this.firstPoint.coordinateSpace !== candidate.coordinateSpace) {
      this.onStatus(
        "모델 공간과 종이 공간의 점은 직접 비교할 수 없습니다. 같은 공간에서 두 점을 선택하세요.",
      );
      return;
    }
    const first = this.firstPoint.measurementPoint;
    const last = candidate.measurementPoint;
    const deltaX = last[0] - first[0];
    const deltaY = last[1] - first[1];
    const deltaZ = last[2] - first[2];
    const distance = Math.hypot(deltaX, deltaY, deltaZ);
    const angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
    const unit = unitLabel(this.scene.metadata.drawing.insertionUnits);
    this.selection = candidate;
    const rows = [
      ["거리", `${formatNumber(distance)} ${unit}`],
      ["ΔX", `${formatNumber(deltaX)} ${unit}`],
      ["ΔY", `${formatNumber(deltaY)} ${unit}`],
      ["ΔZ", `${formatNumber(deltaZ)} ${unit}`],
      ["각도", `${formatNumber(angle)}°`],
    ];
    if (this.firstPoint.approximated || candidate.approximated) {
      rows.push(["정밀도", "곡선 화면 근사 포함"]);
    }
    this.showResult("두 점 거리", rows);
    this.onStatus(
      `거리 ${formatNumber(distance)} ${unit} · ΔX ${formatNumber(deltaX)} · ΔY ${formatNumber(deltaY)} · 각도 ${formatNumber(angle)}°`,
    );
    this.firstPoint = null;
  }

  showResult(title, rows) {
    this.result.querySelector("[data-review-title]").textContent = title;
    const content = this.result.querySelector("[data-review-content]");
    content.replaceChildren(resultRows(rows));
    this.result.hidden = false;
  }

  setCamera(camera) {
    this.camera = camera;
    this.redraw();
  }

  marker(context, point, kind, color = "#5eead4") {
    const camera = this.camera ?? this.getCamera();
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const [x, y] = worldToScreen(camera, point, width, height);
    context.save();
    context.translate(x, y);
    context.strokeStyle = color;
    context.fillStyle = "rgba(9, 17, 27, 0.82)";
    context.lineWidth = 1.8;
    context.beginPath();
    if (kind === "endpoint") {
      context.rect(-5, -5, 10, 10);
    } else if (kind === "midpoint") {
      context.moveTo(0, -6);
      context.lineTo(6, 5);
      context.lineTo(-6, 5);
      context.closePath();
    } else if (kind === "quadrant") {
      context.arc(0, 0, 5, 0, Math.PI * 2);
    } else {
      context.moveTo(0, -6);
      context.lineTo(6, 0);
      context.lineTo(0, 6);
      context.lineTo(-6, 0);
      context.closePath();
    }
    context.fill();
    context.stroke();
    context.restore();
  }

  redraw() {
    const context = this.overlay.getContext("2d", { alpha: true });
    const camera = this.camera ?? this.getCamera();
    if (!context || !camera) {
      return;
    }
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    const scaleX = Math.max(this.canvas.width, 1) / width;
    const scaleY = Math.max(this.canvas.height, 1) / height;
    if (
      this.overlay.width !== this.canvas.width ||
      this.overlay.height !== this.canvas.height
    ) {
      this.overlay.width = this.canvas.width;
      this.overlay.height = this.canvas.height;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.overlay.width, this.overlay.height);
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    const selected = this.selection;
    if (selected?.displaySegment) {
      const first = worldToScreen(camera, selected.displaySegment[0], width, height);
      const last = worldToScreen(camera, selected.displaySegment[1], width, height);
      context.strokeStyle = "rgba(250, 204, 21, 0.92)";
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(...first);
      context.lineTo(...last);
      context.stroke();
    }
    if (this.firstPoint) {
      this.marker(
        context,
        this.firstPoint.displayPoint,
        this.firstPoint.kind,
        "#facc15",
      );
      if (
        this.hover &&
        this.hover.coordinateSpace === this.firstPoint.coordinateSpace
      ) {
        const first = worldToScreen(
          camera,
          this.firstPoint.displayPoint,
          width,
          height,
        );
        const last = worldToScreen(
          camera,
          this.hover.displayPoint,
          width,
          height,
        );
        context.save();
        context.strokeStyle = "rgba(250, 204, 21, 0.9)";
        context.lineWidth = 1.6;
        context.setLineDash([7, 5]);
        context.beginPath();
        context.moveTo(...first);
        context.lineTo(...last);
        context.stroke();
        context.restore();
      }
    }
    if (this.hover) {
      this.marker(context, this.hover.displayPoint, this.hover.kind);
    }
  }

  dispose() {
    this.abortController.abort();
    this.onReviewModeChange(false);
    this.activeTool = null;
    this.clearExactCurves();
    this.curveStates.clear();
    this.detailSelections.clear();
    this.detailEntries.clear();
    this.detailBytes = 0;
    this.canvas.classList.remove("reviewing");
    this.toolbar.hidden = true;
    this.result.hidden = true;
    const context = this.overlay.getContext("2d", { alpha: true });
    context?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}

export { TOOL_LABELS, formatNumber, unitLabel };
