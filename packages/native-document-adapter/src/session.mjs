import {
  NativeAdapterErrorCode,
  NativeAdapterOperation,
  NativeAdapterProgressPhase,
  NativeCapabilityStatus,
  NativeDocumentAdapterProtocol,
} from "./constants.mjs";
import {
  adapterError,
  disposed,
  invalid,
} from "./diagnostics.mjs";
import {
  boundedString,
  capabilityForChange,
  exactKeys,
  identifier,
  parseAdapterDescriptor,
  parseChangeProposal,
  parseEntityReference,
  parseNativeEntity,
  plainRecord,
  positiveInteger,
  sourceFingerprint,
  worldBounds,
} from "./validation.mjs";

function aborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("operation aborted", "AbortError");
  }
}

function assertProvider(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.queryEntity !== "function" ||
    typeof value.queryRegion !== "function" ||
    typeof value.dispose !== "function"
  ) {
    throw new TypeError(
      "native document provider must implement queryEntity(), " +
        "queryRegion(), and dispose()",
    );
  }
  return value;
}

function available(status) {
  return (
    status === NativeCapabilityStatus.NATIVE ||
    status === NativeCapabilityStatus.MAPPED
  );
}

function progressListener(value) {
  if (value === undefined) {
    return () => {};
  }
  if (typeof value !== "function") {
    throw new TypeError("native adapter progress listener must be a function");
  }
  return value;
}

function assertTargetType(kind, entity) {
  const accepted = {
    "text.replace": ["TEXT", "MTEXT", "ATTDEF", "ATTRIB"],
    "line.move": ["LINE"],
    "polyline.move": ["POLYLINE", "LWPOLYLINE"],
    "insert-transform.set": ["INSERT", "MINSERT"],
  }[kind];
  if (accepted && !accepted.includes(entity.type)) {
    adapterError(
      NativeAdapterErrorCode.MESSAGE_INVALID,
      `change ${kind} cannot target ${entity.type}`,
      { handle: entity.ref.handle, accepted },
    );
  }
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  try {
    const base64 = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    invalid("native query cursor is malformed");
  }
}

function queryKey(bounds, types) {
  return JSON.stringify({
    bounds,
    types: [...types].sort(),
  });
}

function parseRegionRequest(value, descriptor) {
  const input = plainRecord(value, "native region query");
  exactKeys(
    input,
    [
      "sourceFingerprint",
      "bounds",
      "types",
      "pageSize",
      "cursor",
    ],
    "native region query",
  );
  if (
    !Array.isArray(input.types) ||
    input.types.length > 64 ||
    new Set(input.types).size !== input.types.length
  ) {
    invalid("native region query types are invalid");
  }
  return Object.freeze({
    sourceFingerprint: sourceFingerprint(input.sourceFingerprint),
    bounds: worldBounds(input.bounds, "native region query bounds"),
    types: Object.freeze(
      input.types.map((type) =>
        boundedString(type, "native region query type", 64),
      ),
    ),
    pageSize: positiveInteger(
      input.pageSize,
      "native region query page size",
      descriptor.limits.maximumPageSize,
    ),
    cursor:
      input.cursor === null
        ? null
        : boundedString(
          input.cursor,
          "native region query cursor",
          4096,
        ),
  });
}

function matchesReference(actual, expected) {
  return (
    actual.documentFingerprint === expected.documentFingerprint &&
    actual.spaceId === expected.spaceId &&
    actual.handle === expected.handle &&
    actual.entityFingerprint === expected.entityFingerprint &&
    actual.nestedInstancePath.length ===
      expected.nestedInstancePath.length &&
    actual.nestedInstancePath.every(
      (handle, index) =>
        handle === expected.nestedInstancePath[index],
    )
  );
}

function validateCleanup(value, backendKind) {
  const input = plainRecord(value, "native adapter cleanup receipt");
  exactKeys(
    input,
    [
      "remainingTemporaryFiles",
      "remainingOutputReservations",
      "processExited",
      "workerTerminated",
    ],
    "native adapter cleanup receipt",
  );
  if (
    input.remainingTemporaryFiles !== 0 ||
    input.remainingOutputReservations !== 0 ||
    typeof input.processExited !== "boolean" ||
    typeof input.workerTerminated !== "boolean"
  ) {
    adapterError(
      NativeAdapterErrorCode.BACKEND_FAILED,
      "native adapter did not prove complete cleanup",
      { backendKind },
    );
  }
  return Object.freeze({ ...input });
}

