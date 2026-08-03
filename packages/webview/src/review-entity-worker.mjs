import {
  buildExternalFilledObjectReviewData,
  buildFilledObjectReviewData,
  filledObjectReviewTransferables,
} from "./filled-object-review.mjs";
import { buildInstanceGraph } from "./instance-graph.mjs";
import { buildLayoutInstanceGraph } from "./layout-scene.mjs";
import {
  BlobRangeSource,
  TrackedRangeSource,
} from "./range-source.mjs";
import {
  createWorkerHostRangeSource,
  WORKER_RANGE_RESPONSE,
} from "./host-range-source.mjs";
import { SceneCacheReader } from "./scene-cache.mjs";

self.addEventListener("message", async (event) => {
  const {
    requestId,
    type,
    file,
    hostSource,
    view = null,
    externalContext = null,
    limits = null,
  } = event.data;
  if (type === WORKER_RANGE_RESPONSE) {
    return;
  }
  let messageSource;
  try {
    if (type !== "initialize") {
      throw new Error("unsupported review entity worker request");
    }
    messageSource = hostSource
      ? createWorkerHostRangeSource(hostSource)
      : new BlobRangeSource(file);
    const rangeSource = new TrackedRangeSource(messageSource);
    const reader = await SceneCacheReader.open(rangeSource);
    const [
      hatches,
      solids,
      faces,
      layers,
      blocks,
      inserts,
      insertClips,
      layouts,
    ] = await Promise.all([
      reader.readHatchSource(),
      reader.readSolidEntities(),
      reader.readFaceEntities(),
      reader.readLayers(),
      reader.readBlocks(),
      reader.readInserts(),
      reader.readInsertClips(),
      reader.readLayouts(),
    ]);
    let instanceGraph;
    if (
      view?.kind === "layout" &&
      Number.isSafeInteger(view.layoutIndex)
    ) {
      const layout = layouts.find(
        (candidate) => candidate.index === view.layoutIndex,
      );
      if (!layout) {
        throw new Error(`review layout ${view.layoutIndex} was not found`);
      }
      instanceGraph = buildLayoutInstanceGraph(
        blocks,
        inserts,
        layers,
        layout,
        { insertClips },
      );
    } else {
      instanceGraph = buildInstanceGraph(blocks, inserts, {
        layers,
        insertClips,
      });
    }
    const source = { hatches, solids, faces };
    const options =
      limits && typeof limits === "object" ? limits : undefined;
    const review = externalContext
      ? buildExternalFilledObjectReviewData(
          source,
          blocks,
          instanceGraph,
          externalContext,
          options,
        )
      : buildFilledObjectReviewData(
          source,
          blocks,
          instanceGraph,
          options,
        );
    self.postMessage(
      {
        requestId,
        ok: true,
        review,
        reads: rangeSource.snapshot(),
      },
      filledObjectReviewTransferables(review),
    );
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    messageSource?.dispose?.();
    self.close();
  }
});
