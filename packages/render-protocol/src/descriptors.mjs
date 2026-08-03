import {
  AllRenderDeltaAspects,
  AllRenderDeltaOperationKinds,
  AllRenderCapabilities,
  AllRenderRevisionEventStatuses,
  AllViewerDiagnosticSeverities,
  AllViewerLayerKinds,
  AllViewerRepresentations,
  RenderCapability,
  RenderDeltaAspect,
  RenderDeltaOperationKind,
  RenderRevisionEventStatus,
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

function ensureSequence(actual, expected, label) {
  if (expected !== undefined && actual !== expected) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.OUT_OF_ORDER,
      `${label} is stale or out of order`,
      { expected, received: actual },
    );
  }
}

function finiteVector3(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      `${label} must contain three finite coordinates`,
    );
  }
  return Object.freeze([...value]);
}

function worldBounds(value, label) {
  const input = plainRecord(value, label);
  exactKeys(input, ["min", "max"], label);
  const minimum = finiteVector3(input.min, `${label} minimum`);
  const maximum = finiteVector3(input.max, `${label} maximum`);
  if (minimum.some((coordinate, axis) => coordinate > maximum[axis])) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      `${label} minimum exceeds its maximum`,
    );
  }
  return Object.freeze({
    min: minimum,
    max: maximum,
  });
}

function snapshotScope(
  input,
  label,
  { session, snapshot, expectedRevisionId } = {},
) {
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const parsedSnapshot = snapshot
    ? parseRenderSnapshotDescriptor(snapshot, {
        session: parsedSession ?? undefined,
      })
    : null;
  const protocolVersion = supportedProtocolVersion(input.protocolVersion);
  const sessionId = opaqueIdentifier(
    input.sessionId,
    `${label} session ID`,
  );
  const sourceId = opaqueIdentifier(
    input.sourceId,
    `${label} source ID`,
  );
  const revisionId = opaqueIdentifier(
    input.revisionId,
    `${label} revision ID`,
  );
  const snapshotId = opaqueIdentifier(
    input.snapshotId,
    `${label} snapshot ID`,
  );
  const layerId = opaqueIdentifier(
    input.layerId,
    `${label} layer ID`,
  );
  if (parsedSession) {
    ensureBinding(
      protocolVersion,
      parsedSession.protocolVersion,
      `${label} protocol version`,
    );
    ensureBinding(
      sessionId,
      parsedSession.sessionId,
      `${label} session ID`,
    );
  }
  if (parsedSnapshot) {
    ensureBinding(
      sessionId,
      parsedSnapshot.sessionId,
      `${label} snapshot session ID`,
    );
    ensureBinding(
      snapshotId,
      parsedSnapshot.snapshotId,
      `${label} snapshot ID`,
    );
    ensureRevision(
      revisionId,
      expectedRevisionId ?? parsedSnapshot.revisionId,
      `${label} revision ID`,
    );
    const layer = parsedSnapshot.layers.find(
      (candidate) => candidate.layerId === layerId,
    );
    if (!layer) {
      scopeMismatch(`${label} layer is not part of the active snapshot`, {
        layerId,
      });
    }
    ensureBinding(sourceId, layer.sourceId, `${label} source ID`);
    if (expectedRevisionId === undefined) {
      ensureRevision(
        revisionId,
        layer.revisionId,
        `${label} layer revision ID`,
      );
    }
  }
  return {
    protocolVersion,
    sessionId,
    sourceId,
    revisionId,
    snapshotId,
    layerId,
  };
}

