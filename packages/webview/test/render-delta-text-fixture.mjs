import {
  decodeDwgRenderDeltaText,
} from "../src/render-delta-text.mjs";

export function renderDeltaTextRecord(overrides = {}) {
  return {
    handle: "2a",
    ownerHandle: "0",
    layerIndex: 0,
    color: ((2 << 30) | 2) >>> 0,
    lineWeight: -3,
    commonFlags: 0,
    linetypeCode: 2,
    kind: 0,
    flags: 0,
    style: null,
    value: "변경된 문자",
    tag: "",
    prompt: "",
    linkedHandle: "0",
    insertionPoint: [0.5, 0.5, 0],
    alignmentPoint: [0.5, 0.5, 0],
    normal: [0, 0, 1],
    xAxisDirection: [1, 0, 0],
    height: 1,
    widthFactor: 1,
    rotation: 0,
    obliqueAngle: 0,
    thickness: 0,
    rectangleWidth: 0,
    rectangleHeight: 0,
    extentsWidth: 0,
    extentsHeight: 0,
    lineSpacingFactor: 1,
    backgroundScale: 1.5,
    backgroundColor: 0,
    backgroundTransparency: 0,
    backgroundFlags: 0,
    sourceFlags: 0,
    horizontalAlignment: 0,
    verticalAlignment: 0,
    attachment: 0,
    flowDirection: 0,
    lineSpacingStyle: 0,
    generationFlags: 0,
    fieldLength: 0,
    mtextType: 0,
    lineCount: 1,
    columnType: 0,
    columnCount: 0,
    columnFlags: 0,
    columnWidth: 0,
    columnGutter: 0,
    columnHeights: [],
    ...overrides,
  };
}

export function renderDeltaTextBuffer(overrides = {}) {
  return new TextEncoder().encode(
    JSON.stringify(renderDeltaTextRecord(overrides)),
  ).buffer;
}

export function normalizedRenderDeltaTextRecord(overrides = {}) {
  const buffer = renderDeltaTextBuffer(overrides);
  return Object.freeze({
    buffer,
    record: decodeDwgRenderDeltaText(buffer),
  });
}
