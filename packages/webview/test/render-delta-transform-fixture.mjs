import {
  decodeDwgRenderDeltaTransform,
  DWG_RENDER_DELTA_TRANSFORM_BYTES,
} from "../src/render-delta-transform.mjs";

export function translatedTransformMatrix(
  x = 0,
  y = 0,
  z = 0,
) {
  return Object.freeze([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ]);
}

export function dwgRenderDeltaTransformBuffer({
  blockIndex = 1,
  instanceIndex = 0,
  handle = 0x2an,
  matrix = translatedTransformMatrix(10, 20, 0),
  measurementMatrix = matrix,
} = {}) {
  const buffer = new ArrayBuffer(
    DWG_RENDER_DELTA_TRANSFORM_BYTES,
  );
  const view = new DataView(buffer);
  const normalizedHandle =
    typeof handle === "bigint" ? handle : BigInt(handle);
  view.setUint32(0, blockIndex, true);
  view.setUint32(4, instanceIndex, true);
  view.setUint32(
    8,
    Number(normalizedHandle & 0xffff_ffffn),
    true,
  );
  view.setUint32(12, Number(normalizedHandle >> 32n), true);
  for (let index = 0; index < 16; index += 1) {
    view.setFloat64(16 + index * 8, matrix[index], true);
    view.setFloat64(
      16 + 16 * 8 + index * 8,
      measurementMatrix[index],
      true,
    );
  }
  return buffer;
}

export function normalizedRenderDeltaTransformRecord(options) {
  const buffer = dwgRenderDeltaTransformBuffer(options);
  return Object.freeze({
    buffer,
    record: decodeDwgRenderDeltaTransform(buffer, {
      expectedHandle: options?.handle ?? 0x2an,
    }),
  });
}
