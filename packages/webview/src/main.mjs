import { ViewportInteraction } from "./interaction.mjs";
import { BlobRangeSource, TrackedRangeSource } from "./range-source.mjs";
import { WebGlLineRenderer } from "./renderer.mjs";
import { loadFirstFrame } from "./viewer.mjs";

const fileInput = document.querySelector("#cache-file");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#status");
const metrics = document.querySelector("#metrics");
const canvas = document.querySelector("#drawing");
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
let openRevision = 0;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
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

async function openFile(file) {
  const revision = ++openRevision;
  status.textContent = "준비 중";
  metrics.innerHTML = "";
  setControlsEnabled(false);
  resetLayerPanel();
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
      },
      onError(error) {
        status.textContent = `상세 표시 실패: ${error.message}`;
        console.error(error);
      },
    });
    setControlsEnabled(true);
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
  const [file] = event.dataTransfer.files;
  if (file) {
    openFile(file).catch(console.error);
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
  resetLayerPanel();
});
