export const RenderProtocolVersion = "0.1.0";
export const RenderProtocolId =
  `dwg-viewer-render-protocol/${RenderProtocolVersion}`;
export const SupportedRenderProtocolVersions = Object.freeze([
  RenderProtocolVersion,
]);

export const RenderCapability = Object.freeze({
  REVISION_EVENTS: "revision-events",
  LAYER_MANIFEST: "layer-manifest",
  RENDER_SNAPSHOT: "render-snapshot",
  RENDER_DELTA: "render-delta",
  RANGE_READ: "range-read",
  PICK_RESOLVE: "pick-resolve",
  CONTEXT_CREATE: "context-create",
  DIAGNOSTICS: "diagnostics",
  DIFF: "diff",
  SOURCE_REVEAL: "source-reveal",
  HUMAN_ACTION_INTENT: "human-action-intent",
});

export const AllRenderCapabilities = Object.freeze(
  Object.values(RenderCapability).sort(),
);

export const ViewerLayerKind = Object.freeze({
  BASE: "base",
  LIVE: "live",
  ADDED: "added",
  MODIFIED: "modified",
  REMOVED: "removed",
  DIAGNOSTIC: "diagnostic",
  SELECTION: "selection",
  ANNOTATION: "annotation",
});

export const AllViewerLayerKinds = Object.freeze(
  Object.values(ViewerLayerKind).sort(),
);

export const ViewerRepresentation = Object.freeze({
  TWO_DIMENSIONAL: "2d",
  THREE_DIMENSIONAL: "3d",
});

export const AllViewerRepresentations = Object.freeze(
  Object.values(ViewerRepresentation).sort(),
);
