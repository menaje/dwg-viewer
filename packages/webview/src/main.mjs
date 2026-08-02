import { ViewportInteraction } from "./interaction.mjs?v=1.18.0";
import {
  buildExternalLayerMap,
  buildExternalLinetypeMap,
  composeExternalInstanceGraph,
  remapLineVertexLayers,
  remapLineVertexLinetypes,
  remapTextEntityLayers,
} from "./external-reference.mjs";
import {
  createVsCodeRangeSource,
  installWorkerRangeProxy,
  WORKER_RANGE_REQUEST,
} from "./host-range-source.mjs";
import { applyMaskOrderToInstanceGraph } from "./instance-graph.mjs";
import { buildMaskOrderPlan } from "./mask-order.mjs";
import { WebviewMemoryTelemetry } from "./memory-telemetry.mjs";
import { BlobRangeSource, TrackedRangeSource } from "./range-source.mjs";
import {
  calculateRasterImageBounds,
  CanvasRasterImageOverlay,
  CompositeRasterImageOverlay,
  RasterImageAssetStore,
} from "./raster-image-overlay.mjs";
import {
  makePlotStyleLineWeights,
  makePlotStylePalette,
  plotStyleDiagnostics,
  plotStyleShownInLayout,
} from "./cad-plot-style.mjs";
import { ComplexLinetypeOverlay } from "./complex-linetype-overlay.mjs";
import { WebGlLineRenderer } from "./renderer.mjs?v=1.18.0";
import { ReviewTools } from "./review-tools.mjs";
import {
  isOutlineFontReference,
  isShxFontReference,
  normalizeShxFontName,
  ShxGlyphCache,
} from "./shx-glyph-cache.mjs";
import {
  CanvasTextOverlay,
  CompositeTextOverlay,
  registerLocalOutlineFont,
  unregisterLocalOutlineFont,
} from "./text-overlay.mjs";
import {
  loadExternalFirstFrame,
  loadFirstFrame,
} from "./viewer.mjs?v=1.18.0";

const fileInput = document.querySelector("#cache-file");
const cachePicker = document.querySelector("#cache-picker");
const fontInput = document.querySelector("#font-files");
const fontFileButton = document.querySelector("#font-file-button");
const fontsToggle = document.querySelector("#fonts-toggle");
const fontPanel = document.querySelector("#font-panel");
const fontSummary = document.querySelector("#font-summary");
const fontPanelHelp = document.querySelector("#font-panel-help");
const fontStatusList = document.querySelector("#font-status-list");
const hostFontFolder = document.querySelector("#host-font-folder");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#status");
const metrics = document.querySelector("#metrics");
const canvas = document.querySelector("#drawing");
const imageCanvas = document.querySelector("#image-overlay");
const textCanvas = document.querySelector("#text-overlay");
const reviewCanvas = document.querySelector("#review-overlay");
const reviewToolbar = document.querySelector("#review-toolbar");
const reviewResult = document.querySelector("#review-result");
const layoutTabs = document.querySelector("#layout-tabs");
const viewControls = [...document.querySelectorAll("[data-view-action]")];
const layersToggle = document.querySelector("#layers-toggle");
const layerPanel = document.querySelector("#layer-panel");
const layerSearch = document.querySelector("#layer-search");
const layerList = document.querySelector("#layer-list");
const layerSummary = document.querySelector("#layer-summary");
const layersShowAll = document.querySelector("#layers-show-all");
const layersHideAll = document.querySelector("#layers-hide-all");
const hostRetry = document.querySelector("#host-retry");
const hostRebuild = document.querySelector("#host-rebuild");
const hostAdapterSetup = document.querySelector("#host-adapter-setup");
const xrefsToggle = document.querySelector("#xrefs-toggle");
const wipeoutToggle = document.querySelector("#wipeout-toggle");
const plotStyleToggle = document.querySelector("#plot-style-toggle");
const xrefPanel = document.querySelector("#xref-panel");
const xrefSummary = document.querySelector("#xref-summary");
const xrefStatusList = document.querySelector("#xref-status-list");
const pageHeader = document.querySelector("header");
const viewerToolsTrigger = document.querySelector(
  "#viewer-tools-trigger",
);
let activeScene;
let activeInteraction;
let activeReviewTools;
let activeTextStatus;
let activeTextComposite;
let activeImageComposite;
let activeImageAssetStore;
let activeHatchStatus;
let activeHatchWorker;
let activePrimitiveStatus;
let activePrimitiveWorker;
let activeMaskOrder;
let activeRenderInstanceGraph;
let activeMaskStatus;
let activeWipeoutMasksVisible = false;
let activeViewId;
let viewSwitchRevision = 0;
let activePlotStyleName = "";
let activePlotStyleEnabled = false;
let nextPlotStyleRequestId = 1;
let activeMemoryTelemetry;
let hatchPatternTimer;
let fontRefreshTimer;
let lastPatternCameraKey;
let patternRequestRevision = 0;
let openRevision = 0;
const glyphCache = new ShxGlyphCache();
const fontDiagnostics = new Map();
const pendingHostFontRequests = new Map();
const attemptedHostFontKeys = new Set();
const hostLoadedFontKeys = new Set();
const localOutlineFaces = new Map();
let activeTextStyles = Object.freeze([]);
let activeHostCacheId;
let nextHostFontRequestId = 1;
const HATCH_PATTERN_DEBOUNCE_MS = 160;
const vscodeApi =
  typeof globalThis.acquireVsCodeApi === "function"
    ? globalThis.acquireVsCodeApi()
    : null;
let activeHostRangeSource;
let activeRangeMetricsSource;
const externalHostSources = new Map();
const externalRangeSources = new Map();
const externalCacheData = new Map();
const externalAttachmentsByCache = new Map();
const xrefDiagnostics = new Map();
const pendingImageRequests = new Map();
let nextImageRequestId = 1;
const discoveredXrefCaches = new Set();
const readyExternalMessages = new Map();
const plotStyleTables = new Map();
const plotStylePreferences = new Map();
const pendingPlotStyleRequests = new Map();
const MAX_EXTERNAL_SOURCE_OVERVIEW_BYTES = 32 * 1024 * 1024;
let externalSourceOverviewBytes = 0;
let externalLoadQueue = Promise.resolve();

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function displayFontName(value) {
  if (typeof value !== "string") {
    return "(이름 없음)";
  }
  return value.split(/[\\/]/).at(-1)?.slice(0, 120) || "(이름 없음)";
}