function identityFields(input, label, options) {
  return {
    ...snapshotScope(input, label, options),
    renderId: opaqueIdentifier(
      input.renderId,
      `${label} render ID`,
    ),
    pickId: opaqueIdentifier(input.pickId, `${label} pick ID`),
    worldPosition: finiteVector3(
      input.worldPosition,
      `${label} world position`,
    ),
    worldBounds: worldBounds(
      input.worldBounds,
      `${label} world bounds`,
    ),
  };
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

export function parseRenderRevisionEventDescriptor(
  value,
  { session, expectedSequence } = {},
) {
  const input = plainRecord(value, "render revision event");
  exactKeys(
    input,
    [
      "protocolVersion",
      "eventId",
      "sessionId",
      "sourceId",
      "revisionId",
      "lastSuccessfulRevisionId",
      "snapshotId",
      "sequence",
      "status",
    ],
    "render revision event",
  );
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const protocolVersion = supportedProtocolVersion(
    input.protocolVersion,
  );
  const sessionId = opaqueIdentifier(
    input.sessionId,
    "revision event session ID",
  );
  const sourceId = opaqueIdentifier(
    input.sourceId,
    "revision event source ID",
  );
  const revisionId = opaqueIdentifier(
    input.revisionId,
    "revision event revision ID",
  );
  const lastSuccessfulRevisionId = nullableRevision(
    input.lastSuccessfulRevisionId,
    "revision event last successful revision ID",
  );
  const snapshotId =
    input.snapshotId === null
      ? null
      : opaqueIdentifier(
          input.snapshotId,
          "revision event snapshot ID",
        );
  const sequence = safeInteger(
    input.sequence,
    "revision event sequence",
    1,
  );
  const status = enumValue(
    input.status,
    AllRenderRevisionEventStatuses,
    "revision event status",
  );
  if (parsedSession) {
    ensureBinding(
      protocolVersion,
      parsedSession.protocolVersion,
      "revision event protocol version",
    );
    ensureBinding(
      sessionId,
      parsedSession.sessionId,
      "revision event session ID",
    );
    ensureBinding(
      sourceId,
      parsedSession.sourceId,
      "revision event source ID",
    );
  }
  if (expectedSequence !== undefined) {
    ensureSequence(sequence, expectedSequence, "revision event sequence");
  }
  if (
    status === RenderRevisionEventStatus.AVAILABLE &&
    (snapshotId === null ||
      lastSuccessfulRevisionId !== revisionId)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "an available revision event must identify its successful snapshot",
    );
  }
  if (
    status === RenderRevisionEventStatus.FAILED &&
    snapshotId !== null
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a failed revision event cannot publish a snapshot",
    );
  }
  return Object.freeze({
    protocolVersion,
    eventId: opaqueIdentifier(
      input.eventId,
      "revision event ID",
    ),
    sessionId,
    sourceId,
    revisionId,
    lastSuccessfulRevisionId,
    snapshotId,
    sequence,
    status,
  });
}

function nullableOpaqueIdentifier(value, label) {
  return value === null ? null : opaqueIdentifier(value, label);
}

function parseViewerDiagnostic(value) {
  const input = plainRecord(value, "viewer diagnostic");
  exactKeys(
    input,
    [
      "diagnosticId",
      "severity",
      "code",
      "message",
      "layerId",
      "renderId",
      "worldBounds",
    ],
    "viewer diagnostic",
  );
  const layerId = nullableOpaqueIdentifier(
    input.layerId,
    "diagnostic layer ID",
  );
  const renderId = nullableOpaqueIdentifier(
    input.renderId,
    "diagnostic Render ID",
  );
  if (renderId !== null && layerId === null) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a Render-scoped diagnostic must identify its layer",
    );
  }
  return Object.freeze({
    diagnosticId: opaqueIdentifier(
      input.diagnosticId,
      "diagnostic ID",
    ),
    severity: enumValue(
      input.severity,
      AllViewerDiagnosticSeverities,
      "diagnostic severity",
    ),
    code: boundedString(
      input.code,
      "diagnostic code",
      128,
    ),
    message: boundedString(
      input.message,
      "diagnostic message",
      2_048,
    ),
    layerId,
    renderId,
    worldBounds:
      input.worldBounds === null
        ? null
        : worldBounds(
            input.worldBounds,
            "diagnostic world bounds",
          ),
  });
}

