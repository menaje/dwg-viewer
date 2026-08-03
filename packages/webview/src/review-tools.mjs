import {
  ViewerReviewUiController,
} from "@dwg-viewer/viewer-ui";

import {
  OverviewSnapIndex,
  screenToWorld,
  worldToScreen,
} from "./measurement.mjs?v=1.18.9";
import {
  CompositeFilledObjectSelectionIndex,
} from "./filled-object-review.mjs";
import {
  COMMON_DISPLAY_UNITS,
  calibrationFromKnownDistance,
  createMeasurementFormat,
  formatMeasurementNumber,
  insertionUnitInfo,
  normalizeMeasurementPreferences,
} from "./measurement-format.mjs";

const TOOL_LABELS = Object.freeze({
  select: "객체 선택",
  distance: "두 점 거리",
  path: "누적 거리",
  area: "면적·둘레",
  angle: "세 점 각도",
  radius: "반지름·지름",
  coordinate: "점 좌표",
  calibrate: "측정 단위 보정",
});

const SNAP_LABELS = Object.freeze({
  entity: "객체",
  endpoint: "끝점",
  intersection: "교차점",
  midpoint: "중간점",
  quadrant: "사분점",
  center: "중심점",
  perpendicular: "수직점",
  insertion: "삽입점",
  nearest: "근처점",
});

const MAX_DETAIL_REVIEW_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_REVIEW_BATCHES = 96;
const MAX_EXACT_CURVE_REVIEW_BYTES = 4 * 1024 * 1024;
const MAX_MEASUREMENT_POINTS = 256;

function formatNumber(value) {
  return formatMeasurementNumber(value);
}

function unitLabel(code) {
  return insertionUnitInfo(code).label;
}

function pointText(point, unit) {
  return (
    `X ${formatNumber(point[0])} · ` +
    `Y ${formatNumber(point[1])} · ` +
    `Z ${formatNumber(point[2])} ${unit}`
  );
}

function pointDistance(first, last) {
  return Math.hypot(
    last[0] - first[0],
    last[1] - first[1],
    last[2] - first[2],
  );
}

function polylineLength(points, { closed = false } = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return 0;
  }
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += pointDistance(points[index - 1], points[index]);
  }
  if (closed && points.length > 2) {
    length += pointDistance(points.at(-1), points[0]);
  }
  return length;
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return 0;
  }
  let doubledArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    doubledArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(doubledArea) / 2;
}

function angleAtVertex(first, vertex, last) {
  const firstVector = [
    first[0] - vertex[0],
    first[1] - vertex[1],
    first[2] - vertex[2],
  ];
  const lastVector = [
    last[0] - vertex[0],
    last[1] - vertex[1],
    last[2] - vertex[2],
  ];
  const firstLength = Math.hypot(...firstVector);
  const lastLength = Math.hypot(...lastVector);
  if (firstLength <= Number.EPSILON || lastLength <= Number.EPSILON) {
    return null;
  }
  const cosine =
    (firstVector[0] * lastVector[0] +
      firstVector[1] * lastVector[1] +
      firstVector[2] * lastVector[2]) /
    (firstLength * lastLength);
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
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
    entity: 0,
    endpoint: 1,
    intersection: 2,
    midpoint: 3,
    center: 4,
    quadrant: 5,
    perpendicular: 6,
    insertion: 7,
    nearest: 8,
  }[candidate?.kind] ?? 9;
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

function handleText(value) {
  if (typeof value !== "bigint" || value <= 0n) {
    return "—";
  }
  return `0x${value.toString(16).toUpperCase()}`;
}

function colorText(value) {
  if (!Number.isInteger(value)) {
    return "—";
  }
  const encoded = value >>> 0;
  const kind = encoded >>> 30;
  if (kind === 0) {
    return "ByLayer";
  }
  if (kind === 1) {
    return "ByBlock";
  }
  if (kind === 2) {
    return `ACI ${encoded & 255}`;
  }
  return `RGB #${(encoded & 0xffffff)
    .toString(16)
    .padStart(6, "0")
    .toUpperCase()}`;
}

function lineWeightText(value) {
  if (value === -3) {
    return "기본값";
  }
  if (value === -2) {
    return "ByBlock";
  }
  if (value === -1) {
    return "ByLayer";
  }
  return Number.isInteger(value)
    ? `${formatNumber(value / 100)} mm`
    : "—";
}

function linetypeText(code, source) {
  if (code === 0) {
    return "ByLayer";
  }
  if (code === 1) {
    return "ByBlock";
  }
  if (code === 2) {
    return "Continuous";
  }
  return (
    source?.linetypes?.find((linetype) => linetype.code === code)?.name ??
    (Number.isInteger(code) ? `코드 ${code}` : "—")
  );
}

