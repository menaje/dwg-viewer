import { BlobRangeSource, TrackedRangeSource } from "./range-source.mjs";
import { loadFirstFrame } from "./viewer.mjs";

const fileInput = document.querySelector("#cache-file");
const dropZone = document.querySelector("#drop-zone");
const status = document.querySelector("#status");
const metrics = document.querySelector("#metrics");
const canvas = document.querySelector("#drawing");
let activeScene;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function renderMetrics(scene, rangeSource) {
  const value = scene.metrics;
  const reads = rangeSource.snapshot();
  metrics.innerHTML = `
    <dl>
      <div><dt>첫 화면</dt><dd>${value.timings.firstFrameMs.toFixed(1)} ms</dd></div>
      <div><dt>읽은 데이터</dt><dd>${formatBytes(reads.bytesRead)}</dd></div>
      <div><dt>가장 큰 읽기</dt><dd>${formatBytes(reads.maximumRequestBytes)}</dd></div>
      <div><dt>첫 화면 버퍼</dt><dd>${formatBytes(value.overviewBytes)}</dd></div>
      <div><dt>블록 인스턴스</dt><dd>${value.instances.toLocaleString()}</dd></div>
      <div><dt>GPU 호출</dt><dd>${value.renderer.drawCalls.toLocaleString()}</dd></div>
      <div><dt>제출 정점</dt><dd>${value.renderer.submittedVertices.toLocaleString()}</dd></div>
      <div><dt>전체 캐시</dt><dd>${formatBytes(value.cacheBytes)}</dd></div>
    </dl>
  `;
}

async function openFile(file) {
  status.textContent = "준비 중";
  metrics.innerHTML = "";
  activeScene?.renderer.dispose();
  activeScene = undefined;
  const source = new TrackedRangeSource(new BlobRangeSource(file));
  try {
    activeScene = await loadFirstFrame(source, canvas, {
      onProgress(message) {
        status.textContent = message;
      },
    });
    dropZone.classList.add("loaded");
    renderMetrics(activeScene, source);
  } catch (error) {
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
