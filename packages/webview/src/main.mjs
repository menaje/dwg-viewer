import { ViewportInteraction } from "./interaction.mjs";
import { applyMaskOrderToInstanceGraph } from "./instance-graph.mjs";
import { buildMaskOrderPlan } from "./mask-order.mjs";
import { WebviewMemoryTelemetry } from "./memory-telemetry.mjs";
import { BlobRangeSource, TrackedRangeSource } from "./range-source.mjs";
import { WebGlLineRenderer } from "./renderer.mjs";
import { ShxGlyphCache } from "./shx-glyph-cache.mjs";
import { CanvasTextOverlay } from "./text-overlay.mjs";
import { loadFirstFrame } from "./viewer.mjs";

const fileInput = document.querySelector("#cache-file");
const fontInput = document.querySelector("#font-files");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#status");
const metrics = document.querySelector("#metrics");
const canvas = document.querySelector("#drawing");
const textCanvas = document.querySelector("#text-overlay");
const viewControls = [...document.querySelectorAll("[data-view-action]")];
const layersToggle = document.querySelector("#layers-toggle");
const layerPanel = document.querySelector("#layer-panel");
const layerSearch = document.querySelector("#layer-search");
const layerList = document.querySelector("#layer-list");
const layerSummary = document.querySelector("#layer-summary");
const layersShowAll = document.querySelector("#layers-show-all");
const layersHideAll = document.querySelector("#layers-hide-all");
let activeScene;
let activeInteraction;
let activeTextStatus;
let activeHatchStatus;
let activeHatchWorker;
let activePrimitiveStatus;
let activePrimitiveWorker;
let activeMaskOrder;
let activeRenderInstanceGraph;
let activeMaskStatus;
let activeMemoryTelemetry;
let hatchPatternTimer;
let lastPatternCameraKey;
let patternRequestRevision = 0;
let openRevision = 0;
const glyphCache = new ShxGlyphCache();
const HATCH_PATTERN_DEBOUNCE_MS = 160;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function missingFontSuffix() {
  const missing = activeTextStatus?.missingFonts ?? [];
  if (missing.length === 0) {
    return "";
  }
  const visibleNames = missing
    .slice(0, 3)
    .map((name) => name.split(/[\\/]/).at(-1).slice(0, 80))
    .join(", ");
  const remainder =
    missing.length > 3 ? ` 외 ${missing.length - 3}개` : "";
  return ` · 누락 SHX: ${visibleNames}${remainder}`;
}