function normalizePlotStyleName(value) {
  if (typeof value !== "string") {
    return "";
  }
  const name = value
    .trim()
    .replace(/^["']|["']$/gu, "")
    .split(/[\\/]/u)
    .at(-1)
    ?.trim();
  return name?.toLocaleLowerCase("en-US").endsWith(".ctb")
    ? name.normalize("NFC").toLocaleLowerCase("en-US")
    : "";
}

function resetPlotStyleSession() {
  activePlotStyleName = "";
  activePlotStyleEnabled = false;
  plotStyleTables.clear();
  plotStylePreferences.clear();
  pendingPlotStyleRequests.clear();
  plotStyleToggle.disabled = true;
  plotStyleToggle.textContent = "출력 스타일";
  plotStyleToggle.setAttribute("aria-pressed", "false");
  plotStyleToggle.title = "배치에 지정된 CTB 출력 스타일 표시 전환";
}

function setPlotStyleUnavailable(name, state) {
  const label =
    {
      ambiguous: "동일한 CTB가 여러 곳에 있어 자동 선택하지 않았습니다.",
      invalid: "CTB 파일을 읽을 수 없습니다.",
      missing: "같은 이름의 CTB 파일을 찾지 못했습니다.",
      unavailable: "VS Code에서 DWG를 열면 CTB를 자동으로 찾습니다.",
    }[state] ?? "CTB 출력 스타일을 사용할 수 없습니다.";
  plotStyleToggle.disabled = true;
  plotStyleToggle.textContent = "출력 없음";
  plotStyleToggle.setAttribute("aria-pressed", "false");
  plotStyleToggle.title = `${name} · ${label}`;
}

function clearPlotStyleForView(scene) {
  scene.renderer.clearPlotStyle();
  activeTextComposite?.setPalette(scene.renderer.aciPalette);
}

function applyPlotStyleEntry(scene, key, entry, enabled) {
  if (activeScene !== scene || entry?.status !== "loaded") {
    return;
  }
  try {
    if (enabled) {
      const palette = makePlotStylePalette(entry.table);
      scene.renderer.setPlotStyle(
        palette,
        makePlotStyleLineWeights(entry.table),
      );
      activeTextComposite?.setPalette(palette);
    } else {
      clearPlotStyleForView(scene);
    }
    activePlotStyleName = key;
    activePlotStyleEnabled = enabled;
    plotStylePreferences.set(key, enabled);
    plotStyleToggle.disabled = false;
    plotStyleToggle.textContent = enabled ? "출력 켬" : "출력 끔";
    plotStyleToggle.setAttribute("aria-pressed", String(enabled));
    const details = plotStyleDiagnostics(entry.table);
    plotStyleToggle.title =
      `${entry.resolvedName || entry.requestedName || key} · ` +
      `색 ${details.colorOverrides.toLocaleString()} · ` +
      `선굵기 ${details.lineWeightOverrides.toLocaleString()} · ` +
      "클릭하여 원본 화면 색과 전환";
    activeInteraction?.refresh();
  } catch (error) {
    console.error(error);
    setPlotStyleUnavailable(key, "invalid");
  }
}

function configurePlotStyleForView(scene, view, revision) {
  clearPlotStyleForView(scene);
  activePlotStyleName = "";
  activePlotStyleEnabled = false;
  plotStyleToggle.setAttribute("aria-pressed", "false");
  if (view?.kind !== "layout") {
    plotStyleToggle.disabled = true;
    plotStyleToggle.textContent = "출력 스타일";
    plotStyleToggle.title = "모델 탭은 화면 색으로 표시합니다.";
    return;
  }
  const requestedName = view.layout?.styleSheet ?? "";
  const key = normalizePlotStyleName(requestedName);
  if (!key) {
    setPlotStyleUnavailable("이 배치", "missing");
    return;
  }
  activePlotStyleName = key;
  activePlotStyleEnabled =
    plotStylePreferences.get(key) ??
    plotStyleShownInLayout(view.layout);
  const cached = plotStyleTables.get(key);
  if (cached?.status === "loaded") {
    applyPlotStyleEntry(
      scene,
      key,
      cached,
      activePlotStyleEnabled,
    );
    return;
  }
  if (cached) {
    setPlotStyleUnavailable(requestedName, cached.status);
    return;
  }
  if (!vscodeApi || !activeHostCacheId) {
    setPlotStyleUnavailable(requestedName, "unavailable");
    return;
  }
  const alreadyPending = [...pendingPlotStyleRequests.values()].some(
    (request) =>
      request.cacheId === activeHostCacheId && request.key === key,
  );
  plotStyleToggle.disabled = true;
  plotStyleToggle.textContent = "출력 찾는 중";
  plotStyleToggle.title = `${requestedName} 자동 검색 중`;
  if (alreadyPending) {
    return;
  }
  const requestId = nextPlotStyleRequestId++;
  pendingPlotStyleRequests.set(requestId, {
    cacheId: activeHostCacheId,
    key,
    requestedName,
    revision,
  });
  vscodeApi.postMessage({
    type: "dwg-plot-style-read/1",
    cacheId: activeHostCacheId,
    requestId,
    name: requestedName,
  });
}

function handleHostPlotStyleResponse(message) {
  const pending = pendingPlotStyleRequests.get(message?.requestId);
  if (
    !pending ||
    pending.cacheId !== activeHostCacheId ||
    message.cacheId !== activeHostCacheId
  ) {
    return;
  }
  pendingPlotStyleRequests.delete(message.requestId);
  const statusValue = ["loaded", "missing", "ambiguous", "invalid"].includes(
    message.status,
  )
    ? message.status
    : "invalid";
  const entry = Object.freeze({
    status: statusValue,
    requestedName: pending.requestedName,
    resolvedName:
      typeof message.resolvedName === "string"
        ? message.resolvedName.slice(0, 512)
        : "",
    table: message.table,
  });
  plotStyleTables.set(pending.key, entry);
  if (
    pending.revision !== openRevision ||
    activePlotStyleName !== pending.key ||
    !activeScene
  ) {
    return;
  }
  if (entry.status === "loaded") {
    applyPlotStyleEntry(
      activeScene,
      pending.key,
      entry,
      activePlotStyleEnabled,
    );
  } else {
    setPlotStyleUnavailable(pending.requestedName, entry.status);
  }
}

function requiredFonts(styles) {
  const required = new Map();
  for (const style of styles) {
    for (const [name, isBigFont] of [
      [style.fontFile, false],
      [style.bigFontFile, true],
    ]) {
      const outline = !isBigFont && isOutlineFontReference(name);
      const shx = isShxFontReference(name, { bigFont: isBigFont });
      if (!outline && !shx) {
        continue;
      }
      const key = normalizeShxFontName(name);
      if (!key) {
        continue;
      }
      const existing = required.get(key);
      if (!existing) {
        required.set(key, {
          key,
          name,
          displayName: displayFontName(name),
          isBigFont,
          kind: outline ? "outline" : "shx",
        });
      } else if (isBigFont && !existing.isBigFont) {
        required.set(key, {
          ...existing,
          isBigFont: true,
          kind: "shx",
        });
      }
    }
  }
  return required;
}

function mergeTextStyles(...styleGroups) {
  const merged = new Map();
  for (const styles of styleGroups) {
    for (const style of styles) {
      const key = [
        normalizeShxFontName(style?.fontFile),
        normalizeShxFontName(style?.bigFontFile),
        normalizeShxFontName(style?.trueTypeFont),
      ].join("\u0000");
      if (!merged.has(key)) {
        merged.set(key, style);
      }
    }
  }
  return Object.freeze([...merged.values()]);
}

function fontStateLabel(state) {
  return (
    {
      loaded: "연결됨",
      mapped: "대체됨",
      loading: "찾는 중",
      missing: "누락",
      ambiguous: "선택 필요",
      invalid: "손상",
      unreadable: "읽기 실패",
      "too-large": "크기 초과",
      "budget-exceeded": "한도 초과",
    }[state] ?? "확인 중"
  );
}

function bigFontEncodingLabel(encoding) {
  return (
    {
      auto: "자동(EUC-KR → CP949 → Johab)",
      "euc-kr": "EUC-KR",
      cp949: "CP949/UHC",
      johab: "Johab/CP1361",
    }[encoding] ?? "자동"
  );
}

function renderFontDiagnostics() {
  const entries = [...fontDiagnostics.values()];
  const ready = entries.filter(({ state }) =>
    ["loaded", "mapped"].includes(state),
  ).length;
  const loading = entries.filter(({ state }) => state === "loading").length;
  const failures = entries.length - ready - loading;
  fontSummary.textContent =
    entries.length === 0
      ? "요구 글꼴 없음"
      : `${ready.toLocaleString()} / ${entries.length.toLocaleString()} 연결`;
  fontsToggle.textContent =
    failures > 0 ? `글꼴 ${failures.toLocaleString()}` : "글꼴";
  fontStatusList.replaceChildren();

  if (entries.length === 0) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "font-name";
    name.textContent = "도면이 참조하는 SHX·BigFont가 없습니다.";
    item.append(name);
    fontStatusList.append(item);
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.sort((left, right) =>
    left.displayName.localeCompare(right.displayName, "ko"),
  );
  for (const entry of entries) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const state = document.createElement("span");
    name.className = "font-name";
    name.title = entry.name;
    name.textContent = entry.displayName;
    state.className = "font-state";
    state.dataset.state = entry.state;
    state.textContent = fontStateLabel(entry.state);
    item.append(name, state);
    const resolution =
      entry.state === "mapped"
        ? `${displayFontName(entry.resolvedName)} 파일로 대체`
        : entry.state === "loaded" && entry.size
          ? `${entry.source === "drawing" ? "도면 폴더" : entry.source === "project" ? "프로젝트 폴더" : entry.source === "configured" ? "등록 폴더" : "현재 세션"} · ${formatBytes(entry.size)}`
          : entry.error;
    const detailText = [
      resolution,
      entry.isBigFont
        ? `문자 코드: ${bigFontEncodingLabel(entry.encoding)}`
        : entry.kind === "outline"
          ? "TrueType/OpenType"
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (detailText) {
      const detail = document.createElement("span");
      detail.className = "font-resolution";
      detail.textContent = detailText;
      item.append(detail);
    }
    fragment.append(item);
  }
  fontStatusList.append(fragment);
}

function xrefStateLabel(state) {
  return (
    {
      waiting: "대기",
      searching: "찾는 중",
      converting: "변환 중",
      decoding: "표시 준비",
      ready: "연결됨",
      missing: "누락",
      ambiguous: "선택 필요",
      cycle: "순환 참조",
      limit: "한도",
      unsupported: "미지원",
      error: "오류",
    }[state] ?? "확인 중"
  );
}

function renderXrefDiagnostics() {
  const entries = [...xrefDiagnostics.values()];
  const ready = entries.filter((entry) => entry.status === "ready").length;
  const unresolved = entries.filter((entry) =>
    [
      "missing",
      "ambiguous",
      "cycle",
      "limit",
      "unsupported",
      "error",
    ].includes(
      entry.status,
    ),
  ).length;
  xrefSummary.textContent =
    entries.length === 0
      ? "참조 없음"
      : `${ready.toLocaleString()} / ${entries.length.toLocaleString()} 연결`;
  xrefsToggle.textContent =
    unresolved > 0
      ? `외부 참조 ${unresolved.toLocaleString()}`
      : "외부 참조";
  xrefsToggle.disabled = entries.length === 0;
  xrefStatusList.replaceChildren();
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.textContent = "이 도면에는 외부 도면이나 이미지 참조가 없습니다.";
    xrefStatusList.append(item);
    return;
  }
  entries.sort(
    (left, right) =>
      (left.depth ?? 0) - (right.depth ?? 0) ||
      String(left.kind ?? "xref").localeCompare(
        String(right.kind ?? "xref"),
      ) ||
      left.name.localeCompare(right.name, "ko"),
  );
  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const state = document.createElement("span");
    const storedPath = document.createElement("span");
    name.className = "xref-name";
    name.textContent =
      entry.kind === "image"
        ? `이미지 · ${entry.name || "(이름 없음)"}`
        : entry.name || "(이름 없음)";
    state.className = "xref-state";
    state.dataset.state = entry.status;
    state.textContent = xrefStateLabel(entry.status);
    storedPath.className = "xref-path";
    storedPath.title = entry.storedPath ?? "";
    storedPath.textContent =
      entry.fileName || entry.storedPath || "저장 경로 없음";
    item.append(name, state, storedPath);
    if (entry.message) {
      const detail = document.createElement("span");
      detail.className = "xref-message";
      detail.textContent = entry.message;
      item.append(detail);
    }
    if (entry.canSelect && vscodeApi) {
      const select = document.createElement("button");
      select.type = "button";
      select.className = "xref-select";
      select.textContent = "파일 직접 선택";
      select.addEventListener("click", () => {
        select.disabled = true;
        vscodeApi.postMessage(
          entry.kind === "image"
            ? {
                type: "dwg-image-select/1",
                cacheId: entry.cacheId,
                imageIndex: entry.imageIndex,
              }
            : {
                type: "dwg-xref-select/1",
                parentCacheId: entry.parentCacheId,
                blockIndex: entry.blockIndex,
              },
        );
      });
      item.append(select);
    }
    fragment.append(item);
  }
  xrefStatusList.append(fragment);
}

function resetExternalReferences() {
  for (const source of externalHostSources.values()) {
    source.dispose();
  }
  externalHostSources.clear();
  externalRangeSources.clear();
  externalCacheData.clear();
  externalAttachmentsByCache.clear();
  discoveredXrefCaches.clear();
  readyExternalMessages.clear();
  xrefDiagnostics.clear();
  externalSourceOverviewBytes = 0;
  externalLoadQueue = Promise.resolve();
  activeTextComposite = undefined;
  activeImageComposite = undefined;
  activeImageAssetStore?.dispose();
  activeImageAssetStore = undefined;
  pendingImageRequests.clear();
  xrefsToggle.disabled = true;
  xrefsToggle.textContent = "외부 참조";
  xrefsToggle.setAttribute("aria-expanded", "false");
  xrefPanel.hidden = true;
  renderXrefDiagnostics();
}

