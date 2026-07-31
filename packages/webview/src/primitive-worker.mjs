import { buildInstanceGraph } from "./instance-graph.mjs";
import { buildPrimitiveMeshes } from "./primitive-mesh.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

self.addEventListener(
  "message",
  async (event) => {
    const { requestId, type, file } = event.data;
    try {
      if (type !== "initialize") {
        throw new Error("unsupported primitive worker request");
      }
      const rangeSource = new TrackedRangeSource(new BlobRangeSource(file));
      const reader = await SceneCacheReader.open(rangeSource);
      if (reader.header.minor < 8) {
        throw new Error("deferred primitive display requires Scene Cache v1.8");
      }
      const [source, blocks, inserts] = await Promise.all([
        reader.readPrimitiveSource(),
        reader.readBlocks(),
        reader.readInserts(),
      ]);
      const instanceGraph = buildInstanceGraph(blocks, inserts);
      const primitives = buildPrimitiveMeshes(
        source,
        blocks,
        instanceGraph,
      );
      self.postMessage(
        {
          requestId,
          ok: true,
          primitives,
          reads: rangeSource.snapshot(),
        },
        [
          primitives.points.vertices.buffer,
          primitives.solidFills.vertices.buffer,
          primitives.solidOutlines.vertices.buffer,
        ],
      );
    } catch (error) {
      self.postMessage({
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      self.close();
    }
  },
  { once: true },
);
