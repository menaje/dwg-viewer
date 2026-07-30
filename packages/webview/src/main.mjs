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
      <div><dt>상세 청크</dt><dd>${detail.cache.entries.toLocaleString()} / ${detail.selectedBatches.toLocaleString()}</dd></div>
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
}

async function openFile(file) {
  const revision = ++openRevision;
  status.textContent = "준비 중";
  metrics.innerHTML = "";
  setControlsEnabled(false);
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
    renderMetrics(activeScene, source);
    activeInteraction = new ViewportInteraction(activeScene, canvas, {
      onUpdate(viewport) {
        renderMetrics(activeScene, source, viewport);
        status.textContent =
          viewport.detail.loading > 0
            ? `상세 청크 ${viewport.detail.loading.toLocaleString()}개 읽는 중`
            : `${viewport.zoom.toFixed(2)}× · 상세 ${viewport.detail.cache.entries.toLocaleString()}개`;
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

window.addEventListener("beforeunload", () => {
  openRevision += 1;
  activeInteraction?.dispose();
  activeScene?.renderer.dispose();
  activeInteraction = undefined;
  activeScene = undefined;
});