export function parseRenderDiagnosticBatchDescriptor(
  value,
  { session, snapshot, expectedSequence } = {},
) {
  const input = plainRecord(
    value,
    "render diagnostic batch",
  );
  exactKeys(
    input,
    [
      "protocolVersion",
      "batchId",
      "sessionId",
      "sourceId",
      "revisionId",
      "lastSuccessfulRevisionId",
      "snapshotId",
      "sequence",
      "diagnostics",
    ],
    "render diagnostic batch",
  );
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const parsedSnapshot = snapshot
    ? parseRenderSnapshotDescriptor(snapshot, {
        session: parsedSession ?? undefined,
        expectedRevisionId: snapshot.revisionId,
      })
    : null;
  const protocolVersion = supportedProtocolVersion(
    input.protocolVersion,
  );
  const sessionId = opaqueIdentifier(
    input.sessionId,
    "diagnostic batch session ID",
  );
  const sourceId = opaqueIdentifier(
    input.sourceId,
    "diagnostic batch source ID",
  );
  const sequence = safeInteger(
    input.sequence,
    "diagnostic batch sequence",
    1,
  );
  const revisionId = opaqueIdentifier(
    input.revisionId,
    "diagnostic batch revision ID",
  );
  const lastSuccessfulRevisionId = nullableRevision(
    input.lastSuccessfulRevisionId,
    "diagnostic batch last successful revision ID",
  );
  const snapshotId = nullableOpaqueIdentifier(
    input.snapshotId,
    "diagnostic batch snapshot ID",
  );
  if (
    !Array.isArray(input.diagnostics) ||
    input.diagnostics.length > 4_096
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "diagnostic batch entries exceed their bounded limit",
    );
  }
  if (parsedSession) {
    ensureBinding(
      protocolVersion,
      parsedSession.protocolVersion,
      "diagnostic batch protocol version",
    );
    ensureBinding(
      sessionId,
      parsedSession.sessionId,
      "diagnostic batch session ID",
    );
    ensureBinding(
      sourceId,
      parsedSession.sourceId,
      "diagnostic batch source ID",
    );
  }
  if (expectedSequence !== undefined) {
    ensureSequence(sequence, expectedSequence, "diagnostic batch sequence");
  }
  const diagnostics = input.diagnostics.map(
    parseViewerDiagnostic,
  );
  if (
    snapshotId === null &&
    diagnostics.some((diagnostic) => diagnostic.layerId !== null)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a layer-scoped diagnostic batch must identify its snapshot",
    );
  }
  if (
    snapshotId !== null &&
    lastSuccessfulRevisionId === null
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a snapshot-bound diagnostic batch must identify its successful revision",
    );
  }
  if (parsedSnapshot) {
    ensureBinding(
      snapshotId,
      parsedSnapshot.snapshotId,
      "diagnostic batch snapshot ID",
    );
    ensureRevision(
      lastSuccessfulRevisionId,
      parsedSnapshot.revisionId,
      "diagnostic batch last successful revision ID",
    );
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.layerId !== null &&
        !parsedSnapshot.layers.some(
          (layer) => layer.layerId === diagnostic.layerId,
        )
      ) {
        scopeMismatch(
          "diagnostic layer is not part of the active snapshot",
          { layerId: diagnostic.layerId },
        );
      }
    }
  }
  const identifiers = new Set();
  for (const diagnostic of diagnostics) {
    if (identifiers.has(diagnostic.diagnosticId)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "diagnostic IDs must be unique within one batch",
        { diagnosticId: diagnostic.diagnosticId },
      );
    }
    identifiers.add(diagnostic.diagnosticId);
  }
  return Object.freeze({
    protocolVersion,
    batchId: opaqueIdentifier(
      input.batchId,
      "diagnostic batch ID",
    ),
    sessionId,
    sourceId,
    revisionId,
    lastSuccessfulRevisionId,
    snapshotId,
    sequence,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function parsePickResolveRequest(
  value,
  { session, snapshot, expectedRevisionId } = {},
) {
  const input = plainRecord(value, "pick resolve request");
  exactKeys(
    input,
    [
      "protocolVersion",
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
      "worldPosition",
      "worldBounds",
    ],
    "pick resolve request",
  );
  return Object.freeze(
    identityFields(input, "pick resolve request", {
      session,
      snapshot,
      expectedRevisionId,
    }),
  );
}

export function parseRenderIdentityDescriptor(
  value,
  { session, snapshot, request, expectedRevisionId } = {},
) {
  const input = plainRecord(value, "render identity");
  exactKeys(
    input,
    [
      "protocolVersion",
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
      "worldPosition",
      "worldBounds",
      "externalIdentityToken",
    ],
    "render identity",
  );
  const fields = identityFields(input, "render identity", {
    session,
    snapshot,
    expectedRevisionId,
  });
  if (request) {
    const parsedRequest = parsePickResolveRequest(request, {
      session,
      snapshot,
      expectedRevisionId,
    });
    for (const key of [
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
    ]) {
      ensureBinding(
        fields[key],
        parsedRequest[key],
        `render identity ${key}`,
      );
    }
  }
  return Object.freeze({
    ...fields,
    externalIdentityToken:
      input.externalIdentityToken === null
        ? null
        : opaqueIdentifier(
            input.externalIdentityToken,
            "external identity token",
          ),
  });
}

export function parseContextReferenceDescriptor(
  value,
  { session, snapshot, identity, expectedRevisionId } = {},
) {
  const input = plainRecord(value, "context reference");
  exactKeys(
    input,
    [
      "protocolVersion",
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
      "externalIdentityToken",
      "contextId",
      "expiresAt",
      "disposeWithSession",
    ],
    "context reference",
  );
  const scope = snapshotScope(input, "context reference", {
    session,
    snapshot,
    expectedRevisionId,
  });
  const context = {
    ...scope,
    renderId: opaqueIdentifier(
      input.renderId,
      "context render ID",
    ),
    pickId: opaqueIdentifier(input.pickId, "context pick ID"),
    externalIdentityToken:
      input.externalIdentityToken === null
        ? null
        : opaqueIdentifier(
            input.externalIdentityToken,
            "context external identity token",
          ),
    contextId: opaqueIdentifier(input.contextId, "context ID"),
    expiresAt: nullableTimestamp(
      input.expiresAt,
      "context expiration",
    ),
    disposeWithSession: boolean(
      input.disposeWithSession,
      "context session disposal flag",
    ),
  };
  if (context.expiresAt === null && !context.disposeWithSession) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a context reference must expire or be disposed with its session",
    );
  }
  if (identity) {
    const parsedIdentity = parseRenderIdentityDescriptor(identity, {
      session,
      snapshot,
      expectedRevisionId,
    });
    for (const key of [
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
      "externalIdentityToken",
    ]) {
      ensureBinding(
        context[key],
        parsedIdentity[key],
        `context reference ${key}`,
      );
    }
  }
  return Object.freeze(context);
}

