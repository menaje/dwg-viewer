import {
  AllNativeAdapterOperations,
  NativeAdapterOperation,
  NativeBackendKind,
  NativeCapabilityStatus,
  NativeChangeKind,
  NativeDocumentAdapterProtocol,
  NativeQueryLimits,
} from "./constants.mjs";
import {
  createNativeDocumentAdapterSession,
} from "./session.mjs";

export const ReferenceSourceFingerprint =
  `sha256:${"a".repeat(64)}`;
export const ReferenceOutputFingerprint =
  `sha256:${"d".repeat(64)}`;

function referenceEntity({
  handle,
  fingerprintCharacter,
  type,
  min,
  max,
  summary,
}) {
  return Object.freeze({
    ref: Object.freeze({
      documentFingerprint: ReferenceSourceFingerprint,
      spaceId: "space:model",
      nestedInstancePath: Object.freeze([]),
      handle,
      entityFingerprint:
        `sha256:${fingerprintCharacter.repeat(64)}`,
    }),
    type,
    layerIndex: 0,
    bounds: Object.freeze({
      min: Object.freeze(min),
      max: Object.freeze(max),
    }),
    boundsPrecision: "exact",
    summary: Object.freeze(summary),
  });
}

export const ReferenceEntities = Object.freeze([
  referenceEntity({
    handle: "handle:10",
    fingerprintCharacter: "b",
    type: "LINE",
    min: [0, 0, 0],
    max: [10, 0, 0],
    summary: {
      start: [0, 0, 0],
      end: [10, 0, 0],
    },
  }),
  referenceEntity({
    handle: "handle:20",
    fingerprintCharacter: "c",
    type: "TEXT",
    min: [2, 2, 0],
    max: [6, 4, 0],
    summary: {
      value: "원본",
      style: "고딕",
    },
  }),
]);

function intersects(left, right) {
  return left.min.every(
    (minimum, axis) =>
      minimum <= right.max[axis] &&
      left.max[axis] >= right.min[axis],
  );
}

function cleanup(backendKind) {
  return Object.freeze({
    remainingTemporaryFiles: 0,
    remainingOutputReservations: 0,
    processExited:
      backendKind !== NativeBackendKind.WASM_WORKER,
    workerTerminated:
      backendKind === NativeBackendKind.WASM_WORKER,
  });
}

export class InMemoryNativeDocumentProvider {
  #entities;
  #backendKind;
  #writer;
  #mismatchObserved;
  #disposed = false;
  #writeCalls = 0;

  constructor({
    entities = ReferenceEntities,
    backendKind = NativeBackendKind.REFERENCE,
    writer = false,
    mismatchObserved = false,
  } = {}) {
    this.#entities = Object.freeze([...entities]);
    this.#backendKind = backendKind;
    this.#writer = writer;
    this.#mismatchObserved = mismatchObserved;
  }

  get state() {
    return Object.freeze({
      disposed: this.#disposed,
      writeCalls: this.#writeCalls,
    });
  }

