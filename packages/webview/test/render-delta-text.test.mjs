import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeDwgRenderDeltaText,
  dwgRenderDeltaTextByteLength,
  isNormalizedDwgRenderDeltaTextRecord,
  MAX_DWG_RENDER_DELTA_TEXT_BYTES,
} from "../src/render-delta-text.mjs";
import {
  renderDeltaTextBuffer,
  renderDeltaTextRecord,
} from "./render-delta-text-fixture.mjs";

test("decodes a bounded native text record with immutable style data", () => {
  const buffer = renderDeltaTextBuffer({
    value: "배관 점검",
    style: {
      handle: "10",
      name: "한글 스타일",
      fontFile: "romans.shx",
      bigFontFile: "whgtxt.shx",
      trueTypeFont: "",
      flags: 0,
      height: 0,
      widthFactor: 0.8,
      obliqueAngle: 0,
      lastHeight: 2.5,
    },
  });
  const record = decodeDwgRenderDeltaText(
    buffer,
    { expectedHandle: 0x2an },
  );

  assert.equal(isNormalizedDwgRenderDeltaTextRecord(record), true);
  assert.equal(record.handle, 0x2an);
  assert.equal(record.value, "배관 점검");
  assert.equal(record.valueByteLength, 13);
  assert.equal(record.style.handle, 0x10n);
  assert.equal(record.style.bigFontFile, "whgtxt.shx");
  assert.equal(dwgRenderDeltaTextByteLength(record), buffer.byteLength);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.style), true);
});

test("rejects malformed, cross-identity, and non-canonical text JSON", () => {
  assert.throws(
    () =>
      decodeDwgRenderDeltaText(
        new TextEncoder().encode("{").buffer,
      ),
    /text JSON is invalid/u,
  );
  assert.throws(
    () =>
      decodeDwgRenderDeltaText(renderDeltaTextBuffer(), {
        expectedHandle: 0x2bn,
      }),
    /another Render ID/u,
  );
  const extra = renderDeltaTextRecord();
  extra.privatePath = "/tmp/drawing.dwg";
  assert.throws(
    () =>
      decodeDwgRenderDeltaText(
        new TextEncoder().encode(JSON.stringify(extra)).buffer,
      ),
    /invalid shape/u,
  );
});

test("rejects a native text record above its private byte bound", () => {
  assert.throws(
    () =>
      decodeDwgRenderDeltaText(
        new ArrayBuffer(MAX_DWG_RENDER_DELTA_TEXT_BYTES + 1),
      ),
    /text buffer is invalid/u,
  );
});
