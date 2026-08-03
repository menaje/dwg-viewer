export const RenderProtocolVersion = "0.1.0";
export const RenderProtocolId =
  `menaje-viewer-render-protocol/${RenderProtocolVersion}`;
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
  SOURCE_REVEAL: "source-reveal",
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
  SEMANTIC: "semantic",
});

export const AllViewerRepresentations = Object.freeze(
  Object.values(ViewerRepresentation).sort(),
);

export const RenderRevisionEventStatus = Object.freeze({
  AVAILABLE: "available",
  FAILED: "failed",
});

export const AllRenderRevisionEventStatuses = Object.freeze(
  Object.values(RenderRevisionEventStatus).sort(),
);

export const ViewerDiagnosticSeverity = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
});

export const AllViewerDiagnosticSeverities = Object.freeze(
  Object.values(ViewerDiagnosticSeverity).sort(),
);

export const RenderDeltaOperationKind = Object.freeze({
  TOMBSTONE: "tombstone",
  UPSERT: "upsert",
});

export const AllRenderDeltaOperationKinds = Object.freeze(
  Object.values(RenderDeltaOperationKind).sort(),
);

export const RenderDeltaAspect = Object.freeze({
  ENTITY: "entity",
  GEOMETRY: "geometry",
  TEXT: "text",
  TRANSFORM: "transform",
  STYLE: "style",
  IDENTITY: "identity",
  DEPENDENCY: "dependency",
});

export const AllRenderDeltaAspects = Object.freeze(
  Object.values(RenderDeltaAspect).sort(),
);
