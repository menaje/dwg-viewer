import {
  AllRenderCapabilities,
  AllViewerLayerKinds,
  AllViewerRepresentations,
  RenderCapability,
  SupportedRenderProtocolVersions,
} from "./constants.mjs";
import {
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
} from "./diagnostics.mjs";
import {
  boolean,
  boundedString,
  enumValue,
  exactKeys,
  nullableTimestamp,
  opaqueIdentifier,
  plainRecord,
  positiveSafeInteger,
  safeInteger,
  semanticVersion,
  scopeMismatch,
  staleRevision,
  uniqueEnumArray,
} from "./validation.mjs";

function supportedProtocolVersion(value) {
  semanticVersion(value);
  if (!SupportedRenderProtocolVersions.includes(value)) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
      `render protocol ${value} is not supported by this package`,
      {
        supportedVersions: SupportedRenderProtocolVersions,
      },
    );
  }
  return value;
}

function nullableRevision(value, label) {
  return value === null ? null : opaqueIdentifier(value, label);
}

function ensureBinding(actual, expected, label) {
  if (expected !== undefined && actual !== expected) {
    scopeMismatch(`${label} does not match the open render session`, {
      expected,
      actual,
    });
  }
}

function ensureRevision(actual, expected, label) {
  if (expected !== undefined && expected !== null && actual !== expected) {
    staleRevision(`${label} does not match the expected revision`, {
      expected,
      actual,
    });
  }
}

export function parseRenderSessionDescriptor(value) {
  const input = plainRecord(value, "render session descriptor");
  exactKeys(
    input,
    [
      "protocolVersion",
      "sessionId",
      "sourceId",
      "currentRevisionId",
      "lastSuccessfulRevisionId",
      "capabilities",
      "resourceBudgetBytes",
    ],
    "render session descriptor",
  );
  const capabilities = uniqueEnumArray(
    input.capabilities,
    AllRenderCapabilities,
    "render session capabilities",
    { minimumLength: 2 },
  );
  for (const required of [
    RenderCapability.LAYER_MANIFEST,
    RenderCapability.RENDER_SNAPSHOT,
  ]) {
    if (!capabilities.includes(required)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
        `render session must provide ${required}`,
        { capability: required },
      );
    }
  }
  return Object.freeze({
    protocolVersion: supportedProtocolVersion(input.protocolVersion),
    sessionId: opaqueIdentifier(input.sessionId, "session ID"),
    sourceId: opaqueIdentifier(input.sourceId, "source ID"),
    currentRevisionId: opaqueIdentifier(
      input.currentRevisionId,
      "current revision ID",
    ),
    lastSuccessfulRevisionId: nullableRevision(
      input.lastSuccessfulRevisionId,
      "last successful revision ID",
    ),
    capabilities,
    resourceBudgetBytes: positiveSafeInteger(
      input.resourceBudgetBytes,
      "session resource budget",
    ),
  });
}

export function parseRangeHandleDescriptor(
  value,
  { session, layer } = {},
) {
  const input = plainRecord(value, "range handle");
  exactKeys(
    input,
    [
      "protocolVersion",
      "handleId",
      "sessionId",
      "sourceId",
      "revisionId",
      "layerId",
      "mediaType",
      "byteLength",
      "maximumRequestBytes",
      "remainingReadBytes",
      "sha256",
      "expiresAt",
      "disposeWithSession",
    ],
    "range handle",
  );
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const protocolVersion = supportedProtocolVersion(input.protocolVersion);
  const sessionId = opaqueIdentifier(input.sessionId, "range session ID");
  const sourceId = opaqueIdentifier(input.sourceId, "range source ID");
  const revisionId = opaqueIdentifier(
    input.revisionId,
    "range revision ID",
  );
  const layerId = opaqueIdentifier(input.layerId, "range layer ID");
  const maximumRequestBytes = positiveSafeInteger(
    input.maximumRequestBytes,
    "maximum range request bytes",
  );
  const remainingReadBytes = safeInteger(
    input.remainingReadBytes,
    "remaining range read bytes",
  );
  const expiresAt = nullableTimestamp(input.expiresAt, "range expiration");
  const disposeWithSession = boolean(
    input.disposeWithSession,
    "range session disposal flag",
  );
  if (expiresAt === null && !disposeWithSession) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a range handle must expire or be disposed with its session",
    );
  }
  if (
    parsedSession &&
    (maximumRequestBytes > parsedSession.resourceBudgetBytes ||
      remainingReadBytes > parsedSession.resourceBudgetBytes)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "range budget exceeds the open session resource budget",
    );
  }
  if (
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "range digest must be a lowercase SHA-256 hex value",
    );
  }
  if (parsedSession) {
    ensureBinding(
      protocolVersion,
      parsedSession.protocolVersion,
      "range protocol version",
    );
    ensureBinding(sessionId, parsedSession.sessionId, "range session ID");
  }
  ensureRevision(
    revisionId,
    layer?.revisionId ??
      parsedSession?.lastSuccessfulRevisionId ??
      parsedSession?.currentRevisionId,
    "range revision ID",
  );
  if (layer) {
    ensureBinding(sourceId, layer.sourceId, "range source ID");
    ensureBinding(layerId, layer.layerId, "range layer ID");
  }
  return Object.freeze({
    protocolVersion,
    handleId: opaqueIdentifier(input.handleId, "range handle ID"),
    sessionId,
    sourceId,
    revisionId,
    layerId,
    mediaType: boundedString(input.mediaType, "range media type", 128),
    byteLength: safeInteger(input.byteLength, "range byte length"),
    maximumRequestBytes,
    remainingReadBytes,
    sha256: input.sha256,
    expiresAt,
    disposeWithSession,
  });
}