function cleanedText(value) {
  return String(value ?? "")
    .replaceAll("\\P", "\n")
    .replace(/\\[A-Za-z](?:[^;{}]*;)?/gu, "")
    .replace(/[{}]/gu, "")
    .trim();
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
    findOverlayCandidates = () => [],
    onIsolateLayer = () => {},
    onRestoreLayers = () => {},
    loadFilledObjects = async () => null,
    measurementPreferences = {},
    onMeasurementPreferencesChange = () => {},
    onReviewModeChange = () => {},
    onSelectionChange = () => {},
    onStatus = () => {},
  }) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.scene = scene;
    this.instanceGraph = instanceGraph;
    this.getCamera = getCamera;
    this.getLayerVisibility = getLayerVisibility;
    this.onFit = onFit;
    this.findOverlayCandidates = findOverlayCandidates;
    this.onIsolateLayer = onIsolateLayer;
    this.onRestoreLayers = onRestoreLayers;
    this.loadFilledObjects = loadFilledObjects;
    this.onMeasurementPreferencesChange =
      onMeasurementPreferencesChange;
    this.onReviewModeChange = onReviewModeChange;
    this.onSelectionChange = onSelectionChange;
    this.onStatus = onStatus;
    this.reviewUi = new ViewerReviewUiController({
      canvas,
      toolbar,
      result,
      onToolRequest: (tool) => this.activate(tool),
      onAction: (action, context) =>
        this.handleUiAction(action, context),
    });
    const normalizedPreferences =
      normalizeMeasurementPreferences(measurementPreferences);
    const initialMeasurementFormat = createMeasurementFormat(
      scene.metadata.drawing.insertionUnits,
      normalizedPreferences,
    );
    this.measurementPreferences =
      !initialMeasurementFormat.canUsePhysicalUnits &&
      normalizedPreferences.displayUnit !== "auto" &&
      normalizedPreferences.displayUnit !== "drawing"
        ? normalizeMeasurementPreferences({
            ...normalizedPreferences,
            displayUnit: "auto",
          })
        : normalizedPreferences;
    this.measurementFormat = createMeasurementFormat(
      scene.metadata.drawing.insertionUnits,
      this.measurementPreferences,
    );
    this.sources = new Map();
    this.index = null;
    this.detailSelections = new Map();
    this.detailEntries = new Map();
    this.detailBytes = 0;
    this.curveStates = new Map();
    this.curveBytes = 0;
    this.curveRevision = 0;
    this.curveLoadPromise = Promise.resolve();
    this.filledIndex = null;
    this.filledState = "idle";
    this.filledRevision = 0;
    this.filledAbortController = null;
    this.filledLoadPromise = Promise.resolve();
    this.activeTool = null;
    this.hover = null;
    this.firstPoint = null;
    this.measurementGuide = null;
    this.measurementPoints = [];
    this.measurementPath = null;
    this.pendingCalibration = null;
    this.textMatch = null;
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
      blocks: scene.metadata.blocks,
      linetypes: scene.metadata.linetypes,
      reader: scene.reader,
    });
    this.resetToolControls();
    this.bind();
    this.setEnabled(true);
  }

  resetToolControls() {
    return this.reviewUi.resetTools();
  }

  handleUiAction(action, { button } = {}) {
    if (action === "finish") {
      this.finishMeasurement();
      this.redraw();
      return true;
    }
    if (action === "settings") {
      this.showMeasurementSettings();
      return true;
    }
    if (action === "fit") {
      this.onFit();
      this.onStatus("도면 전체가 보이도록 화면을 맞췄습니다.");
      return true;
    }
    if (action === "clear") {
      this.clear();
      return true;
    }
    if (action === "close") {
      this.reviewUi.hideResult();
      this.clear({ keepResult: true });
      return true;
    }
    if (action === "isolate-layer") {
      const layerIndex = Number.parseInt(
        button?.dataset?.layerIndex ?? "",
        10,
      );
      if (!Number.isSafeInteger(layerIndex) || layerIndex < 0) {
        return false;
      }
      const changed = this.onIsolateLayer(layerIndex);
      this.onStatus(
        changed === false
          ? "이미 선택한 레이어만 표시 중입니다."
          : "선택한 객체의 레이어만 표시했습니다.",
      );
      return true;
    }
    if (action === "restore-layers") {
      const restored = this.onRestoreLayers();
      this.onStatus(
        restored === false
          ? "복원할 이전 레이어 상태가 없습니다."
          : "이전 레이어 표시 상태로 복원했습니다.",
      );
      return true;
    }
    return false;
  }

  bind() {
    const signal = this.abortController.signal;
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
        if (!this.activeTool) {
          return;
        }
        if (
          event.key === "Enter" &&
          (this.activeTool === "path" || this.activeTool === "area")
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.finishMeasurement();
          this.redraw();
          return;
        }
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.measurementPoints.length > 0) {
          this.measurementPoints = [];
          this.hover = null;
          this.onStatus("진행 중인 측정을 취소했습니다.");
          this.redraw();
        } else if (this.firstPoint) {
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
    return this.reviewUi.setEnabled(enabled);
  }

  replaceSelection(selection, { reason = "pick" } = {}) {
    this.selection = selection ?? null;
    this.onSelectionChange?.(this.selection, { reason });
    return this.selection;
  }

  clearSelection(reason = "clear") {
    if (this.selection === null || this.selection === undefined) {
      this.selection = null;
      return false;
    }
    this.selection = null;
    this.onSelectionChange?.(null, { reason });
    return true;
  }

  measurementDisplay() {
    if (!this.measurementFormat) {
      this.measurementFormat = createMeasurementFormat(
        this.scene?.metadata?.drawing?.insertionUnits ?? 0,
        this.measurementPreferences,
      );
    }
    return this.measurementFormat;
  }

  setMeasurementPreferences(updates = {}) {
    let preferences = normalizeMeasurementPreferences({
      ...(this.measurementPreferences ?? {}),
      ...updates,
    });
    let measurement = createMeasurementFormat(
      this.scene.metadata.drawing.insertionUnits,
      preferences,
    );
    if (
      !measurement.canUsePhysicalUnits &&
      preferences.displayUnit !== "auto" &&
      preferences.displayUnit !== "drawing"
    ) {
      preferences = normalizeMeasurementPreferences({
        ...preferences,
        displayUnit: "auto",
      });
      measurement = createMeasurementFormat(
        this.scene.metadata.drawing.insertionUnits,
        preferences,
      );
    }
    this.measurementPreferences = preferences;
    this.measurementFormat = measurement;
    this.onMeasurementPreferencesChange?.({
      displayUnit: preferences.displayUnit,
      precision: preferences.precision,
      calibration: preferences.calibration
        ? { ...preferences.calibration }
        : null,
    });
    return measurement;
  }

  showMeasurementSettings() {
    const measurement = this.measurementDisplay();
    const preferences = measurement.preferences;
    const sourceUnit = measurement.sourceUnit;
    const form = document.createElement("form");
    form.className = "measurement-settings-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const summary = document.createElement("p");
    summary.className = "measurement-settings-summary";
    summary.textContent =
      sourceUnit.key === "drawing"
        ? "이 DWG에는 삽입 단위가 지정되어 있지 않습니다."
        : `DWG 지정 단위: ${sourceUnit.label}`;
    form.append(summary);

    const addSelect = (labelText, select) => {
      const field = document.createElement("label");
      field.className = "measurement-setting";
      const label = document.createElement("span");
      label.textContent = labelText;
      field.append(label, select);
      form.append(field);
    };

    const displaySelect = document.createElement("select");
    displaySelect.name = "display-unit";
    const automaticOption = document.createElement("option");
    automaticOption.value = "auto";
    automaticOption.textContent = `자동 (${measurement.displayUnit.label})`;
    displaySelect.append(automaticOption);
    const drawingOption = document.createElement("option");
    drawingOption.value = "drawing";
    drawingOption.textContent =
      sourceUnit.key === "drawing"
        ? "원본 도면 단위"
        : `원본 단위 (${sourceUnit.label})`;
    displaySelect.append(drawingOption);
    for (const unit of COMMON_DISPLAY_UNITS) {
      const option = document.createElement("option");
      option.value = unit.key;
      option.textContent = unit.label;
      option.disabled = !measurement.canUsePhysicalUnits;
      displaySelect.append(option);
    }
    displaySelect.value =
      !measurement.canUsePhysicalUnits &&
      preferences.displayUnit !== "auto" &&
      preferences.displayUnit !== "drawing"
        ? "auto"
        : preferences.displayUnit;
    displaySelect.addEventListener("change", () => {
      this.setMeasurementPreferences({
        displayUnit: displaySelect.value,
      });
      this.showMeasurementSettings();
    });
    addSelect("표시 단위", displaySelect);

    const precisionSelect = document.createElement("select");
    precisionSelect.name = "measurement-precision";
    const automaticPrecision = document.createElement("option");
    automaticPrecision.value = "auto";
    automaticPrecision.textContent = "자동";
    precisionSelect.append(automaticPrecision);
    for (let precision = 0; precision <= 6; precision += 1) {
      const option = document.createElement("option");
      option.value = String(precision);
      option.textContent = `소수 ${precision}자리`;
      precisionSelect.append(option);
    }
    precisionSelect.value =
      preferences.precision === null
        ? "auto"
        : String(preferences.precision);
    precisionSelect.addEventListener("change", () => {
      this.setMeasurementPreferences({
        precision:
          precisionSelect.value === "auto"
            ? null
            : Number.parseInt(precisionSelect.value, 10),
      });
      this.showMeasurementSettings();
    });
    addSelect("표시 정밀도", precisionSelect);

    const preview = document.createElement("p");
    preview.className = "measurement-settings-preview";
    preview.textContent = `표시 예: ${measurement.length(1234.5678)}`;
    form.append(preview);

    if (sourceUnit.key === "drawing") {
      const calibration = document.createElement("section");
      calibration.className = "measurement-calibration";
      const heading = document.createElement("strong");
      heading.textContent = "실제 단위 보정";
      calibration.append(heading);

      const help = document.createElement("p");
      help.className = "measurement-settings-help";
      if (preferences.calibration) {
        const referenceUnit = COMMON_DISPLAY_UNITS.find(
          (unit) => unit.key === preferences.calibration.referenceUnit,
        );
        help.textContent =
          `보정됨: ${formatNumber(preferences.calibration.drawingDistance)} 도면 단위 = ` +
          `${formatNumber(preferences.calibration.referenceDistance)} ${referenceUnit?.label ?? preferences.calibration.referenceUnit}`;
      } else {
        help.textContent =
          "보정 전에는 실제 mm·m·in 값으로 표시하지 않습니다. 실제 길이를 아는 구간의 두 점을 선택해 보정하세요.";
      }
      calibration.append(help);

      if (this.pendingCalibration) {
        const selected = document.createElement("p");
        selected.className = "measurement-settings-selection";
        selected.textContent =
          `선택한 구간: ${formatNumber(this.pendingCalibration.drawingDistance)} 도면 단위` +
          (this.pendingCalibration.approximated
            ? " · 화면 근사 포함"
            : "");
        calibration.append(selected);

        const referenceRow = document.createElement("div");
        referenceRow.className = "measurement-reference-row";
        const input = document.createElement("input");
        input.type = "number";
        input.name = "reference-distance";
        input.min = "0";
        input.step = "any";
        input.inputMode = "decimal";
        input.placeholder = "실제 거리";
        input.setAttribute("aria-label", "선택한 구간의 실제 거리");
        const unitSelect = document.createElement("select");
        unitSelect.name = "reference-unit";
        unitSelect.setAttribute("aria-label", "실제 거리 단위");
        for (const unit of COMMON_DISPLAY_UNITS) {
          const option = document.createElement("option");
          option.value = unit.key;
          option.textContent = unit.label;
          unitSelect.append(option);
        }
        unitSelect.value =
          preferences.calibration?.referenceUnit ??
          (COMMON_DISPLAY_UNITS.some(
            (unit) => unit.key === measurement.displayUnit.key,
          )
            ? measurement.displayUnit.key
            : "mm");
        referenceRow.append(input, unitSelect);
        calibration.append(referenceRow);

        const validation = document.createElement("p");
        validation.className = "measurement-settings-validation";
        validation.setAttribute("role", "alert");
        calibration.append(validation);

        const apply = document.createElement("button");
        apply.type = "button";
        apply.className = "measurement-primary-action";
        apply.textContent = "이 거리로 보정";
        apply.addEventListener("click", () => {
          const referenceDistance = Number(input.value);
          const result = calibrationFromKnownDistance(
            this.pendingCalibration.drawingDistance,
            referenceDistance,
            unitSelect.value,
          );
          if (!result) {
            validation.textContent =
              "0보다 큰 실제 거리를 입력하세요.";
            input.focus();
            return;
          }
          const selectedUnit = COMMON_DISPLAY_UNITS.find(
            (unit) => unit.key === unitSelect.value,
          );
          this.pendingCalibration = null;
          this.setMeasurementPreferences({
            calibration: result,
            displayUnit: unitSelect.value,
          });
          this.onStatus(
            `측정 단위를 보정했습니다. 이후 결과를 ${selectedUnit?.label ?? unitSelect.value} 단위로 표시합니다.`,
          );
          this.showMeasurementSettings();
          this.redraw();
        });
        calibration.append(apply);
      }

      const actions = document.createElement("div");
      actions.className = "measurement-settings-actions";
      const selectPoints = document.createElement("button");
      selectPoints.type = "button";
      selectPoints.textContent = preferences.calibration
        ? "다시 두 점 선택"
        : "두 점으로 보정";
      selectPoints.addEventListener("click", () =>
        this.startMeasurementCalibration(),
      );
      actions.append(selectPoints);
      if (preferences.calibration) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.textContent = "보정 초기화";
        reset.addEventListener("click", () => {
          this.pendingCalibration = null;
          this.measurementGuide = null;
          this.setMeasurementPreferences({
            calibration: null,
            displayUnit: "auto",
          });
          this.onStatus(
            "측정 단위 보정을 초기화했습니다. 값을 도면 단위로 표시합니다.",
          );
          this.showMeasurementSettings();
          this.redraw();
        });
        actions.append(reset);
      }
      calibration.append(actions);
      form.append(calibration);
    }

    this.reviewUi.showContent({
      title: "측정 설정",
      content: form,
      view: "measurement-settings",
    });
  }

  startMeasurementCalibration() {
    if (this.measurementDisplay().sourceUnit.key !== "drawing") {
      this.onStatus("DWG에 지정된 단위를 사용하므로 보정할 필요가 없습니다.");
      return false;
    }
    this.pendingCalibration = null;
    this.measurementGuide = null;
    this.measurementPath = null;
    this.clearSelection("measurement.start");
    this.reviewUi.hideResult();
    if (this.activeTool === "calibrate") {
      this.firstPoint = null;
      this.hover = null;
      this.onStatus(
        "실제 길이를 알고 있는 구간의 첫 번째 점을 선택하세요.",
      );
      this.redraw();
    } else {
      this.activate("calibrate");
    }
    return true;
  }

  selectCalibrationPoint(candidate) {
    if (!this.firstPoint) {
      this.firstPoint = candidate;
      this.onStatus(
        `보정 첫 점: ${SNAP_LABELS[candidate.kind] ?? candidate.kind} · 두 번째 점을 선택하세요.`,
      );
      return false;
    }
    if (this.firstPoint.coordinateSpace !== candidate.coordinateSpace) {
      this.onStatus(
        "모델 공간과 종이 공간의 점은 보정에 함께 사용할 수 없습니다. 같은 공간에서 선택하세요.",
      );
      return false;
    }
    const firstCandidate = this.firstPoint;
    const drawingDistance = pointDistance(
      firstCandidate.measurementPoint,
      candidate.measurementPoint,
    );
    if (drawingDistance <= Number.EPSILON) {
      this.onStatus("첫 점과 다른 위치의 두 번째 점을 선택하세요.");
      return false;
    }
    this.measurementGuide = Object.freeze({
      first: Object.freeze([...firstCandidate.displayPoint]),
      last: Object.freeze([...candidate.displayPoint]),
      firstKind: firstCandidate.kind,
      lastKind: candidate.kind,
    });
    this.pendingCalibration = Object.freeze({
      drawingDistance,
      approximated:
        Boolean(firstCandidate.approximated) ||
        Boolean(candidate.approximated),
    });
    this.activate(null);
    this.showMeasurementSettings();
    this.onStatus(
      `선택한 구간은 ${formatNumber(drawingDistance)} 도면 단위입니다. 실제 거리를 입력하세요.`,
    );
    return true;
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
              const linetypeCode =
                !(source.linetypeMap instanceof Uint16Array) ||
                curve.linetypeCode >= source.linetypeMap.length
                  ? curve.linetypeCode
                  : source.linetypeMap[curve.linetypeCode];
              state.curves.set(
                handle,
                Object.freeze({
                  ...curve,
                  linetypeCode,
                }),
              );
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
          includeInsertions: false,
          wholeObjectMeasurements: false,
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

  releaseFilledObjects() {
    this.filledRevision += 1;
    this.filledAbortController?.abort();
    this.filledAbortController = null;
    this.filledIndex = null;
    this.filledState = "idle";
  }

  refreshFilledObjects() {
    const reload = this.activeTool === "select";
    this.releaseFilledObjects();
    return reload ? this.prepareFilledObjects() : this.filledLoadPromise;
  }

  prepareFilledObjects() {
    if (
      this.activeTool !== "select" ||
      this.filledState === "loading" ||
      this.filledState === "ready"
    ) {
      return this.filledLoadPromise;
    }
    const revision = ++this.filledRevision;
    const controller = new AbortController();
    this.filledAbortController = controller;
    this.filledState = "loading";
    this.filledLoadPromise = Promise.resolve()
      .then(() =>
        this.loadFilledObjects({
          signal: controller.signal,
        }),
      )
      .then((data) => {
        if (
          !data ||
          controller.signal.aborted ||
          revision !== this.filledRevision ||
          this.activeTool !== "select"
        ) {
          if (
            !controller.signal.aborted &&
            revision === this.filledRevision &&
            this.activeTool === "select"
          ) {
            this.filledState = "idle";
          }
          return null;
        }
        const collection = Array.isArray(data.sources)
          ? data
          : {
              sources: [
                {
                  id: "root",
                  label: "현재 도면",
                  layers: this.scene.metadata.layers,
                  data,
                },
              ],
              truncated: Boolean(data.truncated),
              failedSources: 0,
            };
        this.filledIndex = new CompositeFilledObjectSelectionIndex(
          collection.sources,
          {
            truncated: collection.truncated,
            failedSources: collection.failedSources,
            getLayerVisibility: this.getLayerVisibility,
          },
        );
        this.filledState = "ready";
        const snapshot = this.filledIndex.snapshot();
        const sourceSummary =
          snapshot.sources > 1
            ? ` · 외부참조 포함 ${snapshot.sources.toLocaleString()}개 도면`
            : "";
        const failedSummary =
          snapshot.failedSources > 0
            ? ` · 참조 ${snapshot.failedSources.toLocaleString()}개 생략`
            : "";
        this.onStatus(
          `해치·솔리드·3D 면 ${snapshot.records.toLocaleString()}개 선택 준비 완료` +
            sourceSummary +
            failedSummary +
            (snapshot.truncated ? " · 안전 상한 적용" : ""),
        );
        this.redraw();
        return this.filledIndex;
      })
      .catch((error) => {
        if (
          error?.name === "AbortError" ||
          controller.signal.aborted ||
          revision !== this.filledRevision
        ) {
          return null;
        }
        this.filledState = "error";
        this.onStatus(
          `해치·솔리드·3D 면 선택 정보 준비 실패: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      })
      .finally(() => {
        if (this.filledAbortController === controller) {
          this.filledAbortController = null;
        }
      });
    return this.filledLoadPromise;
  }

  activate(tool) {
    const next = tool === this.activeTool ? null : tool;
    this.activeTool = next;
    this.firstPoint = null;
    this.measurementPoints = [];
    this.textMatch = null;
    this.hover = null;
    this.reviewUi.setActiveTool(next);
    this.onReviewModeChange(Boolean(next));
    if (next) {
      this.loadExactCurves();
      this.ensureIndex();
      const instructions = {
        distance:
          "첫 번째 점을 선택하세요. 끝점·교차점·중심점·수직점·삽입점 등에 자동 스냅됩니다.",
        path:
          "누적 거리의 첫 점을 선택하세요. 점을 추가한 뒤 Enter 또는 측정 완료를 누르세요.",
        area:
          "영역의 첫 꼭짓점을 선택하세요. 세 점 이상 선택한 뒤 Enter 또는 측정 완료를 누르세요.",
        angle:
          "각도의 첫 번째 방향점을 선택하세요. 다음으로 꼭짓점과 두 번째 방향점을 선택합니다.",
        radius: "반지름이나 지름을 확인할 호·원·타원을 선택하세요.",
        coordinate: "좌표를 확인할 객체의 점을 선택하세요.",
        calibrate:
          "실제 길이를 알고 있는 구간의 첫 번째 점을 선택하세요.",
        select:
          "속성을 확인할 선·곡선·해치·솔리드·3D 면·문자·블록·이미지를 선택하세요.",
      };
      this.onStatus(instructions[next] ?? "검토할 객체를 선택하세요.");
      if (next === "select") {
        this.prepareFilledObjects();
      } else {
        this.releaseFilledObjects();
      }
    } else {
      this.releaseFilledObjects();
      this.clearExactCurves();
      this.onStatus("검토 도구를 종료했습니다. 마우스로 도면을 이동할 수 있습니다.");
    }
    this.redraw();
  }

  clear({ keepResult = false } = {}) {
    this.firstPoint = null;
    this.measurementPoints = [];
    this.hover = null;
    this.measurementGuide = null;
    this.measurementPath = null;
    this.pendingCalibration = null;
    this.textMatch = null;
    this.clearSelection("clear");
    if (!keepResult) {
      this.reviewUi.hideResult();
    }
    this.redraw();
  }

  snapKinds() {
    return this.activeTool === "select"
      ? ["entity", "insertion", "nearest"]
      : [
          "endpoint",
          "intersection",
          "midpoint",
          "center",
          "quadrant",
          "perpendicular",
          "insertion",
          "nearest",
        ];
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
      referencePoint:
        this.measurementPoints.at(-1)?.displayPoint ??
        this.firstPoint?.displayPoint ??
        null,
    };
    const overviewBest = this.ensureIndex().find(world, camera, options);
    let best = overviewBest;
    best = betterCandidate(
      best,
      this.filledIndex?.find(world, camera, options),
    );
    for (const entry of this.detailEntries.values()) {
      best = betterCandidate(
        best,
        this.detailIndex(entry)?.find(world, camera, options),
      );
    }
    const overlayCandidates = this.findOverlayCandidates({
      x: pointer.x,
      y: pointer.y,
      snapKinds,
      tolerancePixels: 18,
    });
    for (const candidate of Array.isArray(overlayCandidates)
      ? overlayCandidates
      : [overlayCandidates]) {
      best = betterCandidate(best, candidate);
    }
    if (
      best &&
      !best.objectMeasurement &&
      overviewBest?.objectMeasurement &&
      best.handle === overviewBest.handle &&
      best.sourceId === overviewBest.sourceId &&
      best.coordinateSpace === overviewBest.coordinateSpace
    ) {
      best = Object.freeze({
        ...best,
        objectMeasurement: overviewBest.objectMeasurement,
        approximated:
          best.approximated ||
          overviewBest.objectMeasurement.approximated,
      });
    }
    return best;
  }

  handlePointerMove(event) {
    if (!this.activeTool) {
      return;
    }
    this.hover = this.find(event, this.snapKinds());
    this.redraw();
  }

  handlePointerDown(event) {
    if (!this.activeTool || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const candidate =
      this.find(event, this.snapKinds()) ?? this.hover;
    if (!candidate) {
      this.onStatus("표시된 객체 가까이에서 다시 선택하세요.");
      return;
    }
    if (this.activeTool === "select") {
      this.replaceSelection(candidate, { reason: "pick" });
      this.showSelection(candidate);
    } else if (this.activeTool === "coordinate") {
      this.replaceSelection(candidate, { reason: "coordinate" });
      this.showCoordinate(candidate);
    } else if (this.activeTool === "distance") {
      this.selectDistancePoint(candidate);
    } else if (this.activeTool === "calibrate") {
      this.selectCalibrationPoint(candidate);
    } else if (this.activeTool === "radius") {
      this.showCurveMeasurement(candidate);
    } else {
      this.selectMultiPoint(candidate);
    }
    this.redraw();
  }

  showSelection(candidate) {
    const source = this.sources.get(candidate.sourceId);
    const measurement = this.measurementDisplay();
    const rows = [
      ["종류", candidate.sourceKindName || "도면 객체"],
      ["핸들", handleText(candidate.handle)],
      ["레이어", candidate.layerName || `#${candidate.layerIndex}`],
      ["참조", candidate.sourceLabel || "현재 도면"],
      ["색상", colorText(candidate.color)],
      ["선종류", linetypeText(candidate.linetypeCode, source)],
      ["선가중치", lineWeightText(candidate.lineWeight)],
    ];
    const record = candidate.entityRecord;
    if (candidate.entityType === "text" && record) {
      const value = cleanedText(record.value);
      rows.push(["내용", value ? value.slice(0, 500) : "—"]);
      if (record.tag) {
        rows.push(["태그", String(record.tag).slice(0, 160)]);
      }
      if (record.prompt) {
        rows.push(["프롬프트", String(record.prompt).slice(0, 240)]);
      }
      if (record.style?.name) {
        rows.push(["문자 스타일", record.style.name]);
      }
      if (Number.isFinite(record.height)) {
        rows.push(["문자 높이", measurement.length(record.height)]);
      }
      if (Number.isFinite(record.rotation)) {
        rows.push([
          "회전",
          `${measurement.number((record.rotation * 180) / Math.PI)}°`,
        ]);
      }
    } else if (candidate.entityType === "image" && record) {
      rows.push(
        ["파일", record.path || "—"],
        [
          "이미지 크기",
          `${formatNumber(record.size?.[0])} × ${formatNumber(record.size?.[1])}`,
        ],
        ["밝기", `${formatNumber(record.brightness)}%`],
        ["대비", `${formatNumber(record.contrast)}%`],
        ["페이드", `${formatNumber(record.fade)}%`],
        ["자르기", record.clippingEnabled ? "켜짐" : "꺼짐"],
      );
    } else if (
      candidate.entityType === "block" ||
      candidate.entityType === "dimension" ||
      candidate.entityType === "xref"
    ) {
      rows.push(
        ["블록 이름", candidate.blockName || "—"],
        [
          "삽입 좌표",
          candidate.insertionPoint
            ? measurement.point(candidate.insertionPoint)
            : "—",
        ],
      );
      if (candidate.transform?.scale) {
        rows.push([
          "축척",
          candidate.transform.scale.map(formatNumber).join(" · "),
        ]);
      }
      if (Number.isFinite(candidate.transform?.rotation)) {
        rows.push([
          "회전",
          `${measurement.number(candidate.transform.rotation)}°`,
        ]);
      }
    } else if (candidate.entityType === "hatch" && record) {
      const style =
        ["일반", "외곽만", "내부 무시"][record.hatchStyle] ??
        `코드 ${record.hatchStyle}`;
      rows.push(
        ["패턴", record.patternName || record.gradientName || "—"],
        ["해치 방식", style],
        ["경계 루프", `${record.loopCount.toLocaleString()}개`],
      );
      if (Number.isFinite(record.patternAngle)) {
        rows.push([
          "패턴 각도",
          `${measurement.number((record.patternAngle * 180) / Math.PI)}°`,
        ]);
      }
      if (Number.isFinite(record.patternScale)) {
        rows.push(["패턴 축척", formatNumber(record.patternScale)]);
      }
      rows.push(
        [
          "둘레",
          measurement.length(candidate.objectMeasurement?.length),
        ],
        [
          "면적",
          measurement.area(candidate.objectMeasurement?.area),
        ],
      );
    } else if (candidate.entityType === "solid" && record) {
      rows.push(
        ["표시", record.fillMode ? "채움" : "외곽선"],
        [
          "둘레",
          measurement.length(candidate.objectMeasurement?.length),
        ],
        [
          "면적",
          measurement.area(candidate.objectMeasurement?.area),
        ],
      );
      if (Number.isFinite(record.thickness)) {
        rows.push(["두께", measurement.length(record.thickness)]);
      }
    } else if (candidate.entityType === "face" && record) {
      rows.push(
        [
          "숨긴 모서리",
          `${[0, 1, 2, 3].filter(
            (edge) => record.invisibleEdges & (1 << edge),
          ).length.toLocaleString()}개`,
        ],
        [
          "둘레",
          measurement.length(candidate.objectMeasurement?.length),
        ],
        [
          "면적",
          measurement.area(candidate.objectMeasurement?.area),
        ],
      );
    } else if (candidate.curveMeasurement) {
      const curve = candidate.curveMeasurement;
      const majorRadius = Math.max(
        curve.majorRadius,
        curve.minorRadius,
      );
      const minorRadius = Math.min(
        curve.majorRadius,
        curve.minorRadius,
      );
      const circular =
        Math.abs(majorRadius - minorRadius) <=
        Math.max(majorRadius, 1) * 1e-6;
      rows.push(
        [
          circular ? "반지름" : "장축 반지름",
          measurement.length(majorRadius),
        ],
        [
          circular ? "지름" : "단축 반지름",
          measurement.length(
            circular ? majorRadius * 2 : minorRadius,
          ),
        ],
        ["길이", measurement.length(curve.length)],
      );
      if (Number.isFinite(curve.area)) {
        rows.push(["면적", measurement.area(curve.area)]);
      }
      if (!curve.closed && Number.isFinite(curve.sweepRadians)) {
        rows.push([
          "포함각",
          `${measurement.number((curve.sweepRadians * 180) / Math.PI)}°`,
        ]);
      }
    } else if (candidate.objectMeasurement) {
      rows.push([
        candidate.objectMeasurement.closed ? "전체 길이" : "길이",
        measurement.length(candidate.objectMeasurement.length),
      ]);
      if (
        candidate.objectMeasurement.closed &&
        Number.isFinite(candidate.objectMeasurement.area)
      ) {
        rows.push([
          "면적",
          measurement.area(candidate.objectMeasurement.area),
        ]);
      }
    } else if (candidate.measurementSegment?.length === 2) {
      rows.push([
        candidate.sourceKind === 0 ? "길이" : "선택 구간",
        measurement.length(
          pointDistance(
            candidate.measurementSegment[0],
            candidate.measurementSegment[1],
          ),
        ),
      ]);
    }
    rows.push(["선택점", SNAP_LABELS[candidate.kind] ?? candidate.kind]);
    if (candidate.approximated) {
      rows.push(["정밀도", "화면 근사 형상"]);
    }
    this.showResult(
      `${candidate.sourceKindName || "객체"} 속성`,
      rows,
      {
        layerActions:
          Number.isSafeInteger(candidate.layerIndex) &&
          candidate.layerIndex >= 0 &&
          candidate.layerIndex !== 0xffffffff,
        layerIndex: candidate.layerIndex,
      },
    );
    this.onStatus(
      `${candidate.sourceKindName || "도면 객체"} · ${candidate.layerName || "레이어 없음"} · 핸들 ${handleText(candidate.handle)}`,
    );
  }

  showCoordinate(candidate) {
    const measurement = this.measurementDisplay();
    const rows = [
      ["X", measurement.length(candidate.measurementPoint[0])],
      ["Y", measurement.length(candidate.measurementPoint[1])],
      ["Z", measurement.length(candidate.measurementPoint[2])],
      ["스냅", SNAP_LABELS[candidate.kind] ?? candidate.kind],
    ];
    if (candidate.approximated) {
      rows.push(["정밀도", "화면 근사 형상"]);
    }
    this.showResult("점 좌표", rows);
    this.onStatus(measurement.point(candidate.measurementPoint));
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
    const firstCandidate = this.firstPoint;
    const first = firstCandidate.measurementPoint;
    const last = candidate.measurementPoint;
    const deltaX = last[0] - first[0];
    const deltaY = last[1] - first[1];
    const deltaZ = last[2] - first[2];
    const distance = Math.hypot(deltaX, deltaY, deltaZ);
    const angle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
    const measurement = this.measurementDisplay();
    this.clearSelection("measurement.complete");
    this.measurementPath = null;
    this.measurementGuide = Object.freeze({
      first: Object.freeze([...firstCandidate.displayPoint]),
      last: Object.freeze([...candidate.displayPoint]),
      firstKind: firstCandidate.kind,
      lastKind: candidate.kind,
    });
    const rows = [
      ["거리", measurement.length(distance)],
      ["ΔX", measurement.length(deltaX)],
      ["ΔY", measurement.length(deltaY)],
      ["ΔZ", measurement.length(deltaZ)],
      ["각도", `${measurement.number(angle)}°`],
    ];
    if (firstCandidate.approximated || candidate.approximated) {
      rows.push(["정밀도", "곡선 화면 근사 포함"]);
    }
    this.showResult("두 점 거리", rows);
    this.onStatus(
      `거리 ${measurement.length(distance)} · ΔX ${measurement.length(deltaX)} · ΔY ${measurement.length(deltaY)} · 각도 ${measurement.number(angle)}°`,
    );
    this.firstPoint = null;
  }

  selectMultiPoint(candidate) {
    const points = this.measurementPoints;
    const first = points[0];
    if (first && first.coordinateSpace !== candidate.coordinateSpace) {
      this.onStatus(
        "모델 공간과 종이 공간의 점은 함께 측정할 수 없습니다. 같은 공간에서 점을 선택하세요.",
      );
      return;
    }
    const previous = points.at(-1);
    if (
      previous &&
      pointDistance(previous.measurementPoint, candidate.measurementPoint) <=
        Number.EPSILON
    ) {
      this.onStatus("앞 점과 다른 위치를 선택하세요.");
      return;
    }
    this.clearSelection("measurement.start");
    points.push(candidate);
    if (this.activeTool === "angle") {
      if (points.length === 1) {
        this.onStatus("각도의 꼭짓점을 선택하세요.");
      } else if (points.length === 2) {
        this.onStatus("두 번째 방향점을 선택하세요.");
      } else {
        this.finishAngleMeasurement();
      }
      return;
    }
    const noun = this.activeTool === "area" ? "꼭짓점" : "점";
    this.onStatus(
      `${noun} ${points.length.toLocaleString()}개 선택 · 계속 선택하거나 Enter 또는 측정 완료를 누르세요.`,
    );
    if (points.length >= MAX_MEASUREMENT_POINTS) {
      this.finishMeasurement();
    }
  }

  finishMeasurement() {
    if (this.activeTool === "path") {
      return this.finishPathMeasurement();
    }
    if (this.activeTool === "area") {
      return this.finishAreaMeasurement();
    }
    return false;
  }

  setMeasurementPath(candidates, { closed = false } = {}) {
    this.measurementGuide = null;
    this.measurementPath = Object.freeze({
      points: Object.freeze(
        candidates.map((candidate) =>
          Object.freeze([...candidate.displayPoint]),
        ),
      ),
      kinds: Object.freeze(
        candidates.map((candidate) => candidate.kind),
      ),
      closed,
    });
    this.measurementPoints = [];
    this.clearSelection("measurement.complete");
  }

  finishPathMeasurement() {
    const candidates = [...this.measurementPoints];
    if (candidates.length < 2) {
      this.onStatus("누적 거리는 두 점 이상 선택해야 합니다.");
      return false;
    }
    const length = polylineLength(
      candidates.map((candidate) => candidate.measurementPoint),
    );
    const measurement = this.measurementDisplay();
    const rows = [
      ["총 거리", measurement.length(length)],
      ["구간", `${(candidates.length - 1).toLocaleString()}개`],
      ["선택점", `${candidates.length.toLocaleString()}개`],
    ];
    if (candidates.some((candidate) => candidate.approximated)) {
      rows.push(["정밀도", "곡선 화면 근사 포함"]);
    }
    this.setMeasurementPath(candidates);
    this.showResult("누적 거리", rows);
    this.onStatus(
      `누적 거리 ${measurement.length(length)} · ${candidates.length - 1}개 구간`,
    );
    return true;
  }

  finishAreaMeasurement() {
    const candidates = [...this.measurementPoints];
    if (candidates.length < 3) {
      this.onStatus("면적은 세 꼭짓점 이상 선택해야 합니다.");
      return false;
    }
    const points = candidates.map(
      (candidate) => candidate.measurementPoint,
    );
    const area = polygonArea(points);
    const perimeter = polylineLength(points, { closed: true });
    if (area <= Number.EPSILON) {
      this.onStatus(
        "선택한 점으로 면적을 만들 수 없습니다. 일직선이 아닌 꼭짓점을 선택하세요.",
      );
      return false;
    }
    const measurement = this.measurementDisplay();
    const rows = [
      ["면적", measurement.area(area)],
      ["둘레", measurement.length(perimeter)],
      ["꼭짓점", `${candidates.length.toLocaleString()}개`],
    ];
    if (candidates.some((candidate) => candidate.approximated)) {
      rows.push(["정밀도", "곡선 화면 근사 포함"]);
    }
    this.setMeasurementPath(candidates, { closed: true });
    this.showResult("면적·둘레", rows);
    this.onStatus(
      `면적 ${measurement.area(area)} · 둘레 ${measurement.length(perimeter)}`,
    );
    return true;
  }

  finishAngleMeasurement() {
    const candidates = [...this.measurementPoints];
    if (candidates.length !== 3) {
      return false;
    }
    const [first, vertex, last] = candidates.map(
      (candidate) => candidate.measurementPoint,
    );
    const angle = angleAtVertex(first, vertex, last);
    if (angle === null) {
      this.measurementPoints.pop();
      this.onStatus(
        "꼭짓점과 다른 위치에 두 번째 방향점을 선택하세요.",
      );
      return false;
    }
    const measurement = this.measurementDisplay();
    const rows = [
      ["각도", `${measurement.number(angle)}°`],
      ["첫 변", measurement.length(pointDistance(first, vertex))],
      ["둘째 변", measurement.length(pointDistance(vertex, last))],
    ];
    if (candidates.some((candidate) => candidate.approximated)) {
      rows.push(["정밀도", "곡선 화면 근사 포함"]);
    }
    this.setMeasurementPath(candidates);
    this.showResult("세 점 각도", rows);
    this.onStatus(`세 점 각도 ${measurement.number(angle)}°`);
    return true;
  }

  showCurveMeasurement(candidate) {
    const curve = candidate.curveMeasurement;
    if (!curve) {
      this.onStatus(
        "이 객체의 정밀 곡선 정보를 준비하지 못했습니다. 호·원·타원 가까이에서 다시 선택하세요.",
      );
      return false;
    }
    const measurement = this.measurementDisplay();
    const majorRadius = Math.max(
      curve.majorRadius,
      curve.minorRadius,
    );
    const minorRadius = Math.min(
      curve.majorRadius,
      curve.minorRadius,
    );
    const circular =
      Math.abs(majorRadius - minorRadius) <=
      Math.max(majorRadius, 1) * 1e-6;
    const rows = circular
      ? [
          ["반지름", measurement.length(majorRadius)],
          ["지름", measurement.length(majorRadius * 2)],
        ]
      : [
          ["장축 반지름", measurement.length(majorRadius)],
          ["단축 반지름", measurement.length(minorRadius)],
          ["장축 지름", measurement.length(majorRadius * 2)],
          ["단축 지름", measurement.length(minorRadius * 2)],
        ];
    rows.push(
      [
        "중심 X",
        measurement.length(curve.measurementCenter[0]),
      ],
      [
        "중심 Y",
        measurement.length(curve.measurementCenter[1]),
      ],
    );
    this.clearSelection("measurement.complete");
    this.textMatch = null;
    this.measurementPath = null;
    this.measurementGuide = Object.freeze({
      first: curve.displayCenter,
      last: Object.freeze([...candidate.displayPoint]),
      firstKind: "center",
      lastKind: candidate.kind,
    });
    this.showResult(`${candidate.sourceKindName} 치수`, rows);
    this.onStatus(
      circular
        ? `${candidate.sourceKindName} 반지름 ${measurement.length(majorRadius)} · 지름 ${measurement.length(majorRadius * 2)}`
        : `${candidate.sourceKindName} 장축 ${measurement.length(majorRadius)} · 단축 ${measurement.length(minorRadius)}`,
    );
    return true;
  }

  showResult(
    title,
    rows,
    {
      layerActions = false,
      layerIndex = null,
    } = {},
  ) {
    return this.reviewUi.showResult({
      title,
      rows,
      actions:
        layerActions && Number.isSafeInteger(layerIndex)
          ? [
              {
                id: "isolate-layer",
                data: { layerIndex },
              },
              { id: "restore-layers" },
            ]
          : [],
    });
  }

  showTextMatch({
    point,
    handle,
    kind = "문자",
    value = "",
    hidden = false,
  }) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      !point.every(Number.isFinite)
    ) {
      return false;
    }
    this.firstPoint = null;
    this.measurementPoints = [];
    this.measurementGuide = null;
    this.measurementPath = null;
    this.clearSelection("search.navigate");
    this.textMatch = Object.freeze({
      point: Object.freeze([...point]),
      handle: String(handle ?? ""),
    });
    this.showResult("검색한 문자", [
      ["문자", String(value || "—").slice(0, 240)],
      ["종류", String(kind)],
      ["핸들", handle ? `0x${handle}` : "—"],
      ...(hidden ? [["상태", "원본에서 숨김"]] : []),
    ]);
    this.onStatus(
      `검색한 문자 ${value ? `"${String(value).slice(0, 80)}"` : ""} 위치로 이동했습니다.`,
    );
    this.redraw();
    return true;
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
    } else if (kind === "intersection") {
      context.moveTo(-6, -6);
      context.lineTo(6, 6);
      context.moveTo(6, -6);
      context.lineTo(-6, 6);
    } else if (kind === "midpoint") {
      context.moveTo(0, -6);
      context.lineTo(6, 5);
      context.lineTo(-6, 5);
      context.closePath();
    } else if (kind === "quadrant") {
      context.arc(0, 0, 5, 0, Math.PI * 2);
    } else if (kind === "center") {
      context.arc(0, 0, 5, 0, Math.PI * 2);
      context.moveTo(-7, 0);
      context.lineTo(7, 0);
      context.moveTo(0, -7);
      context.lineTo(0, 7);
    } else if (kind === "perpendicular") {
      context.moveTo(-6, 5);
      context.lineTo(-6, -5);
      context.lineTo(4, -5);
      context.lineTo(4, 1);
      context.lineTo(0, 1);
      context.lineTo(0, 5);
      context.closePath();
    } else if (kind === "insertion") {
      context.moveTo(0, -7);
      context.lineTo(7, 0);
      context.lineTo(0, 7);
      context.lineTo(-7, 0);
      context.closePath();
      context.moveTo(-4, 0);
      context.lineTo(4, 0);
      context.moveTo(0, -4);
      context.lineTo(0, 4);
    } else if (kind === "entity") {
      context.arc(0, 0, 6, 0, Math.PI * 2);
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

  drawPath(
    context,
    camera,
    points,
    width,
    height,
    {
      closed = false,
      color = "rgba(34, 211, 238, 0.96)",
      lineWidth = 2.4,
      dash = [8, 4],
    } = {},
  ) {
    if (points.length < 2) {
      return;
    }
    const first = worldToScreen(camera, points[0], width, height);
    context.save();
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.setLineDash(dash);
    context.beginPath();
    context.moveTo(...first);
    for (let index = 1; index < points.length; index += 1) {
      context.lineTo(
        ...worldToScreen(camera, points[index], width, height),
      );
    }
    if (closed) {
      context.closePath();
    }
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
    if (selected?.displayPolygons?.some((polygon) => polygon.length >= 3)) {
      context.save();
      context.strokeStyle = "rgba(250, 204, 21, 0.92)";
      context.fillStyle = "rgba(250, 204, 21, 0.08)";
      context.lineWidth = 2.5;
      const appendPolygons = (polygons) => {
        for (const polygon of polygons) {
          if (polygon.length < 3) {
            continue;
          }
          const first = worldToScreen(
            camera,
            polygon[0],
            width,
            height,
          );
          context.moveTo(...first);
          for (let index = 1; index < polygon.length; index += 1) {
            context.lineTo(
              ...worldToScreen(
                camera,
                polygon[index],
                width,
                height,
              ),
            );
          }
          context.closePath();
        }
      };
      if (selected.displayFillPolygons?.length > 0) {
        context.beginPath();
        appendPolygons(selected.displayFillPolygons);
        context.fill("evenodd");
      }
      context.beginPath();
      appendPolygons(selected.displayPolygons);
      context.stroke();
      context.restore();
    } else if (selected?.displaySegments?.length > 0) {
      context.save();
      context.strokeStyle = "rgba(250, 204, 21, 0.92)";
      context.lineWidth = 3;
      context.beginPath();
      for (const segment of selected.displaySegments) {
        const first = worldToScreen(
          camera,
          segment[0],
          width,
          height,
        );
        const last = worldToScreen(
          camera,
          segment[1],
          width,
          height,
        );
        context.moveTo(...first);
        context.lineTo(...last);
      }
      context.stroke();
      context.restore();
    } else if (selected?.displayPolygon?.length >= 3) {
      const points = selected.displayPolygon.map((point) =>
        worldToScreen(camera, point, width, height),
      );
      context.save();
      context.strokeStyle = "rgba(250, 204, 21, 0.92)";
      context.fillStyle = "rgba(250, 204, 21, 0.08)";
      context.lineWidth = 2.5;
      context.beginPath();
      context.moveTo(...points[0]);
      for (let index = 1; index < points.length; index += 1) {
        context.lineTo(...points[index]);
      }
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
    } else if (selected?.displaySegment) {
      const first = worldToScreen(camera, selected.displaySegment[0], width, height);
      const last = worldToScreen(camera, selected.displaySegment[1], width, height);
      context.strokeStyle = "rgba(250, 204, 21, 0.92)";
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(...first);
      context.lineTo(...last);
      context.stroke();
    }
    if (this.textMatch) {
      const [x, y] = worldToScreen(
        camera,
        this.textMatch.point,
        width,
        height,
      );
      context.save();
      context.strokeStyle = "rgba(244, 114, 182, 0.98)";
      context.fillStyle = "rgba(244, 114, 182, 0.14)";
      context.lineWidth = 2.5;
      context.setLineDash([]);
      context.beginPath();
      context.arc(x, y, 14, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.beginPath();
      context.moveTo(x - 20, y);
      context.lineTo(x + 20, y);
      context.moveTo(x, y - 20);
      context.lineTo(x, y + 20);
      context.stroke();
      context.restore();
    }
    const guide = this.measurementGuide;
    if (guide) {
      this.drawPath(
        context,
        camera,
        [guide.first, guide.last],
        width,
        height,
      );
      this.marker(context, guide.first, guide.firstKind, "#22d3ee");
      this.marker(context, guide.last, guide.lastKind, "#22d3ee");
    }
    const measurementPath = this.measurementPath;
    if (measurementPath) {
      this.drawPath(
        context,
        camera,
        measurementPath.points,
        width,
        height,
        { closed: measurementPath.closed },
      );
      for (let index = 0; index < measurementPath.points.length; index += 1) {
        this.marker(
          context,
          measurementPath.points[index],
          measurementPath.kinds[index],
          "#22d3ee",
        );
      }
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
    const activePoints = this.measurementPoints ?? [];
    if (activePoints.length > 0) {
      const previewCandidates = [...activePoints];
      if (
        this.hover &&
        this.hover.coordinateSpace === activePoints[0].coordinateSpace
      ) {
        previewCandidates.push(this.hover);
      }
      this.drawPath(
        context,
        camera,
        previewCandidates.map((candidate) => candidate.displayPoint),
        width,
        height,
        {
          closed:
            this.activeTool === "area" &&
            previewCandidates.length >= 3,
          color: "rgba(250, 204, 21, 0.9)",
          lineWidth: 1.6,
          dash: [7, 5],
        },
      );
      for (const candidate of activePoints) {
        this.marker(
          context,
          candidate.displayPoint,
          candidate.kind,
          "#facc15",
        );
      }
    }
    if (this.hover) {
      this.marker(context, this.hover.displayPoint, this.hover.kind);
    }
  }

  dispose() {
    this.abortController.abort();
    this.onReviewModeChange(false);
    this.clearSelection("dispose");
    this.activeTool = null;
    this.releaseFilledObjects();
    this.clearExactCurves();
    this.curveStates.clear();
    this.detailSelections.clear();
    this.detailEntries.clear();
    this.detailBytes = 0;
    this.reviewUi.dispose();
    const context = this.overlay.getContext("2d", { alpha: true });
    context?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}

export {
  TOOL_LABELS,
  angleAtVertex,
  formatNumber,
  polygonArea,
  polylineLength,
  unitLabel,
};