export function parseSourceRevealDescriptor(
  value,
  { session, snapshot, identity, expectedRevisionId } = {},
) {
  const input = plainRecord(value, "source reveal");
  exactKeys(
    input,
    [
      "protocolVersion",
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
      "externalIdentityToken",
      "revealId",
      "label",
      "expiresAt",
      "disposeWithSession",
    ],
    "source reveal",
  );
  const scope = snapshotScope(input, "source reveal", {
    session,
    snapshot,
    expectedRevisionId,
  });
  const reveal = {
    ...scope,
    renderId: opaqueIdentifier(
      input.renderId,
      "source reveal render ID",
    ),
    pickId: opaqueIdentifier(
      input.pickId,
      "source reveal pick ID",
    ),
    externalIdentityToken:
      input.externalIdentityToken === null
        ? null
        : opaqueIdentifier(
            input.externalIdentityToken,
            "source reveal external identity token",
          ),
    revealId: opaqueIdentifier(
      input.revealId,
      "source reveal ID",
    ),
    label: boundedString(input.label, "source reveal label", 256),
    expiresAt: nullableTimestamp(
      input.expiresAt,
      "source reveal expiration",
    ),
    disposeWithSession: boolean(
      input.disposeWithSession,
      "source reveal session disposal flag",
    ),
  };
  if (reveal.expiresAt === null && !reveal.disposeWithSession) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a source reveal must expire or be disposed with its session",
    );
  }
  if (identity) {
    const parsedIdentity = parseRenderIdentityDescriptor(identity, {
      session,
      snapshot,
      expectedRevisionId,
    });
    for (const key of [
      "sessionId",
      "sourceId",
      "revisionId",
      "snapshotId",
      "layerId",
      "renderId",
      "pickId",
      "externalIdentityToken",
    ]) {
      ensureBinding(
        reveal[key],
        parsedIdentity[key],
        `source reveal ${key}`,
      );
    }
  }
  return Object.freeze(reveal);
}