function renderMetrics(scene, rangeSource, viewport = null) {
  const value = scene.metrics;
  const reads = rangeSource.snapshot();
  const render = viewport?.render ?? value.renderer;
  const memory = activeMemoryTelemetry?.sample(
    render?.gpuTrackedBytes ?? 0,
  );
  const detail = viewport?.detail;
  const detailRows = detail
    ? `
      <div><dt>현재 확대</dt><dd>${viewport.zoom.toFixed(2)}×</dd></div>
      <div><dt>화면 상세</dt><dd>${detail.selectedBatches.toLocaleString()}개</dd></div>
      <div><dt>상세 캐시</dt><dd>${detail.cache.entries.toLocaleString()}개</dd></div>
      <div><dt>상세 GPU</dt><dd>${formatBytes(detail.cache.bytes)}</dd></div>
      <div><dt>상세 대기</dt><dd>${detail.loading.toLocaleString()}</dd></div>
    `
    : "";
  const text = render?.text;
  const textRows = text
    ? `
      <div><dt>문자 원본</dt><dd>${text.sourceTexts.toLocaleString()}개</dd></div>
      <div><dt>화면 문자</dt><dd>${text.visibleOccurrences.toLocaleString()}개</dd></div>
      <div><dt>SHX 글자</dt><dd>${text.vectorGlyphs.toLocaleString()}개</dd></div>
      <div><dt>대체 글자</dt><dd>${text.fallbackGlyphs.toLocaleString()}개</dd></div>
      <div><dt>문자 선분</dt><dd>${text.segments.toLocaleString()}개</dd></div>
      <div><dt>화면 가림</dt><dd>${text.maskOccurrences.toLocaleString()}개</dd></div>
      <div><dt>문자 가림 적용</dt><dd>${text.clippedTextOccurrences.toLocaleString()}개</dd></div>
      <div><dt>Glyph 캐시</dt><dd>${formatBytes(glyphCache.stats.glyphBytes)}</dd></div>
    `
    : "";
  const hatch = render?.hatchFill ?? activeHatchStatus?.fillMetrics;
  const pattern =
    render?.hatchPattern ?? activeHatchStatus?.patternMetrics;
  const hatchRows = hatch
    ? `
      <div><dt>해치 원본</dt><dd>${hatch.sourceHatches.toLocaleString()}개</dd></div>
      <div><dt>해치 표시</dt><dd>${hatch.renderedHatches.toLocaleString()}개</dd></div>
      <div><dt>채움 삼각형</dt><dd>${hatch.triangles.toLocaleString()}개</dd></div>
      <div><dt>채움 배치</dt><dd>${hatch.batches.toLocaleString()}개</dd></div>
      <div><dt>채움 GPU</dt><dd>${formatBytes(hatch.gpuBytes)}</dd></div>
      <div><dt>채움 원본 읽기</dt><dd>${formatBytes(activeHatchStatus?.reads?.bytesRead ?? 0)}</dd></div>
    `
    : "";
  const patternRows = pattern
    ? `
      <div><dt>패턴 정의선</dt><dd>${pattern.patternDefinitions.toLocaleString()}개</dd></div>
      <div><dt>패턴 표시</dt><dd>${pattern.renderedHatches.toLocaleString()}개</dd></div>
      <div><dt>패턴 선분</dt><dd>${pattern.segments.toLocaleString()}개</dd></div>
      <div><dt>패턴 오류 생략</dt><dd>${((pattern.skippedInvalidDefinitions ?? 0) + (pattern.skippedInvalidIntersections ?? 0) + (pattern.skippedInvalidSegments ?? 0)).toLocaleString()}건</dd></div>
      <div><dt>패턴 배치</dt><dd>${pattern.batches.toLocaleString()}개</dd></div>
      <div><dt>패턴 GPU</dt><dd>${formatBytes(pattern.gpuBytes)}</dd></div>
      <div><dt>패턴 원본 읽기</dt><dd>${formatBytes(activeHatchStatus?.patternReads?.bytesRead ?? activeHatchStatus?.reads?.bytesRead ?? 0)}</dd></div>
    `
    : "";
  const primitives =
    render?.primitives ?? activePrimitiveStatus?.metrics;
  const primitiveRows = primitives
    ? `
      <div><dt>점 원본/표시</dt><dd>${primitives.sourcePoints.toLocaleString()} / ${primitives.renderedPoints.toLocaleString()}개</dd></div>
      <div><dt>솔리드 원본</dt><dd>${primitives.sourceSolids.toLocaleString()}개</dd></div>
      <div><dt>솔리드 채움</dt><dd>${primitives.renderedFilledSolids.toLocaleString()}개</dd></div>
      <div><dt>솔리드 외곽선</dt><dd>${primitives.renderedOutlineSolids.toLocaleString()}개</dd></div>
      <div><dt>3D 면 원본/표시</dt><dd>${primitives.sourceFaces.toLocaleString()} / ${primitives.renderedFaces.toLocaleString()}개</dd></div>
      <div><dt>3D 면 가장자리</dt><dd>${primitives.renderedFaceEdges.toLocaleString()}개</dd></div>
      <div><dt>가림 객체 원본</dt><dd>${primitives.sourceWipeouts.toLocaleString()}개</dd></div>
      <div><dt>가림 마스크</dt><dd>${primitives.renderedWipeoutMasks.toLocaleString()}개</dd></div>
      <div><dt>가림 삼각형</dt><dd>${primitives.renderedWipeoutMaskTriangles.toLocaleString()}개</dd></div>
      <div><dt>가림 프레임</dt><dd>${primitives.renderedWipeoutFrames.toLocaleString()}개</dd></div>
      <div><dt>가림 GPU</dt><dd>${formatBytes(primitives.wipeoutMaskGpuBytes)}</dd></div>
      <div><dt>후처리 GPU</dt><dd>${formatBytes(primitives.gpuBytes)}</dd></div>
      <div><dt>후처리 원본 읽기</dt><dd>${formatBytes(activePrimitiveStatus?.reads?.bytesRead ?? 0)}</dd></div>
    `
    : "";
  const maskRows = activeMaskStatus
    ? `
      <div><dt>가림 순서</dt><dd>${activeMaskStatus.enabled ? "활성" : "비활성"}</dd></div>
      <div><dt>정렬표 읽기</dt><dd>${activeMaskStatus.tables.toLocaleString()} / ${activeMaskStatus.entries.toLocaleString()}개</dd></div>
      <div><dt>확장 가림</dt><dd>${activeMaskStatus.maximumExpandedMasks.toLocaleString()}개</dd></div>
      <div><dt>순서 계산</dt><dd>${activeMaskStatus.buildMs.toFixed(1)} ms</dd></div>
    `
    : "";
  const memoryRows = memory
    ? `
      <div><dt>GPU 추적 메모리</dt><dd>${formatBytes(memory.gpuTrackedBytes)}</dd></div>
      <div><dt>GPU 추적 최고</dt><dd>${formatBytes(memory.peakGpuTrackedBytes)}</dd></div>
      <div><dt>인스턴스 작업 버퍼</dt><dd>${formatBytes(render.instanceScratchBytes ?? 0)}</dd></div>
      ${
        memory.jsHeapAvailable
          ? `
      <div><dt>JavaScript 힙</dt><dd>${formatBytes(memory.usedJsHeapBytes)}</dd></div>
      <div><dt>JavaScript 힙 최고</dt><dd>${formatBytes(memory.peakUsedJsHeapBytes)} / ${formatBytes(memory.hardLimitBytes)}${memory.hardLimitExceeded ? " · 기준 초과" : ""}</dd></div>
      `
          : `
      <div><dt>JavaScript 힙</dt><dd>브라우저 계측 미지원</dd></div>
      `
      }
    `
    : "";
  metrics.innerHTML = `
    <dl>
      <div><dt>첫 화면</dt><dd>${value.timings.firstFrameMs.toFixed(1)} ms</dd></div>
      <div><dt>읽은 데이터</dt><dd>${formatBytes(reads.bytesRead)}</dd></div>
      <div><dt>가장 큰 읽기</dt><dd>${formatBytes(reads.maximumRequestBytes)}</dd></div>
      <div><dt>첫 화면 버퍼</dt><dd>${formatBytes(value.overviewBytes)}</dd></div>
      <div><dt>블록 인스턴스</dt><dd>${value.instances.toLocaleString()}</dd></div>
      <div><dt>GPU 호출</dt><dd>${render.drawCalls.toLocaleString()}</dd></div>
      <div><dt>제출 정점</dt><dd>${render.submittedVertices.toLocaleString()}</dd></div>
      <div><dt>GPU 정점 버퍼</dt><dd>${formatBytes(render.gpuVertexBytes)}</dd></div>
      <div><dt>전체 캐시</dt><dd>${formatBytes(value.cacheBytes)}</dd></div>
      ${memoryRows}
      ${detailRows}
      ${hatchRows}
      ${patternRows}
      ${primitiveRows}
      ${maskRows}
      ${textRows}
    </dl>
  `;
}