function syncFontDiagnostics(styles) {
  activeTextStyles = Object.freeze([...styles]);
  const required = requiredFonts(styles);
  for (const key of [...fontDiagnostics.keys()]) {
    if (!required.has(key)) {
      fontDiagnostics.delete(key);
    }
  }
  for (const descriptor of required.values()) {
    const existing = fontDiagnostics.get(descriptor.key);
    const cacheStatus =
      descriptor.kind === "outline"
        ? localOutlineFaces.has(descriptor.key)
          ? { state: "registered", size: localOutlineFaces.get(descriptor.key).size }
          : { state: "missing" }
        : glyphCache.fontStatus(descriptor.name);
    const encoding = descriptor.isBigFont
      ? glyphCache.legacyEncodingForFont(descriptor.name)
      : undefined;
    if (cacheStatus.state === "invalid") {
      fontDiagnostics.set(descriptor.key, {
        ...existing,
        ...descriptor,
        encoding,
        state: "invalid",
        error:
          descriptor.kind === "outline"
            ? "TTF/OTF 파일을 해석할 수 없습니다."
            : "SHX 파일 형식을 해석할 수 없습니다.",
      });
    } else if (cacheStatus.state === "registered") {
      fontDiagnostics.set(descriptor.key, {
        ...existing,
        ...descriptor,
        encoding,
        state:
          existing?.state === "mapped" ? "mapped" : "loaded",
        size: existing?.size ?? cacheStatus.size,
        source: existing?.source ?? "session",
      });
    } else if (!existing) {
      fontDiagnostics.set(descriptor.key, {
        ...descriptor,
        encoding,
        state: "missing",
        error: vscodeApi
          ? "도면·프로젝트·등록 글꼴 폴더에서 찾지 못했습니다."
          : "글꼴 파일을 선택해 연결할 수 있습니다.",
      });
    }
  }
  fontsToggle.disabled = false;
  renderFontDiagnostics();
}

function requestHostFonts(styles = activeTextStyles, revision = openRevision) {
  if (!vscodeApi || !activeHostCacheId || revision !== openRevision) {
    return;
  }
  const required = requiredFonts(styles);
  for (const descriptor of required.values()) {
    if (
      (descriptor.kind === "outline"
        ? localOutlineFaces.has(descriptor.key)
        : glyphCache.hasFont(descriptor.name)) ||
      attemptedHostFontKeys.has(descriptor.key)
    ) {
      continue;
    }
    attemptedHostFontKeys.add(descriptor.key);
    const encoding = descriptor.isBigFont
      ? glyphCache.legacyEncodingForFont(descriptor.name)
      : undefined;
    const requestId = nextHostFontRequestId;
    nextHostFontRequestId += 1;
    pendingHostFontRequests.set(requestId, {
      ...descriptor,
      encoding,
      cacheId: activeHostCacheId,
      revision,
    });
    fontDiagnostics.set(descriptor.key, {
      ...descriptor,
      encoding,
      state: "loading",
    });
    vscodeApi.postMessage({
      type: "dwg-font-read/1",
      cacheId: activeHostCacheId,
      requestId,
      name: descriptor.name,
    });
  }
  renderFontDiagnostics();
}

function refreshTextAfterFontChange(revision) {
  if (revision !== openRevision || !activeScene) {
    return;
  }
  activeInteraction?.refresh();
  const missing = glyphCache.missingFonts(activeTextStyles);
  activeTextStatus = Object.freeze({
    sourceTexts: activeTextStatus?.sourceTexts ?? 0,
    missingFonts: missing,
  });
  syncFontDiagnostics(activeTextStyles);
  status.textContent =
    missing.length === 0
      ? "도면 글꼴 연결 완료"
      : `도면 글꼴 확인 완료${missingFontSuffix()}(시스템 글꼴 대체)`;
}

function scheduleFontRefresh(revision) {
  if (fontRefreshTimer !== undefined) {
    clearTimeout(fontRefreshTimer);
  }
  fontRefreshTimer = setTimeout(() => {
    fontRefreshTimer = undefined;
    refreshTextAfterFontChange(revision);
  }, 40);
}

function unregisterHostFont(key) {
  const outline = localOutlineFaces.get(key);
  if (outline) {
    document.fonts.delete(outline.face);
    unregisterLocalOutlineFont(outline.name);
    localOutlineFaces.delete(key);
  } else {
    glyphCache.unregisterFont(key);
  }
  hostLoadedFontKeys.delete(key);
}

function clearHostFonts() {
  for (const key of [...hostLoadedFontKeys]) {
    unregisterHostFont(key);
  }
  hostLoadedFontKeys.clear();
}

async function registerHostOutlineFont(pending, message) {
  if (
    typeof FontFace !== "function" ||
    !(message.bytes instanceof ArrayBuffer)
  ) {
    throw new Error("local outline fonts are unsupported");
  }
  unregisterHostFont(pending.key);
  const family = `DwgLocalFont_${pending.revision}_${message.requestId}`;
  const face = new FontFace(family, message.bytes);
  await face.load();
  if (
    pending.revision !== openRevision ||
    pending.cacheId !== activeHostCacheId
  ) {
    return undefined;
  }
  document.fonts.add(face);
  registerLocalOutlineFont(pending.name, family);
  const entry = Object.freeze({
    face,
    family,
    name: pending.name,
    size: Number.isSafeInteger(message.size) ? message.size : 0,
  });
  localOutlineFaces.set(pending.key, entry);
  return entry;
}

async function handleHostFontResponse(message) {
  const pending = pendingHostFontRequests.get(message?.requestId);
  if (!pending) {
    return;
  }
  pendingHostFontRequests.delete(message.requestId);
  if (
    pending.revision !== openRevision ||
    pending.cacheId !== activeHostCacheId ||
    message.cacheId !== activeHostCacheId
  ) {
    return;
  }
  if (message.status === "loaded") {
    try {
      const registered =
        pending.kind === "outline"
          ? await registerHostOutlineFont(pending, message)
          : glyphCache.registerFont(pending.name, message.bytes);
      if (!registered) {
        return;
      }
      const mapped =
        message.source === "mapping" ||
        normalizeShxFontName(message.resolvedName) !== pending.key;
      fontDiagnostics.set(pending.key, {
        ...pending,
        state: mapped ? "mapped" : "loaded",
        resolvedName: message.resolvedName,
        source: message.source,
        size: registered.size ?? message.size,
      });
      hostLoadedFontKeys.add(pending.key);
      scheduleFontRefresh(pending.revision);
    } catch {
      fontDiagnostics.set(pending.key, {
        ...pending,
        state: "invalid",
        error:
          pending.kind === "outline"
            ? "TTF/OTF 파일을 등록하거나 해석할 수 없습니다."
            : "SHX 파일을 등록하거나 해석할 수 없습니다.",
      });
      renderFontDiagnostics();
    }
    return;
  }
  const allowedFailures = new Set([
    "missing",
    "ambiguous",
    "invalid",
    "too-large",
    "budget-exceeded",
    "unreadable",
  ]);
  fontDiagnostics.set(pending.key, {
    ...pending,
    state: allowedFailures.has(message.status)
      ? message.status
      : "unreadable",
    error:
      typeof message.error === "string"
        ? message.error.slice(0, 200)
        : "글꼴을 연결하지 못했습니다.",
  });
  renderFontDiagnostics();
}

function handleFontConfigurationChanged(message) {
  if (
    !activeHostCacheId ||
    message.cacheId !== activeHostCacheId ||
    !activeScene
  ) {
    return;
  }
  glyphCache.configureLegacyEncodings(message.bigFontEncodings);
  clearHostFonts();
  pendingHostFontRequests.clear();
  attemptedHostFontKeys.clear();
  syncFontDiagnostics(activeTextStyles);
  requestHostFonts(activeTextStyles, openRevision);
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
  const externalReads = [...externalRangeSources.values()].reduce(
    (total, source) => {
      const snapshot = source.snapshot();
      total.requests += snapshot.requests;
      total.bytesRead += snapshot.bytesRead;
      total.maximumRequestBytes = Math.max(
        total.maximumRequestBytes,
        snapshot.maximumRequestBytes,
      );
      return total;
    },
    { requests: 0, bytesRead: 0, maximumRequestBytes: 0 },
  );
  const render = viewport?.render ?? value.renderer;
  const memory = activeMemoryTelemetry?.sample(
    render?.gpuTrackedBytes ?? 0,
  );
  const detail = viewport?.detail;
  const xrefRows =
    (render?.externalScenes ?? 0) > 0 || xrefDiagnostics.size > 0
      ? `
      <div><dt>참조도면 장면</dt><dd>${(render?.externalScenes ?? 0).toLocaleString()}개</dd></div>
      <div><dt>참조 첫 화면 원본</dt><dd>${formatBytes(externalSourceOverviewBytes)}</dd></div>
      <div><dt>참조 첫 화면 GPU</dt><dd>${formatBytes(render?.externalOverviewGpuBytes ?? 0)}</dd></div>
      <div><dt>참조 상세 GPU</dt><dd>${formatBytes(render?.externalDetailGpuBytes ?? 0)}</dd></div>
      <div><dt>참조 범위 읽기</dt><dd>${formatBytes(externalReads.bytesRead)}</dd></div>
    `
      : "";
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
  const images = render?.images;
  const imageRows = images
    ? `
      <div><dt>이미지 원본</dt><dd>${images.sourceImages.toLocaleString()}개</dd></div>
      <div><dt>화면 이미지</dt><dd>${images.loadedOccurrences.toLocaleString()} / ${images.visibleOccurrences.toLocaleString()}개</dd></div>
      <div><dt>이미지 대기</dt><dd>${(images.requestedImages + images.decodingImages).toLocaleString()}개</dd></div>
      <div><dt>이미지 압축 메모리</dt><dd>${formatBytes(images.memory?.compressedBytes ?? 0)}</dd></div>
      <div><dt>이미지 화면 메모리</dt><dd>${formatBytes(images.memory?.decodedBytes ?? 0)}</dd></div>
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
      <div><dt>가림 순서</dt><dd>${activeMaskStatus.enabled ? (activeWipeoutMasksVisible ? "표시" : "숨김") : "비활성"}</dd></div>
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
      ${xrefRows}
      ${memoryRows}
      ${detailRows}
      ${hatchRows}
      ${patternRows}
      ${primitiveRows}
      ${maskRows}
      ${imageRows}
      ${textRows}
    </dl>
  `;
}

