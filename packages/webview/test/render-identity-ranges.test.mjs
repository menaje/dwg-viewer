import assert from "node:assert/strict";
import test from "node:test";

import {
  appendRenderIdentityRange,
  packRenderIdentityRanges,
  validateRenderIdentityRanges,
} from "../src/render-identity-ranges.mjs";

test("packs contiguous render identity ranges and merges adjacent handles", () => {
  const ranges = [];
  appendRenderIdentityRange(ranges, 0x1_0000_002an, 0, 2);
  appendRenderIdentityRange(ranges, 0x1_0000_002an, 2, 2);
  appendRenderIdentityRange(ranges, 0x2bn, 4, 2);

  const packed = packRenderIdentityRanges(ranges, 6);

  assert.equal(packed.count, 2);
  assert.deepEqual(
    [...packed.data],
    [
      0, 4, 0x2a, 1,
      4, 2, 0x2b, 0,
    ],
  );
  assert.equal(
    validateRenderIdentityRanges(packed, {
      vertexCount: 6,
      verticesPerPrimitive: 2,
    }),
    packed,
  );
});

test("accepts an empty identity map and rejects gaps or split primitives", () => {
  const empty = packRenderIdentityRanges([], 0);
  assert.equal(
    validateRenderIdentityRanges(empty, {
      vertexCount: 0,
      verticesPerPrimitive: 3,
    }),
    empty,
  );

  assert.throws(
    () =>
      validateRenderIdentityRanges(
        {
          data: new Uint32Array([
            0, 3, 0x2a, 0,
            4, 2, 0x2b, 0,
          ]),
          count: 2,
        },
        {
          vertexCount: 6,
          verticesPerPrimitive: 1,
        },
      ),
    /not contiguous/u,
  );
  assert.throws(
    () =>
      validateRenderIdentityRanges(
        {
          data: new Uint32Array([
            0, 2, 0x2a, 0,
            2, 4, 0x2b, 0,
          ]),
          count: 2,
        },
        {
          vertexCount: 6,
          verticesPerPrimitive: 3,
        },
      ),
    /not contiguous/u,
  );
});

test("rejects discontinuous input and handles outside u64", () => {
  const ranges = [];
  appendRenderIdentityRange(ranges, 0x2an, 0, 2);

  assert.throws(
    () => appendRenderIdentityRange(ranges, 0x2bn, 3, 2),
    /contiguous and ordered/u,
  );
  assert.throws(
    () => appendRenderIdentityRange([], -1n, 0, 2),
    /u64 handle/u,
  );
  assert.throws(
    () => packRenderIdentityRanges(ranges, 3),
    /cover every vertex/u,
  );
});
