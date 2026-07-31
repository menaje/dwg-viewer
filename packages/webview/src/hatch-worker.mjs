import { buildHatchFillMesh } from "./hatch-fill.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

self.addEventListener("message", async (event) => {
  try {
    const { file, blocks, modelBlockIndices } = event.data;
    const rangeSource = new TrackedRangeSource(new BlobRangeSource(file));
    const reader = await SceneCacheReader.open(rangeSource);
    if (reader.header.minor < 6) {
      throw new Error("HATCH fills require Scene Cache v1.6");
    }
    const source = await reader.readHatchSource();
    const result = buildHatchFillMesh(source, blocks, {
      modelBlockIndices: new Set(modelBlockIndices),
    });
    self.postMessage(
      {
        ok: true,
        batches: result.batches,
        vertices: result.vertices,
        metrics: result.metrics,
        reads: rangeSource.snapshot(),
      },
      [result.vertices.buffer],
    );
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

