import {
  decodeDwgRenderDeltaStyle,
  DwgRenderDeltaStyleFlag,
  DWG_RENDER_DELTA_STYLE_BYTES,
} from "../src/render-delta-style.mjs";

export function dwgRenderDeltaStyleBuffer({
  blockIndex = 1,
  instanceIndex = 0,
  handle = 0x2an,
  color = undefined,
  layerIndex = undefined,
  opacity = undefined,
  lineWeight = undefined,
  linetypeCode = undefined,
  visible = undefined,
} = {}) {
  const buffer = new ArrayBuffer(DWG_RENDER_DELTA_STYLE_BYTES);
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
  let flags = 0;
  if (color !== undefined) {
    flags |= DwgRenderDeltaStyleFlag.COLOR;
    view.setUint32(20, color, true);
  }
  if (layerIndex !== undefined) {
    flags |= DwgRenderDeltaStyleFlag.LAYER;
    view.setUint32(24, layerIndex, true);
  }
  if (opacity !== undefined) {
    flags |= DwgRenderDeltaStyleFlag.OPACITY;
    view.setFloat32(28, opacity, true);
  }
  if (lineWeight !== undefined) {
    flags |= DwgRenderDeltaStyleFlag.LINE_WEIGHT;
    view.setInt16(32, lineWeight, true);
  }
  if (linetypeCode !== undefined) {
    flags |= DwgRenderDeltaStyleFlag.LINETYPE;
    view.setUint16(34, linetypeCode, true);
  }
  if (visible !== undefined) {
    flags |= DwgRenderDeltaStyleFlag.VISIBILITY;
    view.setUint8(36, visible ? 1 : 0);
  }
  view.setUint32(16, flags, true);
  return buffer;
}

export function normalizedRenderDeltaStyleRecord(options) {
  const buffer = dwgRenderDeltaStyleBuffer(options);
  return Object.freeze({
    buffer,
    record: decodeDwgRenderDeltaStyle(buffer, {
      expectedHandle: options?.handle ?? 0x2an,
    }),
  });
}