function uniqueOpaqueIdentifiers(
  value,
  label,
  maximumLength,
) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      `${label} must be a bounded non-empty array`,
    );
  }
  const identifiers = [];
  const seen = new Set();
  for (const entry of value) {
    const identifier = opaqueIdentifier(entry, `${label} entry`);
    if (seen.has(identifier)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        `${label} must not contain duplicates`,
        { identifier },
      );
    }
    seen.add(identifier);
    identifiers.push(identifier);
  }
  return Object.freeze(identifiers);
}

function optionalOpaqueIdentifiers(
  value,
  label,
  maximumLength,
) {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      `${label} must be a bounded array`,
    );
  }
  if (value.length === 0) {
    return Object.freeze([]);
  }
  return uniqueOpaqueIdentifiers(value, label, maximumLength);
}

function boundsContain(container, child) {
  return container.min.every(
    (minimum, axis) =>
      minimum <= child.min[axis] &&
      container.max[axis] >= child.max[axis],
  );
}

function parseRenderDeltaOperation(value, { snapshot }) {
  const input = plainRecord(value, "render delta operation");
  exactKeys(
    input,
    [
      "operationId",
      "kind",
      "aspect",
      "layerId",
      "sourceId",
      "renderIds",
      "affectedWorldBounds",
      "dependencyIds",
      "externalIdentityToken",
    ],
    "render delta operation",
  );
  const kind = enumValue(
    input.kind,
    AllRenderDeltaOperationKinds,
    "render delta operation kind",
  );
  const aspect = enumValue(
    input.aspect,
    AllRenderDeltaAspects,
    "render delta operation aspect",
  );
  const layerId = opaqueIdentifier(
    input.layerId,
    "render delta layer ID",
  );
  const sourceId = opaqueIdentifier(
    input.sourceId,
    "render delta operation source ID",
  );
  const layer = snapshot.layers.find(
    (candidate) => candidate.layerId === layerId,
  );
  if (!layer) {
    scopeMismatch(
      "render delta operation layer is not in the base snapshot",
      { layerId },
    );
  }
  ensureBinding(
    sourceId,
    layer.sourceId,
    "render delta operation source ID",
  );
  const dependencyIds = optionalOpaqueIdentifiers(
    input.dependencyIds,
    "render delta dependency IDs",
    1024,
  );
  const externalIdentityToken =
    input.externalIdentityToken === null
      ? null
      : opaqueIdentifier(
          input.externalIdentityToken,
          "render delta external identity token",
        );
  if (
    kind === RenderDeltaOperationKind.TOMBSTONE &&
    (aspect !== RenderDeltaAspect.ENTITY ||
      dependencyIds.length > 0 ||
      externalIdentityToken !== null)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a tombstone must remove one entity identity without payload metadata",
    );
  }
  if (
    aspect === RenderDeltaAspect.DEPENDENCY &&
    dependencyIds.length === 0
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a dependency upsert must identify invalidated dependencies",
    );
  }
  return Object.freeze({
    operationId: opaqueIdentifier(
      input.operationId,
      "render delta operation ID",
    ),
    kind,
    aspect,
    layerId,
    sourceId,
    renderIds: uniqueOpaqueIdentifiers(
      input.renderIds,
      "render delta Render IDs",
      4096,
    ),
    affectedWorldBounds: worldBounds(
      input.affectedWorldBounds,
      "render delta operation affected world bounds",
    ),
    dependencyIds,
    externalIdentityToken,
  });
}

