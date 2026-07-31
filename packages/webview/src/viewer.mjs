import { buildInstanceGraph } from "./instance-graph.mjs";
import { readJsHeapSnapshot } from "./memory-telemetry.mjs";
import { WebGlLineRenderer } from "./renderer.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export async function loadFirstFrame(
  source,
  canvas,
  { onProgress = () => {}, renderer = new WebGlLineRenderer(canvas) } = {},
) {
  const started = now();
  onProgress("헤더와 섹션 목록 읽는 중");
  const reader = await SceneCacheReader.open(source);
  const openedAt = now();

  onProgress("레이어·블록·배치 정보 읽는 중");
  const metadata = await reader.readRenderMetadata();
  const metadataAt = now();

  onProgress("블록 인스턴스 구성 중");
  const instanceGraph = buildInstanceGraph(metadata.blocks, metadata.inserts);
  const instancesAt = now();

  onProgress("첫 화면 4MiB 이하 버퍼 읽는 중");
  const overview = await reader.readOverviewVertices();
  const overviewAt = now();

  onProgress("GPU 첫 화면 그리는 중");
  const render = renderer.renderOverview({
    batches: metadata.batches,
    layers: metadata.layers,
    blocks: metadata.blocks,
    instanceGraph,
    vertices: overview,
  });
  const renderedAt = now();

  const metrics = Object.freeze({
    cacheVersion: `${reader.header.major}.${reader.header.minor}`,
    cacheBytes: reader.header.fileSize,
    sourceBytes: reader.header.sourceSize,
    overviewBytes: overview.byteLength,
    blocks: metadata.blocks.length,
    inserts: metadata.inserts.length,
    instances: instanceGraph.instanceCount,
    batches: metadata.batches.length,
    timings: Object.freeze({
      openMs: openedAt - started,
      metadataMs: metadataAt - openedAt,
      instancesMs: instancesAt - metadataAt,
      overviewReadMs: overviewAt - instancesAt,
      renderMs: renderedAt - overviewAt,
      firstFrameMs: renderedAt - started,
    }),
    renderer: render,
    instanceDiagnostics: instanceGraph.diagnostics,
    memory: readJsHeapSnapshot(),
  });
  onProgress("첫 화면 완료");

  return Object.freeze({
    reader,
    metadata,
    instanceGraph,
    overview,
    renderer,
    render,
    metrics,
  });
}
