import {
  AllNativeAdapterOperations,
  AllNativeBackendKinds,
  AllNativeCapabilityStatuses,
  ChangeCapabilityByKind,
  NativeAdapterErrorCode,
  NativeChangeKind,
  NativeDocumentAdapterProtocol,
  NativeQueryLimits,
} from "./constants.mjs";
import {
  adapterError,
  invalid,
} from "./diagnostics.mjs";

const SOURCE_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const ENTITY_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const HANDLE = /^handle:[0-9A-F]+$/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?::[A-Za-z0-9._-]+)+$/u;
const VERSION_CODE = /^AC10[0-9]{2}$/u;

export function plainRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ArrayBuffer.isView(value)
  ) {
    invalid(`${label} must be an object`);
  }
  return value;
}

export function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter(
    (key) => !allowed.has(key),
  );
  if (unexpected.length > 0) {
    invalid(`${label} contains unsupported fields`, {
      fields: unexpected,
    });
  }
}

export function boundedString(value, label, maximum = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    invalid(`${label} must be a bounded non-empty string`);
  }
  return value;
}

export function identifier(value, label) {
  boundedString(value, label, 256);
  if (!IDENTIFIER.test(value)) {
    invalid(`${label} must be an opaque identifier`);
  }
  return value;
}

export function sourceFingerprint(value, label = "source fingerprint") {
  if (typeof value !== "string" || !SOURCE_FINGERPRINT.test(value)) {
    invalid(`${label} must be a SHA-256 source fingerprint`);
  }
  return value;
}

export function entityFingerprint(value, label = "entity fingerprint") {
  if (typeof value !== "string" || !ENTITY_FINGERPRINT.test(value)) {
    invalid(`${label} must be a SHA-256 entity fingerprint`);
  }
  return value;
}

export function nativeHandle(value, label = "native handle") {
  if (typeof value !== "string" || !HANDLE.test(value)) {
    invalid(`${label} must be an uppercase DWG handle`);
  }
  return value;
}

export function positiveInteger(value, label, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    invalid(`${label} must be a bounded positive safe integer`);
  }
  return value;
}

export function finiteVector(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(Number.isFinite)
  ) {
    invalid(`${label} must have three finite coordinates`);
  }
  return Object.freeze([...value]);
}

export function worldBounds(value, label = "world bounds") {
  const input = plainRecord(value, label);
  exactKeys(input, ["min", "max"], label);
  const min = finiteVector(input.min, `${label}.min`);
  const max = finiteVector(input.max, `${label}.max`);
  if (min.some((coordinate, axis) => coordinate > max[axis])) {
    invalid(`${label} minimum exceeds maximum`);
  }
  return Object.freeze({ min, max });
}

function optionalBounds(value, label) {
  return value === null ? null : worldBounds(value, label);
}

export function parseEntityReference(value) {
  const input = plainRecord(value, "native entity reference");
  exactKeys(
    input,
    [
      "documentFingerprint",
      "spaceId",
      "nestedInstancePath",
      "handle",
      "entityFingerprint",
    ],
    "native entity reference",
  );
  if (
    !Array.isArray(input.nestedInstancePath) ||
    input.nestedInstancePath.length >
      NativeQueryLimits.maximumNestedInstanceDepth
  ) {
    invalid("nested instance path exceeds its depth limit");
  }
  return Object.freeze({
    documentFingerprint: sourceFingerprint(
      input.documentFingerprint,
    ),
    spaceId: identifier(input.spaceId, "native entity space ID"),
    nestedInstancePath: Object.freeze(
      input.nestedInstancePath.map((handle, index) =>
        nativeHandle(handle, `nested instance handle ${index}`),
      ),
    ),
    handle: nativeHandle(input.handle),
    entityFingerprint: entityFingerprint(input.entityFingerprint),
  });
}