function setControlsEnabled(enabled) {
  for (const control of viewControls) {
    control.disabled = !enabled;
  }
  layersToggle.disabled = !enabled;
}

function updateLayerSummary() {
  if (!activeScene) {
    layerSummary.textContent = "";
    return;
  }
  const visibility = activeScene.renderer.getLayerVisibility();
  const visible = visibility.filter(Boolean).length;
  layerSummary.textContent = `${visible.toLocaleString()} / ${visibility.length.toLocaleString()} 켜짐`;
}

function resetLayerPanel() {
  layerPanel.hidden = true;
  layersToggle.setAttribute("aria-expanded", "false");
  layerSearch.value = "";
  layerList.replaceChildren();
  layerSummary.textContent = "";
}

function populateLayerPanel(scene) {
  layerList.replaceChildren();
  const visibility = scene.renderer.getLayerVisibility();
  const fragment = document.createDocumentFragment();
  for (const [index, layer] of scene.metadata.layers.entries()) {
    const item = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const name = document.createElement("span");
    checkbox.type = "checkbox";
    checkbox.checked = visibility[index];
    checkbox.dataset.layerIndex = String(index);
    name.className = "layer-name";
    name.textContent = layer.name || "(이름 없음)";
    item.dataset.layerName = name.textContent.toLocaleLowerCase();
    checkbox.addEventListener("change", () => {
      if (activeScene !== scene) {
        return;
      }
      scene.renderer.setLayerVisibility(index, checkbox.checked);
      activeInteraction?.refresh();
      updateLayerSummary();
    });
    label.append(checkbox, name);
    item.append(label);
    fragment.append(item);
  }
  layerList.append(fragment);
  updateLayerSummary();
}

