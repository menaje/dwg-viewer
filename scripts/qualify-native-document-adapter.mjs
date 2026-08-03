import { readFile } from "node:fs/promises";

import {
  MemoryRangeSource,
  SceneCacheReader,
  TrackedRangeSource,
} from "../packages/dwg-scene-source/src/index.mjs";
import {
  NativeAdapterErrorCode,
  NativeBackendKind,
  NativeDocumentAdapterProtocol,
  createNativeDocumentAdapterSession,
  validateNativeAdapterCompatibility,
} from "../packages/native-document-adapter/src/index.mjs";
import {
  compareNativeWasmCapabilities,
  runNativeDocumentAdapterConformance,
} from "../packages/native-document-adapter/src/conformance.mjs";
import {
  createSceneCacheNativeDescriptor,
  createSceneCacheNativeIndex,
} from "../packages/native-document-adapter/src/scene-cache-index.mjs";
import {
  ReferenceEntities,
  createReferenceSession,
} from "../packages/native-document-adapter/src/testing.mjs";

import {
  makeFixtureCache,
} from "../packages/webview/test/cache-fixture.mjs";

const fingerprint = `sha256:${"1".repeat(64)}`;
const manifest = JSON.parse(
  await readFile(
    new URL(
      "../compatibility/native-document-adapter.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const compatibility =
  validateNativeAdapterCompatibility(manifest);
const source = new TrackedRangeSource(
  new MemoryRangeSource(
    makeFixtureCache({ includeReviewCurves: true }),
  ),
);
const reader = await SceneCacheReader.open(source);
const provider = await createSceneCacheNativeIndex(reader, {
  sourceFingerprint: fingerprint,
  maximumReadBytes: 4096,
  maximumScanEntries: 4,
});
const nativeDescriptor = createSceneCacheNativeDescriptor({
  sourceFingerprint: fingerprint,
  inputCapabilityId: "capability:qualification-input",
});
const nativeSession = createNativeDocumentAdapterSession(
  nativeDescriptor,
  provider,
);
const entities = [];
let cursor = null;
let scannedEntries = 0;
let unindexedEntries = 0;
do {
  const page = await nativeSession.queryRegion({
    sourceFingerprint: fingerprint,
    bounds: {
      min: [-10_000, -10_000, -10_000],
      max: [10_000, 10_000, 10_000],
    },
    types: [],
    pageSize: 3,
    cursor,
  });
  entities.push(...page.entities);
  scannedEntries += page.scannedEntries;
  unindexedEntries += page.unindexedEntries;
  cursor = page.nextCursor;
} while (cursor !== null);
const resolved = await nativeSession.queryEntity({
  sourceFingerprint: fingerprint,
  ref: entities[0].ref,
});
let writerBlocked;
try {
  await nativeSession.applyProposal({
    protocol: NativeDocumentAdapterProtocol,
    proposalId: "proposal:qualification-blocked",
    sourceFingerprint: fingerprint,
    inputCapabilityId: "capability:qualification-input",
    outputCapabilityId: "capability:qualification-output",
    outputFormat: "dwg",
    outputVersion: "AC1032",
    operations: [],
  });
  throw new Error("unqualified product writer unexpectedly succeeded");
} catch (error) {
  if (
    error?.code !==
    NativeAdapterErrorCode.CAPABILITY_BLOCKED
  ) {
    throw error;
  }
  writerBlocked = Object.freeze({
    beforeOutputReservation: true,
    code: error.code,
  });
}
const nativeCleanup = await nativeSession.dispose();
await source.dispose();

const writerReference =
  await runNativeDocumentAdapterConformance(async () => {
    const fixture = createReferenceSession({ writer: true });
    return {
      session: fixture.session,
      entities: ReferenceEntities,
    };
  });
const blockedReference =
  await runNativeDocumentAdapterConformance(async () => {
    const fixture = createReferenceSession({ writer: false });
    return {
      session: fixture.session,
      entities: ReferenceEntities,
    };
  });
const wasmDescriptor = createSceneCacheNativeDescriptor({
  sourceFingerprint: fingerprint,
  inputCapabilityId: "capability:qualification-wasm-input",
  backendId: "backend:libredwg-wasm-memfs",
  backendKind: NativeBackendKind.WASM_WORKER,
});

console.log(JSON.stringify({
  schema: "dwg-native-document-adapter-qualification/1",
  status: "passed-query-preview-writer-blocked",
  asOf: new Date().toISOString(),
  compatibility,
  nativeQuery: {
    descriptor: {
      protocol: nativeDescriptor.protocol,
      adapterId: nativeDescriptor.adapterId,
      engineId: nativeDescriptor.engineId,
      engineVersion: nativeDescriptor.engineVersion,
      backendId: nativeDescriptor.backendId,
      backendKind: nativeDescriptor.backendKind,
    },
    index: provider.state,
    rangeSource: source.snapshot(),
    scannedEntries,
    unindexedEntries,
    returnedEntities: entities.length,
    resolvedHandle: resolved.ref.handle,
    exactBounds: entities.filter(
      (entity) => entity.boundsPrecision === "exact",
    ).length,
    conservativeBounds: entities.filter(
      (entity) =>
        entity.boundsPrecision === "conservative",
    ).length,
    writerBlocked,
    cleanup: nativeCleanup,
  },
  referenceWriter: writerReference,
  blockedWriter: blockedReference.writer,
  nativeWasm: compareNativeWasmCapabilities(
    nativeDescriptor,
    wasmDescriptor,
  ),
  productDecision: {
    native: "query-preview",
    writer: "blocked",
    wasm: "rejected",
  },
}, null, 2));