export function parseNativeEntity(value) {
  const input = plainRecord(value, "native entity");
  exactKeys(
    input,
    [
      "ref",
      "type",
      "layerIndex",
      "bounds",
      "boundsPrecision",
      "summary",
    ],
    "native entity",
  );
  if (
    !Number.isSafeInteger(input.layerIndex) ||
    input.layerIndex < 0
  ) {
    invalid("native entity layer index is invalid");
  }
  if (
    !["exact", "conservative", "unindexed"].includes(
      input.boundsPrecision,
    )
  ) {
    invalid("native entity bounds precision is invalid");
  }
  const summary = plainRecord(input.summary, "native entity summary");
  if (
    Object.keys(summary).length > 16 ||
    JSON.stringify(summary).length > 4096
  ) {
    invalid("native entity summary exceeds its budget");
  }
  return Object.freeze({
    ref: parseEntityReference(input.ref),
    type: boundedString(input.type, "native entity type", 64),
    layerIndex: input.layerIndex,
    bounds: optionalBounds(input.bounds, "native entity bounds"),
    boundsPrecision: input.boundsPrecision,
    summary: Object.freeze(structuredClone(summary)),
  });
}

function parseCapability(value, operation) {
  const input = plainRecord(
    value,
    `native adapter capability ${operation}`,
  );
  exactKeys(input, ["status", "reason"], `capability ${operation}`);
  if (!AllNativeCapabilityStatuses.includes(input.status)) {
    invalid(`capability ${operation} has an invalid status`);
  }
  return Object.freeze({
    status: input.status,
    reason: boundedString(
      input.reason,
      `capability ${operation} reason`,
      1024,
    ),
  });
}

export function parseAdapterDescriptor(value) {
  const input = plainRecord(value, "native adapter descriptor");
  exactKeys(
    input,
    [
      "protocol",
      "sessionId",
      "adapterId",
      "adapterVersion",
      "engineId",
      "engineVersion",
      "backendId",
      "backendKind",
      "license",
      "sourceFingerprint",
      "inputCapabilityId",
      "sourceVersion",
      "outputVersions",
      "capabilities",
      "limits",
    ],
    "native adapter descriptor",
  );
  if (input.protocol !== NativeDocumentAdapterProtocol) {
    adapterError(
      NativeAdapterErrorCode.VERSION_INCOMPATIBLE,
      `unsupported native document adapter protocol ${input.protocol}`,
    );
  }
  if (!AllNativeBackendKinds.includes(input.backendKind)) {
    invalid("native adapter backend kind is invalid");
  }
  if (
    typeof input.sourceVersion !== "string" ||
    !VERSION_CODE.test(input.sourceVersion)
  ) {
    invalid("native adapter source version is invalid");
  }
  if (
    !Array.isArray(input.outputVersions) ||
    input.outputVersions.length === 0 ||
    new Set(input.outputVersions).size !== input.outputVersions.length ||
    !input.outputVersions.every((version) => VERSION_CODE.test(version))
  ) {
    invalid("native adapter output versions are invalid");
  }
  const capabilities = plainRecord(
    input.capabilities,
    "native adapter capabilities",
  );
  exactKeys(
    capabilities,
    AllNativeAdapterOperations,
    "native adapter capabilities",
  );
  for (const operation of AllNativeAdapterOperations) {
    if (!(operation in capabilities)) {
      invalid(`native adapter capability ${operation} is missing`);
    }
  }
  const limits = plainRecord(input.limits, "native adapter limits");
  exactKeys(
    limits,
    [
      "maximumPageSize",
      "maximumQueryPayloadBytes",
      "maximumProposalBytes",
      "maximumProposalOperations",
    ],
    "native adapter limits",
  );
  const parsedLimits = Object.freeze({
    maximumPageSize: positiveInteger(
      limits.maximumPageSize,
      "maximum page size",
      NativeQueryLimits.maximumPageSize,
    ),
    maximumQueryPayloadBytes: positiveInteger(
      limits.maximumQueryPayloadBytes,
      "maximum query payload bytes",
      NativeQueryLimits.maximumQueryPayloadBytes,
    ),
    maximumProposalBytes: positiveInteger(
      limits.maximumProposalBytes,
      "maximum proposal bytes",
      NativeQueryLimits.maximumProposalBytes,
    ),
    maximumProposalOperations: positiveInteger(
      limits.maximumProposalOperations,
      "maximum proposal operations",
      NativeQueryLimits.maximumProposalOperations,
    ),
  });
  return Object.freeze({
    protocol: input.protocol,
    sessionId: identifier(input.sessionId, "adapter session ID"),
    adapterId: identifier(input.adapterId, "adapter ID"),
    adapterVersion: boundedString(
      input.adapterVersion,
      "adapter version",
      64,
    ),
    engineId: identifier(input.engineId, "engine ID"),
    engineVersion: boundedString(
      input.engineVersion,
      "engine version",
      64,
    ),
    backendId: identifier(input.backendId, "backend ID"),
    backendKind: input.backendKind,
    license: boundedString(input.license, "adapter license", 128),
    sourceFingerprint: sourceFingerprint(input.sourceFingerprint),
    inputCapabilityId: identifier(
      input.inputCapabilityId,
      "registered input capability ID",
    ),
    sourceVersion: input.sourceVersion,
    outputVersions: Object.freeze([...input.outputVersions]),
    capabilities: Object.freeze(
      Object.fromEntries(
        AllNativeAdapterOperations.map((operation) => [
          operation,
          parseCapability(capabilities[operation], operation),
        ]),
      ),
    ),
    limits: parsedLimits,
  });
}