export function parseRenderDeltaPayloadDescriptor(
  value,
  {
    session,
    sourceId,
    fromRevisionId,
    toRevisionId,
  } = {},
) {
  const input = plainRecord(value, "render delta payload");
  exactKeys(
    input,
    [
      "protocolVersion",
      "payloadId",
      "sessionId",
      "sourceId",
      "fromRevisionId",
      "toRevisionId",
      "mediaType",
      "byteLength",
      "sha256",
      "expiresAt",
      "disposeWithSession",
    ],
    "render delta payload",
  );
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const protocolVersion = supportedProtocolVersion(input.protocolVersion);
  const sessionId = opaqueIdentifier(
    input.sessionId,
    "render delta payload session ID",
  );
  const parsedSourceId = opaqueIdentifier(
    input.sourceId,
    "render delta payload source ID",
  );
  const parsedFromRevisionId = opaqueIdentifier(
    input.fromRevisionId,
    "render delta payload source revision ID",
  );
  const parsedToRevisionId = opaqueIdentifier(
    input.toRevisionId,
    "render delta payload target revision ID",
  );
  const byteLength = positiveSafeInteger(
    input.byteLength,
    "render delta payload byte length",
  );
  const expiresAt = nullableTimestamp(
    input.expiresAt,
    "render delta payload expiration",
  );
  const disposeWithSession = boolean(
    input.disposeWithSession,
    "render delta payload session disposal flag",
  );
  if (expiresAt === null && !disposeWithSession) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "a render delta payload must expire or be disposed with its session",
    );
  }
  if (
    typeof input.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "render delta payload digest must be lowercase SHA-256",
    );
  }
  if (parsedSession) {
    ensureBinding(
      protocolVersion,
      parsedSession.protocolVersion,
      "render delta payload protocol version",
    );
    ensureBinding(
      sessionId,
      parsedSession.sessionId,
      "render delta payload session ID",
    );
    ensureBinding(
      parsedSourceId,
      parsedSession.sourceId,
      "render delta payload source ID",
    );
    if (byteLength > parsedSession.resourceBudgetBytes) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "render delta payload exceeds the session resource budget",
      );
    }
  }
  ensureBinding(
    parsedSourceId,
    sourceId,
    "render delta payload source ID",
  );
  ensureRevision(
    parsedFromRevisionId,
    fromRevisionId,
    "render delta payload source revision ID",
  );
  ensureRevision(
    parsedToRevisionId,
    toRevisionId,
    "render delta payload target revision ID",
  );
  return Object.freeze({
    protocolVersion,
    payloadId: opaqueIdentifier(
      input.payloadId,
      "render delta payload ID",
    ),
    sessionId,
    sourceId: parsedSourceId,
    fromRevisionId: parsedFromRevisionId,
    toRevisionId: parsedToRevisionId,
    mediaType: boundedString(
      input.mediaType,
      "render delta payload media type",
      128,
    ),
    byteLength,
    sha256: input.sha256,
    expiresAt,
    disposeWithSession,
  });
}

