import { buildHatchFillMesh } from "./hatch-fill.mjs";
import {
  buildHatchPatternBlockBounds,
  buildHatchPatternMesh,
} from "./hatch-pattern.mjs";
import { buildInstanceGraph } from "./instance-graph.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

let patternState = null;

self.addEventListener("message", async (event) => {
  const { requestId, type } = event.data;
  try {
    if (type === "render-pattern") {
      if (!patternState) {
        throw new Error("HATCH pattern worker is not initialized");
      }
      const pattern = buildHatchPatternMesh(
        patternState.source,
        patternState.blocks,
        patternState.instanceGraph,
        event.data.camera,
        { maskOrder: patternState.maskOrder },
      );
      self.postMessage(
        { requestId, ok: true, pattern },
        [pattern.vertices.buffer],
      );
      return;
    }
    if (type !== "initialize") {
      throw new Error("unsupported HATCH worker request");
    }

    const { file, camera, maskOrder = null } = event.data;
    const rangeSource = new TrackedRangeSource(new BlobRangeSource(file));
    const reader = await SceneCacheReader.open(rangeSource);
    if (reader.header.minor < 6) {
      throw new Error("HATCH fills require Scene Cache v1.6");
    }
    const [source, blocks, inserts, batches] = await Promise.all([
      reader.readHatchSource(),
      reader.readBlocks(),
      reader.readInserts(),
      reader.readGpuLineBatches(),
    ]);
    const baseInstanceGraph = buildInstanceGraph(blocks, inserts, {
      maskOrder,
    });
    const instanceGraph = Object.freeze({
      ...baseInstanceGraph,
      blockBoundsByIndex: buildHatchPatternBlockBounds(
        batches,
        blocks.length,
      ),
    });
    const fill = buildHatchFillMesh(source, blocks, instanceGraph, {
      maskOrder,
    });
    const pattern =
      reader.header.minor >= 7 && camera
        ? buildHatchPatternMesh(
            source,
            blocks,
            instanceGraph,
            camera,
            { maskOrder },
          )
        : null;
    patternState = { source, blocks, instanceGraph, maskOrder };
    const transfers = [fill.vertices.buffer];
    if (pattern) {
      transfers.push(pattern.vertices.buffer);
    }
    self.postMessage(
      {
        requestId,
        ok: true,
        fill,
        pattern,
        supportsPatterns: reader.header.minor >= 7,
        reads: rangeSource.snapshot(),
      },
      transfers,
    );
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