function parseChangeOperation(value, index) {
  const input = plainRecord(value, `change operation ${index}`);
  exactKeys(
    input,
    ["operationId", "kind", "target", "payload"],
    `change operation ${index}`,
  );
  if (!(input.kind in ChangeCapabilityByKind)) {
    invalid(`change operation ${index} kind is unsupported`);
  }
  const rawPayload = plainRecord(
    input.payload,
    `change operation ${index} payload`,
  );
  if (JSON.stringify(rawPayload).length > 64 * 1024) {
    invalid(`change operation ${index} payload exceeds its budget`);
  }
  const requiresTarget =
    input.kind !== NativeChangeKind.BASIC_ENTITY_CREATE;
  if (requiresTarget !== (input.target !== null)) {
    invalid(
      `change operation ${index} target presence does not match its kind`,
    );
  }
  let payload;
  switch (input.kind) {
    case NativeChangeKind.TEXT_REPLACE:
      exactKeys(
        rawPayload,
        ["value"],
        `change operation ${index} text payload`,
      );
      payload = Object.freeze({
        value: boundedString(
          rawPayload.value,
          `change operation ${index} text value`,
          65_536,
        ),
      });
      break;
    case NativeChangeKind.LINE_MOVE:
    case NativeChangeKind.POLYLINE_MOVE:
      exactKeys(
        rawPayload,
        ["translation"],
        `change operation ${index} move payload`,
      );
      payload = Object.freeze({
        translation: finiteVector(
          rawPayload.translation,
          `change operation ${index} translation`,
        ),
      });
      break;
    case NativeChangeKind.LAYER_STYLE_SET: {
      exactKeys(
        rawPayload,
        ["layerIndex", "color", "lineWeight", "linetype"],
        `change operation ${index} layer/style payload`,
      );
      if (
        !Number.isSafeInteger(rawPayload.layerIndex) ||
        rawPayload.layerIndex < 0 ||
        !Number.isSafeInteger(rawPayload.color) ||
        rawPayload.color < 0 ||
        rawPayload.color > 0xffffffff ||
        !Number.isSafeInteger(rawPayload.lineWeight) ||
        rawPayload.lineWeight < -3 ||
        rawPayload.lineWeight > 211
      ) {
        invalid(`change operation ${index} layer/style values are invalid`);
      }
      payload = Object.freeze({
        layerIndex: rawPayload.layerIndex,
        color: rawPayload.color,
        lineWeight: rawPayload.lineWeight,
        linetype: boundedString(
          rawPayload.linetype,
          `change operation ${index} linetype`,
          255,
        ),
      });
      break;
    }
    case NativeChangeKind.INSERT_TRANSFORM_SET:
      exactKeys(
        rawPayload,
        ["matrix"],
        `change operation ${index} INSERT transform payload`,
      );
      if (
        !Array.isArray(rawPayload.matrix) ||
        rawPayload.matrix.length !== 16 ||
        !rawPayload.matrix.every(Number.isFinite)
      ) {
        invalid(`change operation ${index} matrix is invalid`);
      }
      payload = Object.freeze({
        matrix: Object.freeze([...rawPayload.matrix]),
      });
      break;
    case NativeChangeKind.BASIC_ENTITY_CREATE: {
      exactKeys(
        rawPayload,
        ["entityType", "spaceId", "layerIndex", "geometry"],
        `change operation ${index} create payload`,
      );
      if (
        !["LINE", "LWPOLYLINE", "TEXT"].includes(
          rawPayload.entityType,
        ) ||
        !Number.isSafeInteger(rawPayload.layerIndex) ||
        rawPayload.layerIndex < 0
      ) {
        invalid(`change operation ${index} create target is invalid`);
      }
      const geometry = plainRecord(
        rawPayload.geometry,
        `change operation ${index} geometry`,
      );
      if (JSON.stringify(geometry).length > 32 * 1024) {
        invalid(`change operation ${index} geometry exceeds its budget`);
      }
      payload = Object.freeze({
        entityType: rawPayload.entityType,
        spaceId: identifier(
          rawPayload.spaceId,
          `change operation ${index} space ID`,
        ),
        layerIndex: rawPayload.layerIndex,
        geometry: Object.freeze(structuredClone(geometry)),
      });
      break;
    }
    case NativeChangeKind.BASIC_ENTITY_DELETE:
      exactKeys(
        rawPayload,
        [],
        `change operation ${index} delete payload`,
      );
      payload = Object.freeze({});
      break;
    default:
      invalid(`change operation ${index} kind is unsupported`);
  }
  return Object.freeze({
    operationId: identifier(
      input.operationId,
      `change operation ${index} ID`,
    ),
    kind: input.kind,
    target:
      input.target === null
        ? null
        : parseEntityReference(input.target),
    payload,
  });
}