function setAllLayersVisible(visible) {
  if (!activeScene) {
    return;
  }
  activeScene.renderer.setAllLayersVisible(visible);
  for (const checkbox of layerList.querySelectorAll("input[type=checkbox]")) {
    checkbox.checked = visible;
  }
  activeInteraction?.refresh();
  updateLayerSummary();
}

async function initializeTextOverlay(
  scene,
  revision,
  maskOrder = activeMaskOrder,
  instanceGraph = activeRenderInstanceGraph ?? scene.instanceGraph,
) {
  if (scene.reader.header.minor < 4) {
    return;
  }
  status.textContent = "문자 원본과 스타일 읽는 중";
  const [textEntities, styles] = await Promise.all([
    scene.reader.readTextEntities(),
    scene.reader.readTextStyles(),
  ]);
  if (revision !== openRevision || activeScene !== scene) {
    return;
  }
  const overlay = new CanvasTextOverlay(textCanvas, {
    textEntities,
    blocks: scene.metadata.blocks,
    layers: scene.metadata.layers,
    instanceGraph,
    glyphCache,
    maskOrder,
  });
  scene.renderer.setTextOverlay(overlay);
  const missing = glyphCache.missingFonts(styles);
  activeTextStatus = Object.freeze({
    sourceTexts: textEntities.length,
    missingFonts: missing,
  });
  activeInteraction?.refresh();
  status.textContent =
    missing.length === 0
      ? `문자 ${textEntities.length.toLocaleString()}개 표시 준비 완료`
      : `문자 ${textEntities.length.toLocaleString()}개 표시${missingFontSuffix()}(시스템 글꼴 대체)`;
}

async function initializeMaskComposition(scene, revision) {
  const fallback = Object.freeze({
    maskOrder: null,
    instanceGraph: scene.instanceGraph,
  });
  if (scene.reader.header.minor < 11) {
    activeMaskStatus = Object.freeze({
      enabled: false,
      tables: 0,
      entries: 0,
      maximumExpandedMasks: 0,
      buildMs: 0,
      reason: "scene-cache-version",
    });
    return fallback;
  }
  status.textContent = "가림 객체의 앞·뒤 순서를 계산하는 중";
  const started = performance.now();
  const [drawOrder, wipeouts] = await Promise.all([
    scene.reader.readDrawOrder(),
    scene.reader.readWipeoutEntities(),
  ]);
  if (revision !== openRevision || activeScene !== scene) {
    return fallback;
  }
  const maskOrder = buildMaskOrderPlan(
    drawOrder,
    wipeouts,
    scene.metadata.blocks,
    scene.metadata.inserts,
  );
  const instanceGraph = maskOrder.enabled
    ? applyMaskOrderToInstanceGraph(
        scene.instanceGraph,
        scene.metadata.blocks,
        maskOrder,
      )
    : scene.instanceGraph;
  const enabled =
    maskOrder.enabled && instanceGraph.maskOrderEnabled;
  const buildMs = performance.now() - started;
  activeMaskStatus = Object.freeze({
    enabled,
    tables: maskOrder.diagnostics.tables,
    entries: maskOrder.diagnostics.entries,
    maximumExpandedMasks: maskOrder.maximumExpandedMasks,
    buildMs,
    reason: enabled ? null : maskOrder.reason ?? "instance-graph",
  });
  if (!enabled) {
    return fallback;
  }
  scene.renderer.setMaskComposition({
    maskOrder,
    instanceGraph,
    blocks: scene.metadata.blocks,
    overviewVertices: scene.overview,
  });
  scene.renderer.redraw(scene.render.camera);
  return Object.freeze({ maskOrder, instanceGraph });
}