function validateChangeReceipt(value, proposal, descriptor) {
  const input = plainRecord(value, "native change receipt");
  exactKeys(
    input,
    [
      "schema",
      "status",
      "protocol",
      "proposalId",
      "adapterId",
      "backendId",
      "sourceFingerprint",
      "outputFingerprint",
      "outputCapabilityId",
      "outputFormat",
      "outputVersion",
      "intended",
      "observed",
      "preservation",
      "reopen",
      "cleanup",
    ],
    "native change receipt",
  );
  if (
    input.schema !== "dwg-native-change-receipt/1" ||
    input.status !== "validated" ||
    input.protocol !== NativeDocumentAdapterProtocol ||
    input.proposalId !== proposal.proposalId ||
    input.adapterId !== descriptor.adapterId ||
    input.backendId !== descriptor.backendId ||
    input.sourceFingerprint !== descriptor.sourceFingerprint ||
    input.outputCapabilityId !== proposal.outputCapabilityId ||
    input.outputFormat !== proposal.outputFormat ||
    input.outputVersion !== proposal.outputVersion
  ) {
    adapterError(
      NativeAdapterErrorCode.BACKEND_FAILED,
      "native change receipt is outside the open session",
    );
  }
  sourceFingerprint(input.outputFingerprint, "output fingerprint");
  if (
    !Array.isArray(input.intended) ||
    !Array.isArray(input.observed) ||
    JSON.stringify(input.intended) !== JSON.stringify(input.observed)
  ) {
    adapterError(
      NativeAdapterErrorCode.OBSERVED_DIFF_MISMATCH,
      "reopened observed diff does not match the intended change",
    );
  }
  if (
    input.intended.length !== proposal.operations.length ||
    input.intended.some(
      (change, index) =>
        change.operationId !== proposal.operations[index].operationId ||
        change.kind !== proposal.operations[index].kind,
    )
  ) {
    adapterError(
      NativeAdapterErrorCode.OBSERVED_DIFF_MISMATCH,
      "native change receipt does not cover every proposal operation",
    );
  }
  const preservation = plainRecord(
    input.preservation,
    "native preservation receipt",
  );
  for (const field of [
    "unsupportedObjects",
    "koreanText",
    "fontReferences",
    "blockSharing",
    "externalReferences",
    "layouts",
    "drawOrder",
  ]) {
    if (
      !["preserved", "not-present"].includes(preservation[field])
    ) {
      adapterError(
        NativeAdapterErrorCode.BACKEND_FAILED,
        `native preservation receipt lacks ${field}`,
      );
    }
  }
  const reopen = plainRecord(input.reopen, "native reopen receipt");
  if (
    reopen.validated !== true ||
    reopen.sourceVersion !== proposal.outputVersion ||
    typeof reopen.engineId !== "string"
  ) {
    adapterError(
      NativeAdapterErrorCode.BACKEND_FAILED,
      "native output did not pass independent reopen validation",
    );
  }
  const cleanup = validateCleanup(
    input.cleanup,
    descriptor.backendKind,
  );
  return Object.freeze({
    ...structuredClone(input),
    cleanup,
  });
}

export class NativeDocumentAdapterSession {
  #provider;
  #disposed = false;
  #disposePromise;
  #queryCount = 0;
  #writeAttempts = 0;
  #writes = 0;
  #progressSequence = 0;

  constructor(descriptor, provider) {
    this.descriptor = parseAdapterDescriptor(descriptor);
    this.#provider = assertProvider(provider);
  }

  get disposed() {
    return this.#disposed;
  }

  get state() {
    return Object.freeze({
      disposed: this.#disposed,
      queryCount: this.#queryCount,
      writeAttempts: this.#writeAttempts,
      writes: this.#writes,
    });
  }

