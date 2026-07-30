import { ViewportInteraction } from "./interaction.mjs";
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
let openRevision = 0;
const glyphCache = new ShxGlyphCache();

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
      <div><dt>Glyph 캐시</dt><dd>${formatBytes(glyphCache.stats.glyphBytes)}</dd></div>
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
      ${detailRows}
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

async function initializeTextOverlay(scene, revision) {
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
    instanceGraph: scene.instanceGraph,
    glyphCache,
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
    activeInteraction = new ViewportInteraction(activeScene, canvas, {
      onUpdate(viewport) {
        renderMetrics(activeScene, source, viewport);
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
    initializeTextOverlay(activeScene, revision).catch((error) => {
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
  activeInteraction?.dispose();
  activeScene?.renderer.dispose();
  activeInteraction = undefined;
  activeScene = undefined;
  glyphCache.dispose();
  resetLayerPanel();
});