function workerCamera(camera) {
  if (!camera) {
    return null;
  }
  return {
    origin: [...camera.origin],
    worldWidth: camera.worldWidth,
    worldHeight: camera.worldHeight,
    width: camera.width,
    height: camera.height,
  };
}

function patternCameraKey(camera) {
  return [
    ...camera.origin,
    camera.worldWidth,
    camera.worldHeight,
    camera.width,
    camera.height,
  ]
    .map((value) => Number(value).toPrecision(12))
    .join(":");
}

function createHatchWorker() {
  const worker = new Worker(
    new URL("./hatch-worker.mjs", import.meta.url),
    { type: "module" },
  );
  const pending = new Map();
  let nextRequestId = 1;
  let closed = false;
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  worker.addEventListener("message", (event) => {
    const request = pending.get(event.data.requestId);
    if (!request) {
      return;
    }
    pending.delete(event.data.requestId);
    if (event.data.ok) {
      request.resolve(event.data);
    } else {
      request.reject(new Error(event.data.error));
    }
  });
  worker.addEventListener("error", (event) => {
    if (closed) {
      return;
    }
    closed = true;
    rejectPending(new Error(event.message || "HATCH worker failed"));
  });
  return {
    request(type, payload = {}) {
      if (closed) {
        return Promise.reject(
          new DOMException("HATCH 작업 취소됨", "AbortError"),
        );
      }
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ requestId, type, ...payload });
      });
    },
    cancel() {
      if (closed) {
        return;
      }
      closed = true;
      worker.terminate();
      rejectPending(new DOMException("HATCH 작업 취소됨", "AbortError"));
    },
  };
}

function createPrimitiveWorker() {
  const worker = new Worker(
    new URL("./primitive-worker.mjs", import.meta.url),
    { type: "module" },
  );
  let settled = false;
  let rejectRequest;
  return {
    initialize(file, wipeoutFrame, maskOrder) {
      if (settled) {
        return Promise.reject(
          new DOMException("후처리 작업 취소됨", "AbortError"),
        );
      }
      return new Promise((resolve, reject) => {
        rejectRequest = reject;
        worker.addEventListener(
          "message",
          (event) => {
            if (settled) {
              return;
            }
            settled = true;
            worker.terminate();
            rejectRequest = undefined;
            if (event.data.ok) {
              resolve(event.data);
            } else {
              reject(new Error(event.data.error));
            }
          },
          { once: true },
        );
        worker.addEventListener(
          "error",
          (event) => {
            if (settled) {
              return;
            }
            settled = true;
            worker.terminate();
            rejectRequest = undefined;
            reject(new Error(event.message || "후처리 worker failed"));
          },
          { once: true },
        );
        worker.postMessage({
          requestId: 1,
          type: "initialize",
          file,
          wipeoutFrame,
          maskOrder,
        });
      });
    },
    cancel() {
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
      rejectRequest?.(
        new DOMException("후처리 작업 취소됨", "AbortError"),
      );
      rejectRequest = undefined;
    },
  };
}