export function parseChangeProposal(value, descriptor) {
  const input = plainRecord(value, "native change proposal");
  exactKeys(
    input,
    [
      "protocol",
      "proposalId",
      "sourceFingerprint",
      "inputCapabilityId",
      "outputCapabilityId",
      "outputFormat",
      "outputVersion",
      "operations",
    ],
    "native change proposal",
  );
  if (input.protocol !== NativeDocumentAdapterProtocol) {
    adapterError(
      NativeAdapterErrorCode.VERSION_INCOMPATIBLE,
      "native change proposal protocol is incompatible",
    );
  }
  const parsed = {
    protocol: input.protocol,
    proposalId: identifier(input.proposalId, "proposal ID"),
    sourceFingerprint: sourceFingerprint(input.sourceFingerprint),
    inputCapabilityId: identifier(
      input.inputCapabilityId,
      "proposal input capability ID",
    ),
    outputCapabilityId: identifier(
      input.outputCapabilityId,
      "proposal output capability ID",
    ),
    outputFormat: input.outputFormat,
    outputVersion: input.outputVersion,
  };
  if (!["dwg", "dxf"].includes(parsed.outputFormat)) {
    invalid("proposal output format is unsupported");
  }
  if (!descriptor.outputVersions.includes(parsed.outputVersion)) {
    invalid("proposal output version is unsupported");
  }
  if (
    !Array.isArray(input.operations) ||
    input.operations.length > descriptor.limits.maximumProposalOperations
  ) {
    invalid("proposal operation count exceeds its limit");
  }
  const operations = input.operations.map(parseChangeOperation);
  if (
    new Set(operations.map((operation) => operation.operationId)).size !==
    operations.length
  ) {
    invalid("proposal operation IDs must be unique");
  }
  const proposal = Object.freeze({
    ...parsed,
    operations: Object.freeze(operations),
  });
  if (
    new TextEncoder().encode(JSON.stringify(proposal)).byteLength >
    descriptor.limits.maximumProposalBytes
  ) {
    adapterError(
      NativeAdapterErrorCode.BUDGET_EXCEEDED,
      "native change proposal exceeds its byte budget",
    );
  }
  return proposal;
}

export function capabilityForChange(kind) {
  return ChangeCapabilityByKind[kind];
}

export function freezeReceipt(value) {
  return Object.freeze(structuredClone(value));
}