  async queryEntity(reference) {
    if (this.#disposed) {
      throw new Error("reference native provider is disposed");
    }
    return (
      this.#entities.find(
        (entity) =>
          entity.ref.handle === reference.handle &&
          entity.ref.spaceId === reference.spaceId,
      ) ?? null
    );
  }

  async queryRegion({
    bounds,
    types,
    position,
    pageSize,
  }) {
    if (this.#disposed) {
      throw new Error("reference native provider is disposed");
    }
    const acceptedTypes = new Set(types);
    const matches = this.#entities.filter(
      (entity) =>
        (acceptedTypes.size === 0 ||
          acceptedTypes.has(entity.type)) &&
        intersects(entity.bounds, bounds),
    );
    const entities = matches.slice(position, position + pageSize);
    const nextPosition =
      position + entities.length < matches.length
        ? position + entities.length
        : null;
    return Object.freeze({
      entities: Object.freeze(entities),
      nextPosition,
      scannedEntries: entities.length,
      unindexedEntries: 0,
    });
  }

  async applyAndReopen(proposal) {
    if (!this.#writer) {
      throw new Error("reference writer is disabled");
    }
    this.#writeCalls += 1;
    const intended = proposal.operations.map((operation) =>
      Object.freeze({
        operationId: operation.operationId,
        kind: operation.kind,
        targetHandle: operation.target?.handle ?? null,
      }),
    );
    const observed = structuredClone(intended);
    if (this.#mismatchObserved && observed.length > 0) {
      observed[0].kind = NativeChangeKind.LINE_MOVE;
    }
    return Object.freeze({
      schema: "dwg-native-change-receipt/1",
      status: "validated",
      protocol: NativeDocumentAdapterProtocol,
      proposalId: proposal.proposalId,
      adapterId: "adapter:reference-native-document",
      backendId: "backend:reference",
      sourceFingerprint: ReferenceSourceFingerprint,
      outputFingerprint: ReferenceOutputFingerprint,
      outputCapabilityId: proposal.outputCapabilityId,
      outputFormat: proposal.outputFormat,
      outputVersion: proposal.outputVersion,
      intended: Object.freeze(intended),
      observed: Object.freeze(observed),
      preservation: Object.freeze({
        unsupportedObjects: "not-present",
        koreanText: "preserved",
        fontReferences: "preserved",
        blockSharing: "preserved",
        externalReferences: "not-present",
        layouts: "preserved",
        drawOrder: "preserved",
      }),
      reopen: Object.freeze({
        validated: true,
        engineId: "engine:independent-reference",
        sourceVersion: proposal.outputVersion,
      }),
      cleanup: cleanup(this.#backendKind),
    });
  }

  async dispose() {
    this.#disposed = true;
    return cleanup(this.#backendKind);
  }
}

function capability(status, reason) {
  return Object.freeze({ status, reason });
}

export function createReferenceDescriptor({
  writer = false,
  backendKind = NativeBackendKind.REFERENCE,
} = {}) {
  const capabilities = Object.fromEntries(
    AllNativeAdapterOperations.map((operation) => [
      operation,
      capability(
        writer
          ? NativeCapabilityStatus.NATIVE
          : NativeCapabilityStatus.BLOCKED,
        writer
          ? "reference conformance operation"
          : "writer-disabled reference operation",
      ),
    ]),
  );
  for (const operation of [
    NativeAdapterOperation.READ,
    NativeAdapterOperation.QUERY_ENTITY,
    NativeAdapterOperation.QUERY_REGION,
  ]) {
    capabilities[operation] = capability(
      NativeCapabilityStatus.NATIVE,
      "bounded reference query",
    );
  }
  return Object.freeze({
    protocol: NativeDocumentAdapterProtocol,
    sessionId: "session:reference-native-document",
    adapterId: "adapter:reference-native-document",
    adapterVersion: "0.1.0",
    engineId: "engine:reference",
    engineVersion: "1.0.0",
    backendId: "backend:reference",
    backendKind,
    license: "MPL-2.0 test fixture",
    sourceFingerprint: ReferenceSourceFingerprint,
    inputCapabilityId: "capability:input-reference",
    sourceVersion: "AC1032",
    outputVersions: Object.freeze(["AC1032"]),
    capabilities: Object.freeze(capabilities),
    limits: Object.freeze({
      maximumPageSize: 1,
      maximumQueryPayloadBytes:
        NativeQueryLimits.maximumQueryPayloadBytes,
      maximumProposalBytes:
        NativeQueryLimits.maximumProposalBytes,
      maximumProposalOperations:
        NativeQueryLimits.maximumProposalOperations,
    }),
  });
}

export function createReferenceSession(options = {}) {
  const provider = new InMemoryNativeDocumentProvider(options);
  return Object.freeze({
    provider,
    session: createNativeDocumentAdapterSession(
      createReferenceDescriptor(options),
      provider,
    ),
  });
}
