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
  { session, snapshot } = {},
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
      parsedSnapshot.revisionId,
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
    ensureRevision(
      revisionId,
      layer.revisionId,
      `${label} layer revision ID`,
    );
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

export function parsePickResolveRequest(
  value,
  { session, snapshot } = {},
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
    }),
  );
}

export function parseRenderIdentityDescriptor(
  value,
  { session, snapshot, request } = {},
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
  });
  if (request) {
    const parsedRequest = parsePickResolveRequest(request, {
      session,
      snapshot,
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
  { session, snapshot, identity } = {},
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
  { session, snapshot, identity } = {},
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