async function initializePrimitives(
  file,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  if (scene.reader.header.minor < 8) {
    return;
  }
  activePrimitiveStatus = Object.freeze({ state: "loading" });
  status.textContent =
    "점·솔리드·3D 면·가림 객체 원본을 별도 작업 공간에서 읽는 중";
  const worker = createPrimitiveWorker();
  activePrimitiveWorker = worker;
  let result;
  try {
    result = await worker.initialize(
      file,
      scene.metadata.drawing.wipeoutFrame,
      maskOrder,
    );
  } finally {
    if (activePrimitiveWorker === worker) {
      activePrimitiveWorker = undefined;
    }
  }
  if (revision !== openRevision || activeScene !== scene) {
    return;
  }
  scene.renderer.setPrimitiveMeshes(result.primitives);
  activePrimitiveStatus = Object.freeze({
    state: "ready",
    metrics: result.primitives.metrics,
    reads: result.reads,
  });
  activeInteraction?.refresh();
  const value = result.primitives.metrics;
  const warnings =
    value.skippedOwners +
    value.skippedDegenerateTriangles +
    Number(value.pointGpuLimitReached) +
    Number(value.solidFillGpuLimitReached) +
    Number(value.solidOutlineGpuLimitReached) +
    Number(value.faceOutlineGpuLimitReached) +
    Number(value.wipeoutOutlineGpuLimitReached) +
    Number(value.wipeoutMaskGpuLimitReached);
  status.textContent =
    `점 ${value.renderedPoints.toLocaleString()}개 · 솔리드 ${(value.renderedFilledSolids + value.renderedOutlineSolids).toLocaleString()}개 · 3D 면 ${value.renderedFaces.toLocaleString()}개 · 가림 ${value.renderedWipeoutMasks.toLocaleString()}개 표시 완료` +
    (warnings > 0 ? ` · 제한/건너뜀 ${warnings.toLocaleString()}건` : "");
}

async function initializeHatchFills(
  file,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  if (scene.reader.header.minor < 6) {
    return;
  }
  activeHatchStatus = Object.freeze({ state: "loading" });
  status.textContent = "해치 원본을 별도 작업 공간에서 읽는 중";
  const worker = createHatchWorker();
  activeHatchWorker = worker;
  const initialPatternCameraKey = patternCameraKey(scene.render.camera);
  const result = await worker.request("initialize", {
    file,
    camera: workerCamera(scene.render.camera),
    maskOrder,
  });
  if (revision !== openRevision || activeScene !== scene) {
    return;
  }
  scene.renderer.setHatchFills(result.fill);
  const currentCamera =
    activeInteraction?.snapshot().render.camera ?? scene.render.camera;
  const currentCameraKey = patternCameraKey(currentCamera);
  const acceptedPattern =
    result.pattern && currentCameraKey === initialPatternCameraKey
      ? result.pattern
      : null;
  if (acceptedPattern) {
    scene.renderer.setHatchPatterns(acceptedPattern);
    lastPatternCameraKey = initialPatternCameraKey;
  }
  activeHatchStatus = Object.freeze({
    state: "ready",
    fillMetrics: result.fill.metrics,
    patternMetrics: acceptedPattern?.metrics ?? null,
    reads: result.reads,
  });
  activeInteraction?.refresh();
  const warnings =
    result.fill.metrics.truncatedHatches +
    result.fill.metrics.sourceTruncatedHatches +
    result.fill.metrics.skippedTriangulations +
    (acceptedPattern?.metrics.truncatedHatches ?? 0);
  status.textContent =
    `해치 ${result.fill.metrics.renderedHatches.toLocaleString()}개 · 패턴 ${(acceptedPattern?.metrics.renderedHatches ?? 0).toLocaleString()}개 표시 완료` +
    (warnings > 0 ? ` · 제한/건너뜀 ${warnings.toLocaleString()}건` : "");
  if (currentCamera) {
    scheduleHatchPatterns(scene, currentCamera, revision);
  }
}

function scheduleHatchPatterns(scene, camera, revision) {
  if (
    scene.reader.header.minor < 7 ||
    activeHatchStatus?.state !== "ready"
  ) {
    return;
  }
  const cameraKey = patternCameraKey(camera);
  if (cameraKey === lastPatternCameraKey) {
    return;
  }
  const requestRevision = ++patternRequestRevision;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
  }
  hatchPatternTimer = setTimeout(async () => {
    hatchPatternTimer = undefined;
    if (
      revision !== openRevision ||
      activeScene !== scene ||
      cameraKey === lastPatternCameraKey
    ) {
      return;
    }
    const worker = activeHatchWorker;
    if (!worker) {
      return;
    }
    try {
      const result = await worker.request("render-pattern", {
        camera: workerCamera(camera),
      });
      if (
        requestRevision !== patternRequestRevision ||
        revision !== openRevision ||
        activeScene !== scene
      ) {
        return;
      }
      scene.renderer.setHatchPatterns(result.pattern);
      lastPatternCameraKey = cameraKey;
      activeHatchStatus = Object.freeze({
        ...activeHatchStatus,
        patternMetrics: result.pattern.metrics,
      });
      activeInteraction?.refresh();
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        requestRevision === patternRequestRevision &&
        revision === openRevision
      ) {
        status.textContent = `패턴 해치 표시 실패: ${error.message}`;
        console.error(error);
      }
    }
  }, HATCH_PATTERN_DEBOUNCE_MS);
}