function setControlsEnabled(enabled) {
  for (const control of viewControls) {
    control.disabled = !enabled;
  }
  layersToggle.disabled = !enabled;
  wipeoutToggle.disabled = !enabled || !activeMaskStatus?.enabled;
  if (activeReviewTools) {
    activeReviewTools.setEnabled(enabled);
  } else {
    reviewToolbar.hidden = true;
  }
}

function updateWipeoutToggle() {
  wipeoutToggle.textContent =
    activeWipeoutMasksVisible ? "가림 켬" : "가림 끔";
  wipeoutToggle.setAttribute(
    "aria-pressed",
    String(activeWipeoutMasksVisible),
  );
  wipeoutToggle.title = activeWipeoutMasksVisible
    ? "가림 객체를 숨겨 가려진 도면 확인"
    : "도면의 가림 객체 다시 표시";
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
      activeReviewTools?.redraw();
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
  activeReviewTools?.redraw();
  updateLayerSummary();
}

function imageDiagnosticKey(cacheId, imageIndex) {
  return `image:${cacheId}:${imageIndex}`;
}

function imageRequestKey(cacheId, imageIndex) {
  return `${cacheId}:${imageIndex}`;
}

function displayReferenceName(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.slice(0, 300) || "(경로 없음)";
}

function requestRasterImage({ cacheId, imageIndex, path }) {
  if (
    !vscodeApi ||
    !activeImageAssetStore ||
    typeof cacheId !== "string" ||
    !Number.isSafeInteger(imageIndex) ||
    imageIndex < 0 ||
    typeof path !== "string" ||
    path.length > 32_768
  ) {
    return false;
  }
  const key = imageRequestKey(cacheId, imageIndex);
  if (pendingImageRequests.has(key)) {
    return false;
  }
  const requestId = nextImageRequestId;
  nextImageRequestId += 1;
  const pending = Object.freeze({
    cacheId,
    imageIndex,
    requestId,
    path,
    revision: openRevision,
  });
  pendingImageRequests.set(key, pending);
  xrefDiagnostics.set(imageDiagnosticKey(cacheId, imageIndex), {
    kind: "image",
    cacheId,
    imageIndex,
    requestId,
    revision: openRevision,
    name: displayReferenceName(path),
    storedPath: path,
    status: "searching",
    depth: 0,
    canSelect: false,
  });
  renderXrefDiagnostics();
  vscodeApi.postMessage({
    type: "dwg-image-read/1",
    cacheId,
    imageIndex,
    requestId,
    path,
  });
  return true;
}

function handleImageStatus(message) {
  if (
    typeof message?.cacheId !== "string" ||
    !Number.isSafeInteger(message.imageIndex)
  ) {
    return;
  }
  const key = imageDiagnosticKey(message.cacheId, message.imageIndex);
  const existing = xrefDiagnostics.get(key);
  if (existing?.kind !== "image" || existing.revision !== openRevision) {
    return;
  }
  xrefDiagnostics.set(key, {
    ...existing,
    status: message.status === "searching" ? "searching" : existing.status,
  });
  renderXrefDiagnostics();
}

function imageResolutionMessage(resolution) {
  if (resolution === "relative") {
    return "도면과 같은 위치의 상대경로에서 연결했습니다.";
  }
  if (resolution === "search") {
    return "파일명과 상위 폴더 일치 순으로 자동 연결했습니다.";
  }
  if (typeof resolution === "string" && resolution.startsWith("manual")) {
    return "저장된 수동 연결을 적용했습니다.";
  }
  return "저장된 경로에서 연결했습니다.";
}

function handleImageResponse(message) {
  if (
    typeof message?.cacheId !== "string" ||
    !Number.isSafeInteger(message.imageIndex) ||
    !Number.isSafeInteger(message.requestId)
  ) {
    return;
  }
  const requestKey = imageRequestKey(
    message.cacheId,
    message.imageIndex,
  );
  const diagnosticKey = imageDiagnosticKey(
    message.cacheId,
    message.imageIndex,
  );
  const pending = pendingImageRequests.get(requestKey);
  const existing = xrefDiagnostics.get(diagnosticKey);
  const knownRequest =
    pending?.requestId === message.requestId &&
    pending.revision === openRevision;
  const knownManualRetry =
    existing?.kind === "image" &&
    existing.requestId === message.requestId &&
    existing.revision === openRevision;
  if (
    (!knownRequest && !knownManualRetry) ||
    !activeImageAssetStore
  ) {
    return;
  }
  if (message.ok !== true) {
    const knownStates = new Set([
      "missing",
      "ambiguous",
      "limit",
      "unsupported",
    ]);
    const state = knownStates.has(message.status)
      ? message.status
      : "error";
    xrefDiagnostics.set(diagnosticKey, {
      ...existing,
      kind: "image",
      cacheId: message.cacheId,
      imageIndex: message.imageIndex,
      requestId: message.requestId,
      revision: openRevision,
      name: existing?.name ?? "(이미지)",
      storedPath: existing?.storedPath ?? pending?.path ?? "",
      status: state,
      message:
        typeof message.message === "string"
          ? message.message.slice(0, 240)
          : "이미지 파일을 연결하지 못했습니다.",
      canSelect: Boolean(message.canSelect),
    });
    if (!message.canSelect) {
      pendingImageRequests.delete(requestKey);
    }
    renderXrefDiagnostics();
    return;
  }
  try {
    activeImageAssetStore.accept(message);
  } catch (error) {
    pendingImageRequests.delete(requestKey);
    xrefDiagnostics.set(diagnosticKey, {
      ...existing,
      status: "error",
      canSelect: true,
      message:
        error instanceof Error
          ? error.message.slice(0, 240)
          : "이미지 데이터를 안전하게 받을 수 없습니다.",
    });
    renderXrefDiagnostics();
    return;
  }
  pendingImageRequests.delete(requestKey);
  xrefDiagnostics.set(diagnosticKey, {
    ...existing,
    status: "ready",
    canSelect: false,
    resourceId: message.resourceId,
    fileName:
      typeof message.fileName === "string"
        ? message.fileName.slice(0, 300)
        : existing?.fileName,
    message: imageResolutionMessage(message.resolution),
  });
  renderXrefDiagnostics();
  activeInteraction?.refresh();
}

