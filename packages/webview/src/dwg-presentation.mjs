import { createRenderLayerRangeSource } from "@menaje/viewer-core";

import { mountWebGlPresentation } from "./presentation.mjs";
import { loadFirstFrame } from "./viewer.mjs";

export async function mountDwgWebGlPresentation(
  context,
  {
    canvas,
    renderer,
    onProgress = () => {},
    projectSelection = null,
  } = {},
) {
  if (typeof onProgress !== "function") {
    throw new TypeError(
      "DWG WebGL progress callback must be a function",
    );
  }
  const rangeSource = createRenderLayerRangeSource(
    context?.sourceSession,
    context?.snapshot,
  );
  const presentation = await mountWebGlPresentation(context, {
    canvas,
    renderer,
    projectSelection,
    load: ({ renderer: activeRenderer }) =>
      loadFirstFrame(rangeSource, canvas, {
        renderer: activeRenderer,
        onProgress,
      }),
  });
  return Object.freeze({
    ...presentation,
    rangeSource,
  });
}
