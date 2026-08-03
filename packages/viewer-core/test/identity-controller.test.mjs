import assert from "node:assert/strict";
import test from "node:test";

import {
  ViewerHostEventType,
  ViewerIdentityController,
  openRenderSource,
} from "../src/index.mjs";
import {
  MockServicePickFixture,
  MockServiceRenderSource,
} from "../src/testing.mjs";

test("resolves service identity and publishes opaque context and reveal events", async () => {
  const events = [];
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const controller = new ViewerIdentityController({
    host: {
      handleEvent(event) {
        events.push(event);
      },
      dispose() {},
    },
    sourceSession,
    snapshot,
  });

  const identity = await controller.resolvePick({
    ...MockServicePickFixture,
  });
  const contextDetail = await controller.requestContext(identity, {
    reason: "inspector.open",
  });
  const revealDetail = await controller.requestSourceReveal(identity, {
    reason: "inspector.reveal",
  });

  assert.equal(identity.externalIdentityToken, "external:service:entity:42");
  assert.deepEqual(
    snapshot.layers.map((layer) => layer.kind),
    ["base", "live"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    [
      ViewerHostEventType.CONTEXT_REQUEST,
      ViewerHostEventType.SOURCE_REVEAL,
    ],
  );
  assert.equal(contextDetail.sequence, 1);
  assert.equal(contextDetail.context.contextId, "context:service:entity:42");
  assert.equal(revealDetail.sequence, 2);
  assert.equal(revealDetail.reveal.revealId, "reveal:service:entity:42");
  assert.equal(revealDetail.reveal.label, "원본에서 보기");
  assert.equal(events[0].detail.revisionId, snapshot.revisionId);
  assert.equal(events[1].detail.layerId, MockServicePickFixture.layerId);
  assert(Object.isFrozen(events[0]));
  assert(Object.isFrozen(events[0].detail));
  assert.doesNotMatch(
    JSON.stringify(events),
    /(?:file:|[A-Za-z]:[\\/]|\/tmp\/)/u,
  );

  assert.equal(controller.dispose(), true);
  assert.equal(controller.dispose(), false);
  await assert.rejects(
    controller.requestContext(identity),
    /disposed/u,
  );
  await sourceSession.dispose();
});

test("rejects source-specific fields in a projected pick", async () => {
  const source = new MockServiceRenderSource();
  const sourceSession = await openRenderSource(source);
  const snapshot = await sourceSession.getSnapshot();
  const controller = new ViewerIdentityController({
    host: {
      handleEvent() {},
      dispose() {},
    },
    sourceSession,
    snapshot,
  });

  await assert.rejects(
    controller.resolvePick({
      ...MockServicePickFixture,
      workspaceId: "workspace:private",
    }),
    /unknown fields/u,
  );

  controller.dispose();
  await sourceSession.dispose();
});