async function initializeDeferredGeometry(
  file,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  try {
    await initializePrimitives(file, scene, revision, maskOrder);
  } catch (error) {
    if (revision === openRevision && activeScene === scene) {
      activePrimitiveStatus = Object.freeze({
        state: "error",
        error: error.message,
      });
      status.textContent = `점·솔리드 표시 실패: ${error.message}`;
      console.error(error);
    }
  }
  if (revision !== openRevision || activeScene !== scene) {
    return;
  }
  try {
    await initializeHatchFills(file, scene, revision, maskOrder);
  } catch (error) {
    if (revision === openRevision && activeScene === scene) {
      activeHatchStatus = Object.freeze({
        state: "error",
        error: error.message,
      });
      status.textContent = `해치 표시 실패: ${error.message}`;
      console.error(error);
    }
  }
}

async function registerFontFiles(files) {
  if (files.length === 0) {
    return;
  }
  status.textContent = `SHX 글꼴 ${files.length.toLocaleString()}개 읽는 중`;
  const registered = await glyphCache.registerFiles(files);
  if (activeScene) {
    if (activeScene.renderer.textOverlay) {
      activeInteraction?.refresh();
    } else {
      await initializeTextOverlay(activeScene, openRevision);
    }
    const styles = await activeScene.reader.readTextStyles();
    const missing = glyphCache.missingFonts(styles);
    activeTextStatus = Object.freeze({
      sourceTexts: activeTextStatus?.sourceTexts ?? 0,
      missingFonts: missing,
    });
    status.textContent =
      `SHX ${registered.length.toLocaleString()}개 등록` +
      (missing.length === 0 ? " · 누락 없음" : missingFontSuffix());
  } else {
    status.textContent = `SHX 글꼴 ${registered.length.toLocaleString()}개 등록 완료`;
  }
}