async function initializeImageOverlay(
  scene,
  revision,
  cacheId,
  instanceGraph = activeRenderInstanceGraph ?? scene.instanceGraph,
) {
  if (
    scene.reader.header.minor < 18 ||
    !activeImageAssetStore ||
    !cacheId
  ) {
    return;
  }
  const composite = activeImageComposite;
  const imageEntities =
    scene.imageEntities ?? (await scene.reader.readImageEntities());
  if (
    revision !== openRevision ||
    activeScene !== scene ||
    !activeImageAssetStore ||
    activeImageComposite !== composite ||
    instanceGraph !==
      (activeRenderInstanceGraph ?? scene.instanceGraph)
  ) {
    return;
  }
  if (!activeImageComposite) {
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    scene.renderer.setImageOverlay(activeImageComposite);
  }
  const overlay = new CanvasRasterImageOverlay(imageCanvas, {
      imageEntities,
      blocks: scene.metadata.blocks,
      layers: scene.metadata.layers,
      instanceGraph,
      cacheId,
      assetStore: activeImageAssetStore,
      requestAsset: requestRasterImage,
    });
  activeImageComposite.add(
    overlay,
    { first: true },
  );
  scene.renderer.setSupplementalBounds("root", overlay.bounds);
  activeInteraction?.refresh();
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
  if (
    revision !== openRevision ||
    activeScene !== scene ||
    instanceGraph !==
      (activeRenderInstanceGraph ?? scene.instanceGraph)
  ) {
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
  if (!activeTextComposite) {
    activeTextComposite = new CompositeTextOverlay(textCanvas);
    scene.renderer.setTextOverlay(activeTextComposite);
  }
  activeTextComposite.add(overlay, { first: true });
  if (scene.reader.header.minor >= 15) {
    const complexOverlay = new ComplexLinetypeOverlay(textCanvas, {
      vertices: scene.overview,
      batches: scene.metadata.batches,
      linetypes: scene.metadata.linetypes,
      textStyles: styles,
      layers: scene.metadata.layers,
      instanceGraph,
      glyphCache,
      globalLinetypeScale:
        scene.metadata.drawing.globalLinetypeScale,
    });
    if (complexOverlay.source.sourceSegments > 0) {
      activeTextComposite.add(complexOverlay);
    }
  }
  const missing = glyphCache.missingFonts(styles);
  activeTextStatus = Object.freeze({
    sourceTexts: textEntities.length,
    missingFonts: missing,
  });
  activeInteraction?.refresh();
  syncFontDiagnostics(styles);
  requestHostFonts(styles, revision);
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
    ? typeof scene.buildViewInstanceGraph === "function"
      ? scene.buildViewInstanceGraph(scene.activeView, { maskOrder })
      : applyMaskOrderToInstanceGraph(
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

function hatchWorkerView(scene) {
  const view =
    scene.views.find((candidate) => candidate.id === activeViewId) ??
    scene.activeView;
  return view?.kind === "layout"
    ? Object.freeze({
        kind: "layout",
        layoutIndex: view.layout.index,
      })
    : Object.freeze({ kind: "model" });
}

async function createViewerWorker(relativeUrl) {
  const workerUrl = new URL(relativeUrl, import.meta.url);
  if (!vscodeApi) {
    const worker = new Worker(workerUrl, { type: "module" });
    return {
      worker,
      terminate() {
        worker.terminate();
      },
    };
  }
  const response = await fetch(workerUrl);
  if (!response.ok) {
    throw new Error(`작업 모듈을 읽을 수 없습니다 (${response.status})`);
  }
  const blobUrl = URL.createObjectURL(
    new Blob([await response.arrayBuffer()], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl, { type: "module" });
  return {
    worker,
    terminate() {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    },
  };
}

function workerSourcePayload(workerSource) {
  return workerSource.kind === "host"
    ? { hostSource: { size: workerSource.source.size } }
    : { file: workerSource.file };
}

async function createHatchWorker(workerSource) {
  const workerHandle = await createViewerWorker("./hatch-worker.mjs");
  const { worker } = workerHandle;
  const removeRangeProxy =
    workerSource.kind === "host"
      ? installWorkerRangeProxy(worker, workerSource.source)
      : () => {};
  const pending = new Map();
  let nextRequestId = 1;
  let closed = false;
  const terminate = () => {
    removeRangeProxy();
    workerHandle.terminate();
  };
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  worker.addEventListener("message", (event) => {
    if (event.data?.type === WORKER_RANGE_REQUEST) {
      return;
    }
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
    terminate();
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
      terminate();
      rejectPending(new DOMException("HATCH 작업 취소됨", "AbortError"));
    },
  };
}

async function createPrimitiveWorker(workerSource) {
  const workerHandle = await createViewerWorker("./primitive-worker.mjs");
  const { worker } = workerHandle;
  const removeRangeProxy =
    workerSource.kind === "host"
      ? installWorkerRangeProxy(worker, workerSource.source)
      : () => {};
  let settled = false;
  let rejectRequest;
  let messageListener;
  let errorListener;
  const terminate = () => {
    if (messageListener) {
      worker.removeEventListener("message", messageListener);
      messageListener = undefined;
    }
    if (errorListener) {
      worker.removeEventListener("error", errorListener);
      errorListener = undefined;
    }
    removeRangeProxy();
    workerHandle.terminate();
  };
  return {
    initialize(wipeoutFrame, maskOrder) {
      if (settled) {
        return Promise.reject(
          new DOMException("후처리 작업 취소됨", "AbortError"),
        );
      }
      return new Promise((resolve, reject) => {
        rejectRequest = reject;
        messageListener = (event) => {
          if (
            settled ||
            event.data?.type === WORKER_RANGE_REQUEST
          ) {
            return;
          }
          settled = true;
          terminate();
          rejectRequest = undefined;
          if (event.data.ok) {
            resolve(event.data);
          } else {
            reject(new Error(event.data.error));
          }
        };
        errorListener = (event) => {
          if (settled) {
            return;
          }
          settled = true;
          terminate();
          rejectRequest = undefined;
          reject(new Error(event.message || "후처리 worker failed"));
        };
        worker.addEventListener("message", messageListener);
        worker.addEventListener("error", errorListener);
        worker.postMessage({
          requestId: 1,
          type: "initialize",
          ...workerSourcePayload(workerSource),
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
      terminate();
      rejectRequest?.(
        new DOMException("후처리 작업 취소됨", "AbortError"),
      );
      rejectRequest = undefined;
    },
  };
}

async function initializePrimitives(
  workerSource,
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
  const worker = await createPrimitiveWorker(workerSource);
  if (revision !== openRevision || activeScene !== scene) {
    worker.cancel();
    return;
  }
  activePrimitiveWorker = worker;
  let result;
  try {
    result = await worker.initialize(
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
  workerSource,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  if (scene.reader.header.minor < 6) {
    return;
  }
  activeHatchStatus = Object.freeze({ state: "loading" });
  status.textContent = "해치 원본을 별도 작업 공간에서 읽는 중";
  const worker = await createHatchWorker(workerSource);
  if (revision !== openRevision || activeScene !== scene) {
    worker.cancel();
    return;
  }
  activeHatchWorker = worker;
  const initialPatternCameraKey = patternCameraKey(scene.render.camera);
  const result = await worker.request("initialize", {
    ...workerSourcePayload(workerSource),
    camera: workerCamera(scene.render.camera),
    maskOrder,
    view: hatchWorkerView(scene),
  });
  if (revision !== openRevision || activeScene !== scene) {
    worker.cancel();
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
        view: hatchWorkerView(scene),
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

function invalidatePendingHatchPatterns() {
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
}

async function initializeDeferredGeometry(
  workerSource,
  scene,
  revision,
  maskOrder = activeMaskOrder,
) {
  try {
    await initializePrimitives(workerSource, scene, revision, maskOrder);
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
    await initializeHatchFills(workerSource, scene, revision, maskOrder);
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
  for (const font of registered) {
    hostLoadedFontKeys.delete(normalizeShxFontName(font.name));
  }
  if (activeScene) {
    if (activeScene.renderer.textOverlay) {
      activeInteraction?.refresh();
    } else {
      await initializeTextOverlay(activeScene, openRevision);
    }
    const styles = await activeScene.reader.readTextStyles();
    syncFontDiagnostics(styles);
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

function discoverExternalReferences(scene, cacheId, depth = 0) {
  if (
    !vscodeApi ||
    !cacheId ||
    scene.reader.header.minor < 12 ||
    discoveredXrefCaches.has(cacheId)
  ) {
    return;
  }
  discoveredXrefCaches.add(cacheId);
  const references = scene.metadata.blocks
    .filter(
      (block) =>
        (block.flags & (1 << 2)) !== 0 &&
        typeof block.xrefPath === "string" &&
        block.xrefPath.length > 0,
    )
    .slice(0, 64)
    .map((block) => ({
      blockIndex: block.index,
      name: block.name,
      path: block.xrefPath,
      overlay: (block.flags & (1 << 3)) !== 0,
    }));
  for (const reference of references) {
    const key = `${cacheId}:${reference.blockIndex}`;
    if (!xrefDiagnostics.has(key)) {
      xrefDiagnostics.set(key, {
        ...reference,
        parentCacheId: cacheId,
        storedPath: reference.path,
        status: "waiting",
        depth,
      });
    }
  }
  renderXrefDiagnostics();
  if (references.length > 0) {
    vscodeApi.postMessage({
      type: "dwg-xrefs-discovered/1",
      cacheId,
      references,
    });
  }
}

function handleXrefStatus(message) {
  if (
    typeof message?.parentCacheId !== "string" ||
    !Number.isSafeInteger(message.blockIndex)
  ) {
    return;
  }
  const key = `${message.parentCacheId}:${message.blockIndex}`;
  const existing = xrefDiagnostics.get(key);
  if (!existing) {
    return;
  }
  xrefDiagnostics.set(key, {
    ...existing,
    status:
      typeof message.status === "string" ? message.status : "error",
    message:
      typeof message.message === "string"
        ? message.message.slice(0, 300)
        : undefined,
    canSelect: Boolean(message.canSelect),
  });
  renderXrefDiagnostics();
}

function externalParentContexts(parentCacheId) {
  if (
    parentCacheId === activeHostCacheId &&
    activeScene &&
    activeRenderInstanceGraph
  ) {
    return [
      {
        id: "root",
        prefix: "",
        instanceGraph: activeRenderInstanceGraph,
      },
    ];
  }
  return externalAttachmentsByCache.get(parentCacheId) ?? [];
}

function loadExternalCacheData(message, revision) {
  const existing = externalCacheData.get(message.cacheId);
  if (existing) {
    return existing;
  }
  const rawSource = createVsCodeRangeSource(vscodeApi, {
    cacheId: message.cacheId,
    size: message.size,
  });
  externalHostSources.set(message.cacheId, rawSource);
  const source = new TrackedRangeSource(rawSource);
  externalRangeSources.set(message.cacheId, source);
  const loading = loadExternalFirstFrame(source, {
    onProgress(progressMessage) {
      if (revision === openRevision) {
        status.textContent = progressMessage;
      }
    },
  })
    .then((scene) => {
      if (revision !== openRevision) {
        throw new Error("stale external reference load");
      }
      if (
        scene.overview.byteLength >
        MAX_EXTERNAL_SOURCE_OVERVIEW_BYTES -
          externalSourceOverviewBytes
      ) {
        throw new Error(
          `참조도면 첫 화면 데이터가 전체 ${formatBytes(
            MAX_EXTERNAL_SOURCE_OVERVIEW_BYTES,
          )} 한도를 초과합니다.`,
        );
      }
      externalSourceOverviewBytes += scene.overview.byteLength;
      return Object.freeze({ scene, source });
    })
    .catch((error) => {
      if (externalCacheData.get(message.cacheId) === loading) {
        externalCacheData.delete(message.cacheId);
        externalHostSources.delete(message.cacheId);
        externalRangeSources.delete(message.cacheId);
      }
      rawSource.dispose();
      throw error;
    });
  externalCacheData.set(message.cacheId, loading);
  return loading;
}

function enqueueExternalCacheReady(message) {
  const revision = openRevision;
  if (
    typeof message?.parentCacheId === "string" &&
    Number.isSafeInteger(message.parentBlockIndex) &&
    typeof message.cacheId === "string"
  ) {
    readyExternalMessages.set(
      `${message.parentCacheId}:${message.parentBlockIndex}:${message.cacheId}`,
      Object.freeze({ ...message }),
    );
  }
  externalLoadQueue = externalLoadQueue
    .catch(() => undefined)
    .then(async () => {
      if (revision !== openRevision) {
        return;
      }
      let mounted = false;
      try {
        await handleExternalCacheReady(message);
        mounted = true;
      } catch (error) {
        handleXrefStatus({
          parentCacheId: message.parentCacheId,
          blockIndex: message.parentBlockIndex,
          status: "error",
          message: `참조도면 표시 실패: ${
            error instanceof Error ? error.message : "알 수 없는 오류"
          }`,
        });
        console.error(error);
      } finally {
        if (
          vscodeApi &&
          typeof message?.parentCacheId === "string" &&
          Number.isSafeInteger(message.parentBlockIndex) &&
          typeof message.cacheId === "string"
        ) {
          vscodeApi.postMessage({
            type: "dwg-xref-mounted/1",
            parentCacheId: message.parentCacheId,
            blockIndex: message.parentBlockIndex,
            cacheId: message.cacheId,
            status: mounted ? "ready" : "error",
          });
        }
      }
    });
}

async function addExternalText(
  externalScene,
  composedInstanceGraph,
  layerMap,
  overview = null,
) {
  const revision = openRevision;
  const rootScene = activeScene;
  const textComposite = activeTextComposite;
  if (
    !rootScene ||
    !textComposite ||
    externalScene.reader.header.minor < 4
  ) {
    return;
  }
  const needsComplexOverlay =
    overview?.vertices && externalScene.reader.header.minor >= 15;
  const [textEntities, styles, rootStyles] = await Promise.all([
    externalScene.reader.readTextEntities(),
    externalScene.reader.readTextStyles(),
    needsComplexOverlay
      ? rootScene.reader.readTextStyles()
      : Promise.resolve(null),
  ]);
  if (
    revision !== openRevision ||
    activeScene !== rootScene ||
    activeTextComposite !== textComposite
  ) {
    return;
  }
  const remapped = remapTextEntityLayers(textEntities, layerMap);
  const overlay = new CanvasTextOverlay(textCanvas, {
    textEntities: remapped,
    blocks: externalScene.metadata.blocks,
    layers: rootScene.metadata.layers,
    instanceGraph: composedInstanceGraph,
    glyphCache,
  });
  textComposite.add(overlay);
  if (needsComplexOverlay) {
    const complexOverlay = new ComplexLinetypeOverlay(textCanvas, {
      vertices: overview.vertices,
      batches: overview.batches,
      linetypes: rootScene.metadata.linetypes,
      textStyles: rootStyles,
      layers: rootScene.metadata.layers,
      instanceGraph: composedInstanceGraph,
      glyphCache,
      globalLinetypeScale:
        rootScene.metadata.drawing.globalLinetypeScale,
    });
    if (complexOverlay.source.sourceSegments > 0) {
      textComposite.add(complexOverlay);
    }
  }
  const combinedStyles = mergeTextStyles(activeTextStyles, styles);
  syncFontDiagnostics(combinedStyles);
  requestHostFonts(combinedStyles, revision);
}

async function addExternalImages(
  externalScene,
  cacheId,
  sceneId,
  composedInstanceGraph,
  layerMap,
) {
  const revision = openRevision;
  const rootScene = activeScene;
  const store = activeImageAssetStore;
  const composite = activeImageComposite;
  if (
    !rootScene ||
    !store ||
    externalScene.reader.header.minor < 18
  ) {
    return;
  }
  const imageEntities =
    externalScene.imageEntities ??
    (await externalScene.reader.readImageEntities());
  if (
    revision !== openRevision ||
    activeScene !== rootScene ||
    activeImageAssetStore !== store ||
    activeImageComposite !== composite
  ) {
    return;
  }
  if (!activeImageComposite) {
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    rootScene.renderer.setImageOverlay(activeImageComposite);
  }
  const overlay = new CanvasRasterImageOverlay(imageCanvas, {
      imageEntities,
      blocks: externalScene.metadata.blocks,
      layers: externalScene.metadata.layers,
      instanceGraph: composedInstanceGraph,
      cacheId,
      assetStore: store,
      requestAsset: requestRasterImage,
      layerMap,
    });
  activeImageComposite.add(overlay);
  return rootScene.renderer.setSupplementalBounds(
    `image:${sceneId}`,
    overlay.bounds,
  );
}

async function handleExternalCacheReady(message) {
  if (
    !activeScene ||
    !activeInteraction ||
    typeof message?.cacheId !== "string" ||
    typeof message.parentCacheId !== "string" ||
    !Number.isSafeInteger(message.parentBlockIndex) ||
    !Number.isSafeInteger(message.size) ||
    message.size <= 0 ||
    typeof message.name !== "string"
  ) {
    return;
  }
  const revision = openRevision;
  const parentContexts = externalParentContexts(message.parentCacheId);
  if (parentContexts.length === 0) {
    return;
  }
  const loaded = await loadExternalCacheData(message, revision);
  if (revision !== openRevision || !activeScene || !activeInteraction) {
    return;
  }
  const childContexts = externalAttachmentsByCache.get(message.cacheId) ?? [];
  let lastFit;
  for (const parentContext of parentContexts) {
    const prefix = parentContext.prefix
      ? `${parentContext.prefix}|${message.name}`
      : message.name;
    const layerMap = buildExternalLayerMap(
      activeScene.metadata.layers,
      loaded.scene.metadata.layers,
      prefix,
    );
    const composed = composeExternalInstanceGraph(
      parentContext.instanceGraph,
      message.parentBlockIndex,
      loaded.scene.instanceGraph,
      loaded.scene.metadata.batches,
      layerMap,
      buildExternalLinetypeMap(
        activeScene.metadata.linetypes,
        loaded.scene.metadata.linetypes,
      ),
    );
    if (composed.instanceGraph.instanceCount === 0) {
      continue;
    }
    const sceneId = `${message.parentCacheId}:${message.parentBlockIndex}:${message.cacheId}:${parentContext.id}`;
    if (childContexts.some((context) => context.id === sceneId)) {
      continue;
    }
    let mountedOverview = null;
    if (
      loaded.scene.overview.byteLength > 0 &&
      composed.batches.some((batch) => batch.lodLevel === 0)
    ) {
      const overviewBuffer = loaded.scene.overview.buffer.slice(0);
      const linetypeMap = buildExternalLinetypeMap(
        activeScene.metadata.linetypes,
        loaded.scene.metadata.linetypes,
      );
      remapLineVertexLayers(
        overviewBuffer,
        layerMap,
        loaded.scene.overview.recordSize,
      );
      remapLineVertexLinetypes(
        overviewBuffer,
        linetypeMap,
        loaded.scene.overview.recordSize,
      );
      lastFit = activeScene.renderer.addExternalOverview({
        id: sceneId,
        batches: composed.batches,
        instanceGraph: composed.instanceGraph,
        vertices: {
          buffer: overviewBuffer,
          byteLength: overviewBuffer.byteLength,
          vertexCount:
            overviewBuffer.byteLength / loaded.scene.overview.recordSize,
        },
      });
      const detailReader = {
        async readBatchVertices(batch) {
          const vertices =
            await loaded.scene.reader.readBatchVertices(batch);
          remapLineVertexLayers(
            vertices.buffer,
            layerMap,
            vertices.recordSize,
          );
          remapLineVertexLinetypes(
            vertices.buffer,
            linetypeMap,
            vertices.recordSize,
          );
          return vertices;
        },
      };
      activeInteraction.addExternalDetailSource(
        sceneId,
        detailReader,
        composed.batches,
        composed.instanceGraph,
      );
      mountedOverview = Object.freeze({
        batches: composed.batches,
        vertices: Object.freeze({
          buffer: overviewBuffer,
          byteLength: overviewBuffer.byteLength,
          vertexCount:
            overviewBuffer.byteLength / loaded.scene.overview.recordSize,
          recordSize: loaded.scene.overview.recordSize,
        }),
      });
      activeReviewTools?.addSource(sceneId, {
        id: sceneId,
        label: prefix,
        batches: mountedOverview.batches,
        vertices: mountedOverview.vertices,
        instanceGraph: composed.instanceGraph,
        layers: activeScene.metadata.layers,
        reader: loaded.scene.reader,
      });
    }
    await addExternalText(
      loaded.scene,
      composed.instanceGraph,
      layerMap,
      mountedOverview,
    );
    const imageFit = await addExternalImages(
      loaded.scene,
      message.cacheId,
      sceneId,
      composed.instanceGraph,
      layerMap,
    );
    lastFit = imageFit ?? lastFit;
    childContexts.push({
      id: sceneId,
      prefix,
      instanceGraph: composed.instanceGraph,
      overview: mountedOverview,
    });
  }
  externalAttachmentsByCache.set(message.cacheId, childContexts);
  if (lastFit) {
    activeInteraction.updateFit(lastFit.camera);
  } else {
    activeInteraction.refresh();
  }
  const key = `${message.parentCacheId}:${message.parentBlockIndex}`;
  const existing = xrefDiagnostics.get(key);
  if (existing) {
    xrefDiagnostics.set(key, {
      ...existing,
      status: "ready",
      canSelect: false,
      fileName:
        typeof message.fileName === "string"
          ? message.fileName.slice(0, 300)
          : existing.fileName,
      message:
        message.resolution === "relative"
          ? "도면 기준 상대경로에서 연결했습니다."
          : message.resolution === "search"
            ? "파일명과 상위 폴더 일치 순으로 자동 연결했습니다."
            : message.resolution?.startsWith("manual")
              ? "저장된 수동 연결을 적용했습니다."
              : "저장된 경로에서 연결했습니다.",
    });
  }
  renderXrefDiagnostics();
  if (!message.overlay) {
    discoverExternalReferences(
      loaded.scene,
      message.cacheId,
      Number.isSafeInteger(message.depth) ? message.depth : 1,
    );
  }
  if (activeRangeMetricsSource) {
    renderMetrics(
      activeScene,
      activeRangeMetricsSource,
      activeInteraction.snapshot(),
    );
  }
  status.textContent = `참조도면 ${message.name} 연결 완료`;
}

async function remountExternalReferences(revision, switchRevision) {
  externalAttachmentsByCache.clear();
  const messages = [...readyExternalMessages.values()].sort(
    (left, right) => (left.depth ?? 0) - (right.depth ?? 0),
  );
  for (const message of messages) {
    if (
      revision !== openRevision ||
      switchRevision !== viewSwitchRevision ||
      !activeScene ||
      !activeInteraction
    ) {
      return;
    }
    try {
      await handleExternalCacheReady(message);
    } catch (error) {
      console.error(error);
    }
  }
}

function installInteraction(
  scene,
  instanceGraph,
  render,
  source,
  revision,
) {
  activeReviewTools?.dispose();
  activeReviewTools = undefined;
  const interactionScene = Object.freeze({
    ...scene,
    instanceGraph,
    render,
  });
  activeInteraction = new ViewportInteraction(interactionScene, canvas, {
    onUpdate(viewport) {
      renderMetrics(scene, source, viewport);
      if (viewport.render.interactive) {
        invalidatePendingHatchPatterns();
      } else {
        scheduleHatchPatterns(
          scene,
          viewport.render.camera,
          revision,
        );
      }
      status.textContent = viewport.render.interactive
        ? `${viewport.zoom.toFixed(2)}× · 빠른 이동 화면`
        : viewport.detail.loading > 0
          ? `상세 청크 ${viewport.detail.loading.toLocaleString()}개 읽는 중`
          : `${viewport.zoom.toFixed(2)}× · 화면 상세 ${viewport.detail.selectedBatches.toLocaleString()}개`;
      if (scene.metrics.preview) {
        status.textContent += " · 빠른 미리보기";
      }
      status.textContent += missingFontSuffix();
      activeReviewTools?.setCamera(viewport.render.camera);
    },
    onError(error) {
      status.textContent = `상세 표시 실패: ${error.message}`;
      console.error(error);
    },
    onReviewBatch(sourceId, batch, vertices, candidate) {
      return (
        activeReviewTools?.addDetailBatch(
          sourceId,
          batch,
          vertices,
          candidate,
        ) ?? false
      );
    },
    onReviewBatchEvicted(sourceId, batchId) {
      activeReviewTools?.removeDetailBatch(sourceId, batchId);
    },
    onReviewSelection(sourceId, candidates) {
      activeReviewTools?.setDetailSelection(sourceId, candidates);
    },
  });
  activeReviewTools = new ReviewTools({
    canvas,
    overlay: reviewCanvas,
    toolbar: reviewToolbar,
    result: reviewResult,
    scene,
    instanceGraph,
    getCamera: () =>
      activeInteraction?.snapshot().render.camera ?? render.camera,
    getLayerVisibility: () => scene.renderer.getLayerVisibility(),
    onFit: () => activeInteraction?.reset(),
    onReviewModeChange: (enabled) =>
      activeInteraction?.setReviewEnabled(enabled),
    onStatus(message) {
      status.textContent = message;
    },
  });
  activeReviewTools.setCamera(render.camera);
  return interactionScene;
}

function updateLayoutTabSelection() {
  for (const button of layoutTabs.querySelectorAll("button[data-view-id]")) {
    button.setAttribute(
      "aria-selected",
      String(button.dataset.viewId === activeViewId),
    );
  }
}

async function activateView(scene, view, source, revision) {
  if (
    revision !== openRevision ||
    activeScene !== scene ||
    view.id === activeViewId
  ) {
    return;
  }
  const switchRevision = ++viewSwitchRevision;
  for (const button of layoutTabs.querySelectorAll("button")) {
    button.disabled = true;
  }
  status.textContent = `${view.label} 화면 구성 중`;
  activeReviewTools?.dispose();
  activeReviewTools = undefined;
  activeInteraction?.dispose();
  activeInteraction = undefined;
  try {
    const instanceGraph = scene.buildViewInstanceGraph(
      view,
      activeMaskOrder?.enabled
        ? { maskOrder: activeMaskOrder }
        : {},
    );
    const imageBounds = scene.imageEntities
      ? calculateRasterImageBounds({
          imageEntities: scene.imageEntities,
          blocks: scene.metadata.blocks,
          instanceGraph,
        })
      : null;
    if (
      revision !== openRevision ||
      switchRevision !== viewSwitchRevision ||
      activeScene !== scene
    ) {
      return;
    }
    const render = scene.renderer.setInstanceGraph(instanceGraph, {
      preferredBounds: view.preferredBounds,
      preferredView: view.preferredView,
      supplementalBounds: imageBounds,
      clearExternal: true,
    });
    activeRenderInstanceGraph = instanceGraph;
    activeViewId = view.id;
    updateLayoutTabSelection();
    activeTextStatus = undefined;
    activeTextComposite = new CompositeTextOverlay(textCanvas);
    scene.renderer.setTextOverlay(activeTextComposite);
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    scene.renderer.setImageOverlay(activeImageComposite);
    installInteraction(scene, instanceGraph, render, source, revision);
    configurePlotStyleForView(scene, view, revision);
    lastPatternCameraKey = undefined;
    patternRequestRevision += 1;
    if (activeHatchStatus?.state === "ready") {
      activeHatchStatus = Object.freeze({
        ...activeHatchStatus,
        patternMetrics: null,
      });
    }
    activeInteraction.refresh();
    activeInteraction.scheduleDetail(0);
    initializeTextOverlay(
      scene,
      revision,
      activeMaskOrder,
      instanceGraph,
    ).catch((error) => {
      if (revision === openRevision && activeScene === scene) {
        status.textContent = `문자 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
    initializeImageOverlay(
      scene,
      revision,
      activeHostCacheId ?? `local-${revision}`,
      instanceGraph,
    ).catch((error) => {
      if (revision === openRevision && activeScene === scene) {
        status.textContent = `이미지 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
    remountExternalReferences(revision, switchRevision).catch(
      console.error,
    );
    status.textContent = `${view.label} 표시 완료`;
  } catch (error) {
    if (
      revision === openRevision &&
      switchRevision === viewSwitchRevision
    ) {
      status.textContent = `${view.label} 표시 실패: ${error.message}`;
      console.error(error);
    }
  } finally {
    if (
      revision === openRevision &&
      switchRevision === viewSwitchRevision
    ) {
      for (const button of layoutTabs.querySelectorAll("button")) {
        button.disabled = false;
      }
    }
  }
}

function populateLayoutTabs(scene, source, revision) {
  layoutTabs.replaceChildren();
  activeViewId = scene.activeView.id;
  if (scene.views.length <= 1) {
    layoutTabs.hidden = true;
    dropZone.classList.remove("has-layout-tabs");
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const view of scene.views) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.viewId = view.id;
    button.setAttribute("role", "tab");
    button.textContent = view.label;
    button.title =
      view.kind === "model"
        ? "모델 공간"
        : `배치 탭 · 뷰포트 ${view.layout.viewports.length.toLocaleString()}개`;
    button.addEventListener("click", () => {
      activateView(scene, view, source, revision);
    });
    fragment.append(button);
  }
  layoutTabs.append(fragment);
  layoutTabs.hidden = false;
  dropZone.classList.add("has-layout-tabs");
  updateLayoutTabSelection();
}

async function openCache(source, workerSource) {
  const revision = ++openRevision;
  viewSwitchRevision += 1;
  activeViewId = undefined;
  layoutTabs.replaceChildren();
  layoutTabs.hidden = true;
  dropZone.classList.remove("has-layout-tabs");
  status.textContent = "준비 중";
  metrics.innerHTML = "";
  activeRangeMetricsSource = source;
  setControlsEnabled(false);
  resetLayerPanel();
  resetExternalReferences();
  const imageStore = new RasterImageAssetStore({
    onChange(event) {
      if (
        revision === openRevision &&
        activeImageAssetStore === imageStore
      ) {
        let diagnosticsChanged = false;
        for (const [key, entry] of xrefDiagnostics) {
          if (
            entry.kind !== "image" ||
            entry.resourceId !== event.resourceId
          ) {
            continue;
          }
          xrefDiagnostics.set(key, {
            ...entry,
            status: event.type === "error" ? "error" : "ready",
            canSelect: event.type === "error",
            ...(event.type === "error"
              ? {
                  message:
                    event.error instanceof Error
                      ? event.error.message.slice(0, 240)
                      : "이미지를 화면용으로 해석하지 못했습니다.",
                }
              : {}),
          });
          diagnosticsChanged = true;
        }
        if (diagnosticsChanged) {
          renderXrefDiagnostics();
        }
        activeInteraction?.refresh();
      }
    },
  });
  activeImageAssetStore = imageStore;
  resetPlotStyleSession();
  activeTextStatus = undefined;
  activeTextStyles = Object.freeze([]);
  clearHostFonts();
  fontDiagnostics.clear();
  pendingHostFontRequests.clear();
  attemptedHostFontKeys.clear();
  fontsToggle.disabled = true;
  fontsToggle.textContent = "글꼴";
  fontsToggle.setAttribute("aria-expanded", "false");
  fontPanel.hidden = true;
  renderFontDiagnostics();
  activeHatchStatus = undefined;
  activePrimitiveStatus = undefined;
  activeMaskOrder = undefined;
  activeRenderInstanceGraph = undefined;
  activeMaskStatus = undefined;
  activeWipeoutMasksVisible = false;
  updateWipeoutToggle();
  activeMemoryTelemetry = new WebviewMemoryTelemetry();
  lastPatternCameraKey = undefined;
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
  if (fontRefreshTimer !== undefined) {
    clearTimeout(fontRefreshTimer);
    fontRefreshTimer = undefined;
  }
  activeHatchWorker?.cancel();
  activeHatchWorker = undefined;
  activePrimitiveWorker?.cancel();
  activePrimitiveWorker = undefined;
  activeInteraction?.dispose();
  activeInteraction = undefined;
  activeReviewTools?.dispose();
  activeReviewTools = undefined;
  activeScene?.renderer.dispose();
  activeScene = undefined;
  activeHostRangeSource?.dispose();
  activeHostRangeSource =
    workerSource.kind === "host" ? workerSource.source : undefined;
  const renderer = new WebGlLineRenderer(canvas);
  renderer.setWipeoutMasksVisible(activeWipeoutMasksVisible);
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
    activeTextComposite = new CompositeTextOverlay(textCanvas);
    scene.renderer.setTextOverlay(activeTextComposite);
    activeImageComposite = new CompositeRasterImageOverlay(imageCanvas);
    scene.renderer.setImageOverlay(activeImageComposite);
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
    installInteraction(
      scene,
      activeRenderInstanceGraph,
      {
        ...scene.render,
        ...scene.renderer.redraw(scene.render.camera),
      },
      source,
      revision,
    );
    populateLayoutTabs(scene, source, revision);
    configurePlotStyleForView(scene, scene.activeView, revision);
    setControlsEnabled(true);
    discoverExternalReferences(
      activeScene,
      activeHostCacheId,
      0,
    );
    initializeDeferredGeometry(
      workerSource,
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
    initializeImageOverlay(
      activeScene,
      revision,
      activeHostCacheId ?? `local-${revision}`,
      activeRenderInstanceGraph,
    ).catch((error) => {
      if (revision === openRevision) {
        status.textContent = `이미지 표시 실패: ${error.message}`;
      }
      console.error(error);
    });
  } catch (error) {
    renderer.dispose();
    if (revision !== openRevision) {
      return;
    }
    activeInteraction = undefined;
    activeReviewTools?.dispose();
    activeReviewTools = undefined;
    activeScene = undefined;
    if (
      workerSource.kind === "host" &&
      activeHostRangeSource === workerSource.source
    ) {
      activeHostRangeSource.dispose();
      activeHostRangeSource = undefined;
    }
    dropZone.classList.remove("loaded");
    status.textContent = `열기 실패: ${error.message}`;
    throw error;
  }
}

function openFile(file) {
  activeHostCacheId = undefined;
  glyphCache.configureLegacyEncodings({});
  return openCache(
    new TrackedRangeSource(new BlobRangeSource(file)),
    { kind: "blob", file },
  );
}

function openHostedCache(message) {
  glyphCache.configureLegacyEncodings(message.bigFontEncodings);
  activeHostCacheId = message.cacheId;
  const source = createVsCodeRangeSource(vscodeApi, {
    cacheId: message.cacheId,
    size: message.size,
  });
  return openCache(
    new TrackedRangeSource(source),
    { kind: "host", source },
  );
}

function setViewerToolsOpen(open) {
  if (!pageHeader || !viewerToolsTrigger) {
    return;
  }
  pageHeader.classList.toggle("tools-open", open);
  viewerToolsTrigger.setAttribute("aria-expanded", String(open));
  viewerToolsTrigger.setAttribute(
    "aria-label",
    open ? "도면 도구 접기" : "도면 도구 펼치기",
  );
}

function setHostedState(state, detail = "", code = "") {
  if (!vscodeApi) {
    return;
  }
  switch (state) {
    case "preparing":
      setViewerToolsOpen(false);
      status.textContent = "로컬 DWG 변환을 준비하는 중";
      hostRetry.hidden = true;
      hostRebuild.hidden = true;
      hostAdapterSetup.hidden = true;
      break;
    case "converting":
      status.textContent = "로컬에서 DWG를 변환하는 중";
      hostRetry.hidden = true;
      hostRebuild.hidden = true;
      hostAdapterSetup.hidden = true;
      break;
    case "validating":
      status.textContent = "변환 결과를 검사하는 중";
      hostRetry.hidden = true;
      hostRebuild.hidden = true;
      hostAdapterSetup.hidden = true;
      break;
    case "error":
      setViewerToolsOpen(true);
      status.textContent = detail
        ? `도면을 열 수 없습니다: ${detail.slice(0, 300)}`
        : "도면을 열 수 없습니다";
      hostRetry.hidden = false;
      hostRebuild.hidden = false;
      hostAdapterSetup.hidden =
        typeof code !== "string" || !code.startsWith("ADAPTER_");
      break;
    case "ready":
      hostRetry.hidden = true;
      hostRebuild.hidden = false;
      hostAdapterSetup.hidden = true;
      break;
  }
}

if (vscodeApi) {
  cachePicker.hidden = true;
  fontFileButton.hidden = true;
  viewerToolsTrigger.hidden = false;
  hostFontFolder.hidden = false;
  fontPanelHelp.textContent =
    "도면 폴더와 등록한 폴더에서 필요한 글꼴만 찾아 첫 화면 뒤에 연결합니다.";
  document.querySelector("h1").textContent = "DWG 도면 뷰어";
  document.querySelector(".empty-state strong").textContent =
    "로컬 DWG 도면을 준비하고 있습니다.";
  document.querySelector(".empty-state span").textContent =
    "도면은 외부로 전송되지 않습니다.";
  setHostedState("preparing");
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.type === "dwg-font-read-response/1") {
      void handleHostFontResponse(message);
      return;
    }
    if (message?.type === "dwg-plot-style-read-response/1") {
      handleHostPlotStyleResponse(message);
      return;
    }
    if (message?.type === "dwg-font-configuration-changed/1") {
      handleFontConfigurationChanged(message);
      return;
    }
    if (message?.type === "dwg-font-folder-select-result/1") {
      hostFontFolder.disabled = false;
      if (message.failed) {
        fontPanelHelp.textContent =
          "글꼴 폴더 설정을 저장하지 못했습니다. VS Code 설정을 확인하세요.";
      } else if (!message.changed) {
        fontPanelHelp.textContent =
          "글꼴 폴더 선택이 취소되었습니다. 기존 설정은 유지됩니다.";
      }
      return;
    }
    if (message?.type === "dwg-adapter-select-result/1") {
      hostAdapterSetup.disabled = false;
      return;
    }
    if (message?.type === "dwg-image-status/1") {
      handleImageStatus(message);
      return;
    }
    if (message?.type === "dwg-image-read-response/1") {
      handleImageResponse(message);
      return;
    }
    if (message?.type === "dwg-xref-status/1") {
      handleXrefStatus(message);
      return;
    }
    if (message?.type === "dwg-xref-cache-ready/1") {
      enqueueExternalCacheReady(message);
      return;
    }
    if (message?.type === "dwg-cache-state/1") {
      setHostedState(message.state, message.message, message.code);
      return;
    }
    const isPreview = message?.type === "dwg-cache-preview-ready/1";
    if (!isPreview && message?.type !== "dwg-cache-ready/1") {
      return;
    }
    if (!isPreview) {
      setHostedState("ready");
    }
    openHostedCache(message)
      .then(() => {
        if (activeHostCacheId !== message.cacheId) {
          return;
        }
        if (isPreview) {
          status.textContent =
            "빠른 미리보기 표시 중 · 전체 도면을 계속 준비하고 있습니다";
        }
        vscodeApi.postMessage({
          type: "dwg-first-frame-ready/1",
          cacheId: message.cacheId,
          firstFrameMs: activeScene?.metrics.timings.firstFrameMs ?? null,
        });
      })
      .catch((error) => {
        if (activeHostCacheId !== message.cacheId) {
          return;
        }
        setHostedState("error", error.message);
        vscodeApi.postMessage({
          type: "dwg-viewer-error/1",
          code: "CACHE_RENDER_FAILED",
          cacheId: message.cacheId,
          error: error.message.slice(0, 500),
        });
      });
  });
  vscodeApi.postMessage({ type: "dwg-webview-ready/1" });
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

viewerToolsTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  setViewerToolsOpen(
    viewerToolsTrigger.getAttribute("aria-expanded") !== "true",
  );
});

document.addEventListener("pointerdown", (event) => {
  if (
    pageHeader.classList.contains("tools-open") &&
    event.target instanceof Node &&
    !pageHeader.contains(event.target)
  ) {
    setViewerToolsOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setViewerToolsOpen(false);
  }
});

layersToggle.addEventListener("click", () => {
  const opening = layerPanel.hidden;
  layerPanel.hidden = !opening;
  layersToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    fontPanel.hidden = true;
    fontsToggle.setAttribute("aria-expanded", "false");
    xrefPanel.hidden = true;
    xrefsToggle.setAttribute("aria-expanded", "false");
    layerSearch.focus();
  }
});

fontsToggle.addEventListener("click", () => {
  const opening = fontPanel.hidden;
  fontPanel.hidden = !opening;
  fontsToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    layerPanel.hidden = true;
    layersToggle.setAttribute("aria-expanded", "false");
    xrefPanel.hidden = true;
    xrefsToggle.setAttribute("aria-expanded", "false");
  }
});

xrefsToggle.addEventListener("click", () => {
  const opening = xrefPanel.hidden;
  xrefPanel.hidden = !opening;
  xrefsToggle.setAttribute("aria-expanded", String(opening));
  if (opening) {
    layerPanel.hidden = true;
    layersToggle.setAttribute("aria-expanded", "false");
    fontPanel.hidden = true;
    fontsToggle.setAttribute("aria-expanded", "false");
  }
});

wipeoutToggle.addEventListener("click", () => {
  if (!activeScene || !activeMaskStatus?.enabled) {
    return;
  }
  activeWipeoutMasksVisible = !activeWipeoutMasksVisible;
  activeScene.renderer.setWipeoutMasksVisible(
    activeWipeoutMasksVisible,
  );
  updateWipeoutToggle();
  const viewport = activeInteraction?.refresh();
  if (activeRangeMetricsSource) {
    renderMetrics(activeScene, activeRangeMetricsSource, viewport);
  }
  status.textContent = activeWipeoutMasksVisible
    ? "도면의 가림 객체를 다시 표시했습니다"
    : "가림 객체를 숨겼습니다 · 가려졌던 원본 선을 확인할 수 있습니다";
});

plotStyleToggle.addEventListener("click", () => {
  if (!activeScene || !activePlotStyleName) {
    return;
  }
  const entry = plotStyleTables.get(activePlotStyleName);
  if (entry?.status !== "loaded") {
    return;
  }
  applyPlotStyleEntry(
    activeScene,
    activePlotStyleName,
    entry,
    !activePlotStyleEnabled,
  );
  status.textContent = activePlotStyleEnabled
    ? `${entry.resolvedName || entry.requestedName} 출력 스타일을 적용했습니다`
    : "출력 스타일을 끄고 도면의 화면 색으로 표시합니다";
});

hostFontFolder.addEventListener("click", () => {
  if (!vscodeApi) {
    return;
  }
  hostFontFolder.disabled = true;
  fontPanelHelp.textContent = "추가할 SHX·BigFont 폴더를 선택하세요.";
  vscodeApi.postMessage({ type: "dwg-font-folder-select/1" });
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

hostRetry.addEventListener("click", () => {
  if (vscodeApi) {
    setHostedState("preparing");
    vscodeApi.postMessage({ type: "dwg-cache-retry/1" });
  }
});

hostRebuild.addEventListener("click", () => {
  if (vscodeApi) {
    setHostedState("preparing");
    vscodeApi.postMessage({ type: "dwg-cache-rebuild/1" });
  }
});

hostAdapterSetup.addEventListener("click", () => {
  if (vscodeApi) {
    hostAdapterSetup.disabled = true;
    vscodeApi.postMessage({ type: "dwg-adapter-select/1" });
  }
});

window.addEventListener("beforeunload", () => {
  openRevision += 1;
  patternRequestRevision += 1;
  if (hatchPatternTimer !== undefined) {
    clearTimeout(hatchPatternTimer);
    hatchPatternTimer = undefined;
  }
  if (fontRefreshTimer !== undefined) {
    clearTimeout(fontRefreshTimer);
    fontRefreshTimer = undefined;
  }
  pendingHostFontRequests.clear();
  clearHostFonts();
  activeHatchWorker?.cancel();
  activeHatchWorker = undefined;
  activePrimitiveWorker?.cancel();
  activePrimitiveWorker = undefined;
  activeInteraction?.dispose();
  activeScene?.renderer.dispose();
  resetExternalReferences();
  activeInteraction = undefined;
  activeScene = undefined;
  activeHostRangeSource?.dispose();
  activeHostRangeSource = undefined;
  activeRangeMetricsSource = undefined;
  activeMemoryTelemetry = undefined;
  glyphCache.dispose();
  resetLayerPanel();
});
