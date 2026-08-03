export const NativeDocumentAdapterProtocol =
  "dwg-native-document-adapter/0.1.0";
export const NativeDocumentAdapterVersion = "0.1.0";

export const NativeCapabilityStatus = Object.freeze({
  NATIVE: "native",
  MAPPED: "mapped",
  OPAQUE: "opaque",
  LOSSY: "lossy",
  BLOCKED: "blocked",
});

export const AllNativeCapabilityStatuses = Object.freeze(
  Object.values(NativeCapabilityStatus).sort(),
);

export const NativeAdapterOperation = Object.freeze({
  READ: "read",
  QUERY_ENTITY: "query-entity",
  QUERY_REGION: "query-region",
  CHANGE_TEXT: "change-text",
  CHANGE_LINE_POLYLINE: "change-line-polyline",
  CHANGE_LAYER_STYLE: "change-layer-style",
  CHANGE_INSERT_TRANSFORM: "change-insert-transform",
  CREATE_DELETE_BASIC_ENTITY: "create-delete-basic-entity",
  WRITE_DWG: "write-dwg",
  WRITE_DXF: "write-dxf",
  PRESERVE_UNSUPPORTED: "preserve-unsupported",
  REOPEN_VALIDATE: "reopen-validate",
});

export const AllNativeAdapterOperations = Object.freeze(
  Object.values(NativeAdapterOperation).sort(),
);

export const NativeChangeKind = Object.freeze({
  TEXT_REPLACE: "text.replace",
  LINE_MOVE: "line.move",
  POLYLINE_MOVE: "polyline.move",
  LAYER_STYLE_SET: "layer-style.set",
  INSERT_TRANSFORM_SET: "insert-transform.set",
  BASIC_ENTITY_CREATE: "basic-entity.create",
  BASIC_ENTITY_DELETE: "basic-entity.delete",
});

export const AllNativeChangeKinds = Object.freeze(
  Object.values(NativeChangeKind).sort(),
);

export const NativeBackendKind = Object.freeze({
  NATIVE_PROCESS: "native-process",
  WASM_WORKER: "wasm-worker",
  REFERENCE: "reference",
});

export const AllNativeBackendKinds = Object.freeze(
  Object.values(NativeBackendKind).sort(),
);

export const NativeAdapterErrorCode = Object.freeze({
  VERSION_INCOMPATIBLE: "DWG_NATIVE_VERSION_INCOMPATIBLE",
  MESSAGE_INVALID: "DWG_NATIVE_MESSAGE_INVALID",
  STALE_SOURCE: "DWG_NATIVE_STALE_SOURCE",
  STALE_ENTITY: "DWG_NATIVE_STALE_ENTITY",
  CAPABILITY_BLOCKED: "DWG_NATIVE_CAPABILITY_BLOCKED",
  OUTPUT_CONFLICT: "DWG_NATIVE_OUTPUT_CONFLICT",
  BUDGET_EXCEEDED: "DWG_NATIVE_BUDGET_EXCEEDED",
  OBSERVED_DIFF_MISMATCH: "DWG_NATIVE_OBSERVED_DIFF_MISMATCH",
  SOURCE_DISPOSED: "DWG_NATIVE_SOURCE_DISPOSED",
  BACKEND_FAILED: "DWG_NATIVE_BACKEND_FAILED",
});

export const NativeQueryLimits = Object.freeze({
  maximumPageSize: 256,
  maximumQueryPayloadBytes: 1024 * 1024,
  maximumProposalBytes: 1024 * 1024,
  maximumProposalOperations: 256,
  maximumNestedInstanceDepth: 32,
  maximumIndexEntries: 1_000_000,
  maximumIndexSourceBytes: 256 * 1024 * 1024,
  maximumIndexReadBytes: 512 * 1024,
});

export const NativeAdapterProgressPhase = Object.freeze({
  VALIDATING: "validating",
  QUERYING: "querying",
  WRITING: "writing",
  REOPENING: "reopening",
  COMPLETE: "complete",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const AllNativeAdapterProgressPhases = Object.freeze(
  Object.values(NativeAdapterProgressPhase).sort(),
);

export const ChangeCapabilityByKind = Object.freeze({
  [NativeChangeKind.TEXT_REPLACE]:
    NativeAdapterOperation.CHANGE_TEXT,
  [NativeChangeKind.LINE_MOVE]:
    NativeAdapterOperation.CHANGE_LINE_POLYLINE,
  [NativeChangeKind.POLYLINE_MOVE]:
    NativeAdapterOperation.CHANGE_LINE_POLYLINE,
  [NativeChangeKind.LAYER_STYLE_SET]:
    NativeAdapterOperation.CHANGE_LAYER_STYLE,
  [NativeChangeKind.INSERT_TRANSFORM_SET]:
    NativeAdapterOperation.CHANGE_INSERT_TRANSFORM,
  [NativeChangeKind.BASIC_ENTITY_CREATE]:
    NativeAdapterOperation.CREATE_DELETE_BASIC_ENTITY,
  [NativeChangeKind.BASIC_ENTITY_DELETE]:
    NativeAdapterOperation.CREATE_DELETE_BASIC_ENTITY,
});