function parseLayerDescriptor(value, { session, revisionId }) {
  const input = plainRecord(value, "render layer");
  exactKeys(
    input,
    [
      "layerId",
      "sourceId",
      "revisionId",
      "kind",
      "representation",
      "order",
      "visible",
      "rangeHandle",
    ],
    "render layer",
  );
  const layer = {
    layerId: opaqueIdentifier(input.layerId, "layer ID"),
    sourceId: opaqueIdentifier(input.sourceId, "layer source ID"),
    revisionId: opaqueIdentifier(input.revisionId, "layer revision ID"),
    kind: enumValue(input.kind, AllViewerLayerKinds, "layer kind"),
    representation: enumValue(
      input.representation,
      AllViewerRepresentations,
      "layer representation",
    ),
    order: safeInteger(input.order, "layer order"),
    visible: boolean(input.visible, "layer visibility"),
  };
  ensureRevision(layer.revisionId, revisionId, "layer revision ID");
  if (input.rangeHandle !== undefined) {
    layer.rangeHandle = parseRangeHandleDescriptor(input.rangeHandle, {
      session,
      layer,
    });
  }
  return Object.freeze(layer);
}

export function parseRenderSnapshotDescriptor(
  value,
  { session, expectedRevisionId } = {},
) {
  const input = plainRecord(value, "render snapshot");
  exactKeys(
    input,
    [
      "protocolVersion",
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "sequence",
      "layers",
    ],
    "render snapshot",
  );
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const protocolVersion = supportedProtocolVersion(input.protocolVersion);
  const sessionId = opaqueIdentifier(input.sessionId, "snapshot session ID");
  const sourceId = opaqueIdentifier(input.sourceId, "snapshot source ID");
  const revisionId = opaqueIdentifier(
    input.revisionId,
    "snapshot revision ID",
  );
  if (parsedSession) {
    ensureBinding(
      protocolVersion,
      parsedSession.protocolVersion,
      "snapshot protocol version",
    );
    ensureBinding(sessionId, parsedSession.sessionId, "snapshot session ID");
    ensureBinding(sourceId, parsedSession.sourceId, "snapshot source ID");
    ensureRevision(
      revisionId,
      expectedRevisionId ??
        parsedSession.lastSuccessfulRevisionId ??
        parsedSession.currentRevisionId,
      "snapshot revision ID",
    );
  } else {
    ensureRevision(
      revisionId,
      expectedRevisionId,
      "snapshot revision ID",
    );
  }
  if (!Array.isArray(input.layers) || input.layers.length > 256) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "snapshot layers must be an array with at most 256 entries",
    );
  }
  const layers = input.layers.map((layer) =>
    parseLayerDescriptor(layer, {
      session: parsedSession,
      revisionId,
    }),
  );
  const layerIds = new Set();
  for (const layer of layers) {
    if (layerIds.has(layer.layerId)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "snapshot layer IDs must be unique",
        { layerId: layer.layerId },
      );
    }
    layerIds.add(layer.layerId);
  }
  return Object.freeze({
    protocolVersion,
    sessionId,
    sourceId,
    revisionId,
    snapshotId: opaqueIdentifier(input.snapshotId, "snapshot ID"),
    sequence: safeInteger(input.sequence, "snapshot sequence"),
    layers: Object.freeze(layers),
  });
}
