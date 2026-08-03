import {
  NativeAdapterErrorCode,
  NativeAdapterOperation,
  NativeChangeKind,
  NativeDocumentAdapterProtocol,
} from "./constants.mjs";

async function expectCode(operation, code, label) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === code) {
      return Object.freeze({
        label,
        rejected: true,
        code,
      });
    }
    throw new Error(
      `${label} returned ${error?.code ?? error?.name ?? "unknown"}`,
      { cause: error },
    );
  }
  throw new Error(`${label} did not fail closed`);
}

function changeProposal({
  entity,
  outputCapabilityId,
  operations,
  proposalId,
}) {
  return Object.freeze({
    protocol: NativeDocumentAdapterProtocol,
    proposalId,
    sourceFingerprint: entity.ref.documentFingerprint,
    inputCapabilityId: "capability:input-reference",
    outputCapabilityId,
    outputFormat: "dwg",
    outputVersion: "AC1032",
    operations: Object.freeze(operations),
  });
}

export async function runNativeDocumentAdapterConformance(
  createFixture,
) {
  if (typeof createFixture !== "function") {
    throw new TypeError(
      "native document conformance requires a fixture factory",
    );
  }
  const fixture = await createFixture();
  const { session, entities } = fixture;
  if (
    !session ||
    !Array.isArray(entities) ||
    entities.length < 2
  ) {
    throw new TypeError(
      "native document fixture requires a session and two entities",
    );
  }
  const sourceFingerprint =
    session.descriptor.sourceFingerprint;
  const first = await session.queryEntity({
    sourceFingerprint,
    ref: entities[0].ref,
  });
  const page1 = await session.queryRegion({
    sourceFingerprint,
    bounds: {
      min: [-100, -100, -100],
      max: [100, 100, 100],
    },
    types: [],
    pageSize: 1,
    cursor: null,
  });
  const page2 = await session.queryRegion({
    sourceFingerprint,
    bounds: {
      min: [-100, -100, -100],
      max: [100, 100, 100],
    },
    types: [],
    pageSize: 1,
    cursor: page1.nextCursor,
  });
  const staleSource = await expectCode(
    () => session.queryEntity({
      sourceFingerprint: `sha256:${"0".repeat(64)}`,
      ref: entities[0].ref,
    }),
    NativeAdapterErrorCode.STALE_SOURCE,
    "stale native source",
  );
  const staleEntity = await expectCode(
    () => session.queryEntity({
      sourceFingerprint,
      ref: {
        ...entities[0].ref,
        entityFingerprint: `sha256:${"0".repeat(64)}`,
      },
    }),
    NativeAdapterErrorCode.STALE_ENTITY,
    "stale native entity",
  );
  const outputConflict = await expectCode(
    () => session.applyProposal(
      changeProposal({
        entity: first,
        outputCapabilityId:
          session.descriptor.inputCapabilityId,
        proposalId: "proposal:output-conflict",
        operations: [],
      }),
    ),
    NativeAdapterErrorCode.OUTPUT_CONFLICT,
    "native original overwrite",
  );

  const writerAdmitted =
    session.descriptor.capabilities[
      NativeAdapterOperation.WRITE_DWG
    ].status === "native" ||
    session.descriptor.capabilities[
      NativeAdapterOperation.WRITE_DWG
    ].status === "mapped";
  let writer;
  if (writerAdmitted) {
    const noop = await session.applyProposal(
      changeProposal({
        entity: first,
        outputCapabilityId: "capability:output-noop",
        proposalId: "proposal:noop-save-as",
        operations: [],
      }),
    );
    const changed = await session.applyProposal(
      changeProposal({
        entity: first,
        outputCapabilityId: "capability:output-change",
        proposalId: "proposal:line-move",
        operations: [
          Object.freeze({
            operationId: "operation:line-move",
            kind: NativeChangeKind.LINE_MOVE,
            target: first.ref,
            payload: Object.freeze({
              translation: Object.freeze([1, 2, 0]),
            }),
          }),
        ],
      }),
    );
    writer = Object.freeze({
      admitted: true,
      noopReopened: noop.reopen.validated,
      changeObserved:
        changed.observed.length === 1 &&
        changed.observed[0].kind === NativeChangeKind.LINE_MOVE,
      cleanup: changed.cleanup,
    });
  } else {
    const blocked = await expectCode(
      () => session.applyProposal(
        changeProposal({
          entity: first,
          outputCapabilityId: "capability:output-blocked",
          proposalId: "proposal:blocked-writer",
          operations: [],
        }),
      ),
      NativeAdapterErrorCode.CAPABILITY_BLOCKED,
      "unqualified native writer",
    );
    writer = Object.freeze({
      admitted: false,
      blockedBeforeWrite: blocked,
    });
  }
  const cleanup = await session.dispose();
  await session.dispose();
  const disposedQuery = await expectCode(
    () => session.queryEntity({
      sourceFingerprint,
      ref: entities[0].ref,
    }),
    NativeAdapterErrorCode.SOURCE_DISPOSED,
    "disposed native session",
  );
  return Object.freeze({
    schema: "dwg-native-document-conformance/1",
    protocol: session.descriptor.protocol,
    adapterId: session.descriptor.adapterId,
    backendId: session.descriptor.backendId,
    backendKind: session.descriptor.backendKind,
    sourceFingerprint,
    query: Object.freeze({
      entityHandle: first.ref.handle,
      pages: page2.nextCursor === null ? 2 : 3,
      returnedEntities:
        page1.entities.length + page2.entities.length,
      staleSource,
      staleEntity,
    }),
    writer,
    safety: Object.freeze({
      outputConflict,
      disposedQuery,
      cleanup,
    }),
  });
}

export function compareNativeWasmCapabilities(
  nativeDescriptor,
  wasmDescriptor,
) {
  const operations = {};
  for (const operation of Object.values(NativeAdapterOperation)) {
    const native = nativeDescriptor.capabilities[operation];
    const wasm = wasmDescriptor.capabilities[operation];
    operations[operation] = Object.freeze({
      native: native.status,
      wasm: wasm.status,
      equal: native.status === wasm.status,
      nativeReason: native.reason,
      wasmReason: wasm.reason,
    });
  }
  return Object.freeze({
    schema: "dwg-native-wasm-capability-comparison/1",
    protocol: NativeDocumentAdapterProtocol,
    nativeBackend: nativeDescriptor.backendId,
    wasmBackend: wasmDescriptor.backendId,
    operations: Object.freeze(operations),
    productBackend:
      nativeDescriptor.capabilities[
        NativeAdapterOperation.QUERY_ENTITY
      ].status === "mapped"
        ? nativeDescriptor.backendId
        : null,
    wasmProductAdmitted: Object.values(
      wasmDescriptor.capabilities,
    ).every((capability) =>
      ["native", "mapped"].includes(capability.status),
    ),
  });
}