async function openFile(file) {
  const revision = ++openRevision;
  status.textContent = "준비 중";
  metrics.innerHTML = "";
  setControlsEnabled(false);
  resetLayerPanel();
  activeTextStatus = undefined;
  activeHatchStatus = undefined;
  activePrimitiveStatus = undefined;
  activeMaskOrder = undefined;
  activeRenderInstanceGraph = undefined;
  activeMaskStatus = undefined;
  activeMemoryTelemetry = new WebviewMemoryTelemetry();
  lastPatternCameraKey = undefined;
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
  activeHatchWorker?.cancel();
  activeHatchWorker = undefined;
  activePrimitiveWorker?.cancel();
  activePrimitiveWorker = undefined;
  activeInteraction?.dispose();
  activeInteraction = undefined;
  activeScene?.renderer.dispose();
  activeScene = undefined;
  const source = new TrackedRangeSource(new BlobRangeSource(file));
  const renderer = new WebGlLineRenderer(canvas);
  try {
    const scene = await loadFirstFrame(source, canvas, {
      renderer,
      onProgress(message) {
        if (revision === openRevision) {
          status.textContent = message;
        }
      },
    });
    if (revision !== openRevision) {
      renderer.dispose();
      return;
    }
    activeScene = scene;
    dropZone.classList.add("loaded");
    populateLayerPanel(scene);
    renderMetrics(activeScene, source);
    let maskState = Object.freeze({
      maskOrder: null,
      instanceGraph: scene.instanceGraph,
    });
    try {
      maskState = await initializeMaskComposition(
        scene,
        revision,
      );
    } catch (error) {
      if (revision === openRevision && activeScene === scene) {
        activeMaskStatus = Object.freeze({
          enabled: false,
          tables: 0,
          entries: 0,
          maximumExpandedMasks: 0,
          buildMs: 0,
          reason: error.message,
        });
        console.error(error);
      }
    }
    if (revision !== openRevision || activeScene !== scene) {
      renderer.dispose();
      return;
    }
    activeMaskOrder = maskState.maskOrder;
    activeRenderInstanceGraph = maskState.instanceGraph;
    renderMetrics(activeScene, source);
    activeInteraction = new ViewportInteraction(activeScene, canvas, {
      onUpdate(viewport) {
        renderMetrics(activeScene, source, viewport);
        scheduleHatchPatterns(
          activeScene,
          viewport.render.camera,
          revision,
        );
        status.textContent =
          viewport.detail.loading > 0
            ? `상세 청크 ${viewport.detail.loading.toLocaleString()}개 읽는 중`
            : `${viewport.zoom.toFixed(2)}× · 화면 상세 ${viewport.detail.selectedBatches.toLocaleString()}개`;
        status.textContent += missingFontSuffix();
      },
      onError(error) {
        status.textContent = `상세 표시 실패: ${error.message}`;
        console.error(error);
      },
    });
    setControlsEnabled(true);
    initializeDeferredGeometry(
      file,
      activeScene,
      revision,
      activeMaskOrder,
    ).catch(
      console.error,
    );
    initializeTextOverlay(
      activeScene,
      revision,
      activeMaskOrder,
      activeRenderInstanceGraph,
    ).catch((error) => {
      if (revision === openRevision) {
        status.textContent = `문자 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
  } catch (error) {
    renderer.dispose();
    if (revision !== openRevision) {
      return;
    }
    activeInteraction = undefined;
    activeScene = undefined;
    dropZone.classList.remove("loaded");
    status.textContent = `열기 실패: ${error.message}`;
    throw error;
  }
}

fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) {
    openFile(file).catch(console.error);
  }
});

fontInput.addEventListener("change", () => {
  const files = [...fontInput.files];
  fontInput.value = "";
  registerFontFiles(files).catch((error) => {
    status.textContent = `SHX 글꼴 실패: ${error.message}`;
    console.error(error);
  });
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  const files = [...event.dataTransfer.files];
  const fonts = files.filter((file) => file.name.toLocaleLowerCase().endsWith(".shx"));
  const cache = files.find((file) => !file.name.toLocaleLowerCase().endsWith(".shx"));
  if (fonts.length > 0) {
    registerFontFiles(fonts).catch(console.error);
  }
  if (cache) {
    openFile(cache).catch(console.error);
  }
});

for (const control of viewControls) {
  control.addEventListener("click", () => {
    if (!activeInteraction) {
      return;
    }
    switch (control.dataset.viewAction) {
      case "zoom-in":
        activeInteraction.zoomBy(0.7);
        break;
      case "zoom-out":
        activeInteraction.zoomBy(1 / 0.7);
        break;
      case "fit":
        activeInteraction.reset();
        break;
    }
  });
}

layersToggle.addEventListener("click", () => {
  const opening = layerPanel.hidden;
  layerPanel.hidden = !opening;
  layersToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    layerSearch.focus();
  }
});

layerSearch.addEventListener("input", () => {
  const query = layerSearch.value.trim().toLocaleLowerCase();
  for (const item of layerList.children) {
    item.hidden = Boolean(query) && !item.dataset.layerName.includes(query);
  }
});

layersShowAll.addEventListener("click", () => {
  setAllLayersVisible(true);
});

layersHideAll.addEventListener("click", () => {
  setAllLayersVisible(false);
});

window.addEventListener("beforeunload", () => {
  openRevision += 1;
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
  activeHatchWorker?.cancel();
  activeHatchWorker = undefined;
  activePrimitiveWorker?.cancel();
  activePrimitiveWorker = undefined;
  activeInteraction?.dispose();
  activeScene?.renderer.dispose();
  activeInteraction = undefined;
  activeScene = undefined;
  activeMemoryTelemetry = undefined;
  glyphCache.dispose();
  resetLayerPanel();
});