  #assertOpen() {
    if (this.#disposed) {
      disposed();
    }
  }

  #assertSource(actual) {
    if (actual !== this.descriptor.sourceFingerprint) {
      adapterError(
        NativeAdapterErrorCode.STALE_SOURCE,
        "native document source fingerprint is stale",
        {
          expected: this.descriptor.sourceFingerprint,
          received: actual,
        },
      );
    }
  }

  #assertCapability(operation) {
    const capability = this.descriptor.capabilities[operation];
    if (!available(capability.status)) {
      adapterError(
        NativeAdapterErrorCode.CAPABILITY_BLOCKED,
        `native adapter operation ${operation} is not admitted`,
        {
          operation,
          status: capability.status,
          reason: capability.reason,
        },
      );
    }
    return capability;
  }

  #emitProgress(listener, operationId, phase, completed, total) {
    const event = Object.freeze({
      schema: "dwg-native-adapter-progress/1",
      protocol: NativeDocumentAdapterProtocol,
      sessionId: this.descriptor.sessionId,
      sequence: ++this.#progressSequence,
      operationId,
      phase,
      completed,
      total,
    });
    listener(event);
    return event;
  }

  async queryEntity(
    request,
    { signal, onProgress: progress } = {},
  ) {
    this.#assertOpen();
    this.#assertCapability(NativeAdapterOperation.QUERY_ENTITY);
    const onProgress = progressListener(progress);
    this.#emitProgress(
      onProgress,
      "query:entity",
      NativeAdapterProgressPhase.VALIDATING,
      0,
      2,
    );
    aborted(signal);
    const input = plainRecord(request, "native entity query");
    exactKeys(
      input,
      ["sourceFingerprint", "ref"],
      "native entity query",
    );
    const fingerprint = sourceFingerprint(input.sourceFingerprint);
    this.#assertSource(fingerprint);
    const reference = parseEntityReference(input.ref);
    this.#assertSource(reference.documentFingerprint);
    this.#emitProgress(
      onProgress,
      "query:entity",
      NativeAdapterProgressPhase.QUERYING,
      1,
      2,
    );
    const raw = await this.#provider.queryEntity(reference, {
      signal,
    });
    aborted(signal);
    this.#assertOpen();
    if (raw === null || raw === undefined) {
      adapterError(
        NativeAdapterErrorCode.STALE_ENTITY,
        "native entity reference is missing or stale",
        { handle: reference.handle },
      );
    }
    const entity = parseNativeEntity(raw);
    if (!matchesReference(entity.ref, reference)) {
      adapterError(
        NativeAdapterErrorCode.STALE_ENTITY,
        "native entity fingerprint or scope is stale",
        { handle: reference.handle },
      );
    }
    this.#queryCount += 1;
    this.#emitProgress(
      onProgress,
      "query:entity",
      NativeAdapterProgressPhase.COMPLETE,
      2,
      2,
    );
    return entity;
  }

  async queryRegion(
    request,
    { signal, onProgress: progress } = {},
  ) {
    this.#assertOpen();
    this.#assertCapability(NativeAdapterOperation.QUERY_REGION);
    const onProgress = progressListener(progress);
    this.#emitProgress(
      onProgress,
      "query:region",
      NativeAdapterProgressPhase.VALIDATING,
      0,
      2,
    );
    aborted(signal);
    const query = parseRegionRequest(request, this.descriptor);
    this.#assertSource(query.sourceFingerprint);
    const key = queryKey(query.bounds, query.types);
    let position = 0;
    if (query.cursor !== null) {
      const cursor = plainRecord(
        decodeBase64Url(query.cursor),
        "native query cursor",
      );
      if (
        cursor.sessionId !== this.descriptor.sessionId ||
        cursor.queryKey !== key ||
        !Number.isSafeInteger(cursor.position) ||
        cursor.position < 0
      ) {
        adapterError(
          NativeAdapterErrorCode.STALE_SOURCE,
          "native query cursor is outside the open source session",
        );
      }
      position = cursor.position;
    }
    this.#emitProgress(
      onProgress,
      "query:region",
      NativeAdapterProgressPhase.QUERYING,
      1,
      2,
    );
    const result = plainRecord(
      await this.#provider.queryRegion(
        Object.freeze({
          bounds: query.bounds,
          types: query.types,
          position,
          pageSize: query.pageSize,
        }),
        { signal },
      ),
      "native region query result",
    );
    aborted(signal);
    this.#assertOpen();
    if (
      !Array.isArray(result.entities) ||
      !Number.isSafeInteger(result.scannedEntries) ||
      result.scannedEntries < 0 ||
      !Number.isSafeInteger(result.unindexedEntries) ||
      result.unindexedEntries < 0 ||
      (result.nextPosition !== null &&
        (!Number.isSafeInteger(result.nextPosition) ||
          result.nextPosition <= position))
    ) {
      adapterError(
        NativeAdapterErrorCode.BACKEND_FAILED,
        "native query provider returned an invalid page",
      );
    }
    const entities = Object.freeze(
      result.entities.map(parseNativeEntity),
    );
    const nextCursor =
      result.nextPosition === null
        ? null
        : encodeBase64Url({
          sessionId: this.descriptor.sessionId,
          queryKey: key,
          position: result.nextPosition,
        });
    const response = Object.freeze({
      protocol: NativeDocumentAdapterProtocol,
      sessionId: this.descriptor.sessionId,
      sourceFingerprint: this.descriptor.sourceFingerprint,
      entities,
      nextCursor,
      scannedEntries: result.scannedEntries,
      unindexedEntries: result.unindexedEntries,
      complete: nextCursor === null,
    });
    if (
      new TextEncoder().encode(JSON.stringify(response)).byteLength >
      this.descriptor.limits.maximumQueryPayloadBytes
    ) {
      adapterError(
        NativeAdapterErrorCode.BUDGET_EXCEEDED,
        "native query response exceeds its payload budget",
      );
    }
    this.#queryCount += 1;
    this.#emitProgress(
      onProgress,
      "query:region",
      NativeAdapterProgressPhase.COMPLETE,
      2,
      2,
    );
    return response;
  }

  async applyProposal(
    value,
    { signal, onProgress: progress } = {},
  ) {
    this.#assertOpen();
    const onProgress = progressListener(progress);
    aborted(signal);
    this.#writeAttempts += 1;
    this.#emitProgress(
      onProgress,
      "proposal:apply",
      NativeAdapterProgressPhase.VALIDATING,
      0,
      3,
    );
    const proposal = parseChangeProposal(value, this.descriptor);
    this.#assertSource(proposal.sourceFingerprint);
    if (
      proposal.inputCapabilityId !==
        this.descriptor.inputCapabilityId ||
      proposal.outputCapabilityId ===
        this.descriptor.inputCapabilityId
    ) {
      adapterError(
        NativeAdapterErrorCode.OUTPUT_CONFLICT,
        "native writer requires a distinct registered output capability",
      );
    }
    this.#assertCapability(
      proposal.outputFormat === "dwg"
        ? NativeAdapterOperation.WRITE_DWG
        : NativeAdapterOperation.WRITE_DXF,
    );
    this.#assertCapability(NativeAdapterOperation.REOPEN_VALIDATE);
    this.#assertCapability(
      NativeAdapterOperation.PRESERVE_UNSUPPORTED,
    );
    for (const operation of proposal.operations) {
      this.#assertCapability(capabilityForChange(operation.kind));
      if (operation.target !== null) {
        const entity = await this.queryEntity({
          sourceFingerprint: proposal.sourceFingerprint,
          ref: operation.target,
        }, { signal });
        assertTargetType(operation.kind, entity);
      }
    }
    if (typeof this.#provider.applyAndReopen !== "function") {
      adapterError(
        NativeAdapterErrorCode.CAPABILITY_BLOCKED,
        "native writer implementation is absent",
      );
    }
    this.#emitProgress(
      onProgress,
      proposal.proposalId,
      NativeAdapterProgressPhase.WRITING,
      1,
      3,
    );
    const receipt = validateChangeReceipt(
      await this.#provider.applyAndReopen(proposal, {
        signal,
        onProgress,
      }),
      proposal,
      this.descriptor,
    );
    this.#emitProgress(
      onProgress,
      proposal.proposalId,
      NativeAdapterProgressPhase.REOPENING,
      2,
      3,
    );
    aborted(signal);
    this.#assertOpen();
    this.#writes += 1;
    this.#emitProgress(
      onProgress,
      proposal.proposalId,
      NativeAdapterProgressPhase.COMPLETE,
      3,
      3,
    );
    return receipt;
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#disposePromise = Promise.resolve()
        .then(() => this.#provider.dispose())
        .then((receipt) =>
          validateCleanup(receipt, this.descriptor.backendKind),
        );
    }
    return this.#disposePromise;
  }
}

export function createNativeDocumentAdapterSession(
  descriptor,
  provider,
) {
  return new NativeDocumentAdapterSession(descriptor, provider);
}