export function parseRenderDeltaDescriptor(
  value,
  {
    session,
    snapshot,
    expectedRevisionId,
    expectedSequence,
  } = {},
) {
  const input = plainRecord(value, "render delta");
  exactKeys(
    input,
    [
      "protocolVersion",
      "deltaId",
      "sessionId",
      "sourceId",
      "baseSnapshotId",
      "fromRevisionId",
      "toRevisionId",
      "sequence",
      "operations",
      "affectedWorldBounds",
      "payload",
    ],
    "render delta",
  );
  const parsedSession = session
    ? parseRenderSessionDescriptor(session)
    : null;
  const parsedSnapshot = snapshot
    ? parseRenderSnapshotDescriptor(snapshot, {
        session: parsedSession ?? undefined,
      })
    : null;
  if (!parsedSnapshot) {
    throw new TypeError(
      "render delta validation requires a base snapshot",
    );
  }
  const protocolVersion = supportedProtocolVersion(input.protocolVersion);
  const sessionId = opaqueIdentifier(
    input.sessionId,
    "render delta session ID",
  );
  const sourceId = opaqueIdentifier(
    input.sourceId,
    "render delta source ID",
  );
  const baseSnapshotId = opaqueIdentifier(
    input.baseSnapshotId,
    "render delta base snapshot ID",
  );
  const fromRevisionId = opaqueIdentifier(
    input.fromRevisionId,
    "render delta source revision ID",
  );
  const toRevisionId = opaqueIdentifier(
    input.toRevisionId,
    "render delta target revision ID",
  );
  const sequence = positiveSafeInteger(
    input.sequence,
    "render delta sequence",
  );
  ensureBinding(
    protocolVersion,
    parsedSnapshot.protocolVersion,
    "render delta protocol version",
  );
  ensureBinding(
    sessionId,
    parsedSnapshot.sessionId,
    "render delta session ID",
  );
  ensureBinding(
    sourceId,
    parsedSnapshot.sourceId,
    "render delta source ID",
  );
  ensureBinding(
    baseSnapshotId,
    parsedSnapshot.snapshotId,
    "render delta base snapshot ID",
  );
  ensureRevision(
    fromRevisionId,
    expectedRevisionId ?? parsedSnapshot.revisionId,
    "render delta source revision ID",
  );
  if (fromRevisionId === toRevisionId) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "render delta must advance to a different revision",
    );
  }
  if (
    expectedSequence !== undefined &&
    sequence !== expectedSequence
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.OUT_OF_ORDER,
      "render delta sequence is stale or out of order",
      { expected: expectedSequence, received: sequence },
    );
  }
  if (
    !Array.isArray(input.operations) ||
    input.operations.length === 0 ||
    input.operations.length > 4096
  ) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "render delta operations must be a bounded non-empty array",
    );
  }
  const operations = [];
  let totalRenderIds = 0;
  let totalDependencyIds = 0;
  for (const operation of input.operations) {
    const parsed = parseRenderDeltaOperation(operation, {
      snapshot: parsedSnapshot,
    });
    totalRenderIds += parsed.renderIds.length;
    totalDependencyIds += parsed.dependencyIds.length;
    if (totalRenderIds > 65_536 || totalDependencyIds > 65_536) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "render delta identity lists exceed their atomic bounds",
        { totalRenderIds, totalDependencyIds },
      );
    }
    operations.push(parsed);
  }
  const changedRenderIds = new Set();
  for (const operation of operations) {
    for (const renderId of operation.renderIds) {
      const identity = `${operation.layerId}\u0000${renderId}`;
      if (changedRenderIds.has(identity)) {
        throw new RenderProtocolError(
          RenderProtocolDiagnosticCode.MESSAGE_INVALID,
          "a Render ID may change only once in an atomic delta",
          { layerId: operation.layerId, renderId },
        );
      }
      changedRenderIds.add(identity);
    }
  }
  const affectedWorldBounds = worldBounds(
    input.affectedWorldBounds,
    "render delta affected world bounds",
  );
  for (const operation of operations) {
    if (
      !boundsContain(
        affectedWorldBounds,
        operation.affectedWorldBounds,
      )
    ) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        "render delta bounds must contain every operation",
        { operationId: operation.operationId },
      );
    }
  }
  const payload =
    input.payload === null
      ? null
      : parseRenderDeltaPayloadDescriptor(input.payload, {
          session: parsedSession ?? undefined,
          sourceId,
          fromRevisionId,
          toRevisionId,
        });
  const requiresPayload = operations.some(
    (operation) =>
      operation.kind === RenderDeltaOperationKind.UPSERT &&
      ![
        RenderDeltaAspect.IDENTITY,
        RenderDeltaAspect.DEPENDENCY,
      ].includes(operation.aspect),
  );
  if (requiresPayload && payload === null) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      "render upserts require a bounded binary payload",
    );
  }
  return Object.freeze({
    protocolVersion,
    deltaId: opaqueIdentifier(input.deltaId, "render delta ID"),
    sessionId,
    sourceId,
    baseSnapshotId,
    fromRevisionId,
    toRevisionId,
    sequence,
    operations: Object.freeze(operations),
    affectedWorldBounds,
    payload,
  });
}
