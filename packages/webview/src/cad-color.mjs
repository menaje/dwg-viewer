const ACI_HUES = Object.freeze([
  [255, 0, 0],
  [255, 63, 0],
  [255, 127, 0],
  [255, 191, 0],
  [255, 255, 0],
  [191, 255, 0],
  [127, 255, 0],
  [63, 255, 0],
  [0, 255, 0],
  [0, 255, 63],
  [0, 255, 127],
  [0, 255, 191],
  [0, 255, 255],
  [0, 191, 255],
  [0, 127, 255],
  [0, 63, 255],
  [0, 0, 255],
  [63, 0, 255],
  [127, 0, 255],
  [191, 0, 255],
  [255, 0, 255],
  [255, 0, 191],
  [255, 0, 127],
  [255, 0, 63],
]);
const ACI_LEVELS = Object.freeze([255, 165, 127, 76, 38]);
const DEFAULT_ENTITY_COLOR = Object.freeze([255, 255, 255]);
const TRANSPARENCY_SHIFT = 24;
const TRANSPARENCY_MASK = 0x3f;
const TRANSPARENCY_EXPLICIT_BASE = 3;
const TRANSPARENCY_EXPLICIT_STEPS =
  TRANSPARENCY_MASK - TRANSPARENCY_EXPLICIT_BASE;

function buildDefaultAciPalette() {
  const palette = new Uint8Array(256 * 4);
  const set = (index, red, green, blue) => {
    palette.set([red, green, blue, 255], index * 4);
  };
  set(0, 0, 0, 0);
  set(1, 255, 0, 0);
  set(2, 255, 255, 0);
  set(3, 0, 255, 0);
  set(4, 0, 255, 255);
  set(5, 0, 0, 255);
  set(6, 255, 0, 255);
  set(7, 255, 255, 255);
  set(8, 128, 128, 128);
  set(9, 192, 192, 192);
  for (let index = 10; index < 250; index += 1) {
    const offset = index - 10;
    const hue = ACI_HUES[Math.floor(offset / 10)];
    const shade = offset % 10;
    const level = ACI_LEVELS[Math.floor(shade / 2)];
    const saturated = hue.map((value) =>
      Math.round((value / 255) * level),
    );
    const color =
      shade % 2 === 0
        ? saturated
        : saturated.map((value) => Math.floor((value + level) / 2));
    set(index, color[0], color[1], color[2]);
  }
  for (const [index, level] of [
    [250, 51],
    [251, 80],
    [252, 105],
    [253, 130],
    [254, 190],
    [255, 255],
  ]) {
    set(index, level, level, level);
  }
  return palette;
}

export const DEFAULT_ACI_PALETTE = buildDefaultAciPalette();

export function aciRgb(index, palette = DEFAULT_ACI_PALETTE) {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index > 255 ||
    !(palette instanceof Uint8Array) ||
    palette.length !== 256 * 4
  ) {
    return [...DEFAULT_ENTITY_COLOR];
  }
  const offset = index * 4;
  return [palette[offset], palette[offset + 1], palette[offset + 2]];
}

export function cadColorAci(encoded) {
  const unsigned = encoded >>> 0;
  return unsigned >>> 30 === 2 ? unsigned & 255 : 0;
}

export function decodeCadColor(
  encoded,
  {
    layer = null,
    byBlock = null,
    palette = DEFAULT_ACI_PALETTE,
  } = {},
) {
  const unsigned = encoded >>> 0;
  const kind = unsigned >>> 30;
  if (kind === 0 && layer) {
    return decodeCadColor(layer.color, {
      byBlock,
      palette,
    });
  }
  if (kind === 1) {
    return byBlock ? [...byBlock] : [...DEFAULT_ENTITY_COLOR];
  }
  if (kind === 2) {
    return aciRgb(unsigned & 255, palette);
  }
  if (kind === 3) {
    return [
      (unsigned >>> 16) & 255,
      (unsigned >>> 8) & 255,
      unsigned & 255,
    ];
  }
  return [...DEFAULT_ENTITY_COLOR];
}

export function cadOpacityCode(encoded) {
  return (encoded >>> TRANSPARENCY_SHIFT) & TRANSPARENCY_MASK;
}

export function decodeCadOpacity(
  encoded,
  {
    layer = 1,
    byBlock = 1,
  } = {},
) {
  const code = cadOpacityCode(encoded);
  if (code === 0) {
    return 1;
  }
  if (code === 1) {
    return Number.isFinite(layer)
      ? Math.max(0, Math.min(1, layer))
      : 1;
  }
  if (code === 2) {
    return Number.isFinite(byBlock)
      ? Math.max(0, Math.min(1, byBlock))
      : 1;
  }
  return Math.max(
    0,
    Math.min(
      1,
      (code - TRANSPARENCY_EXPLICIT_BASE) /
        TRANSPARENCY_EXPLICIT_STEPS,
    ),
  );
}

export function copyAciPalette(
  palette = DEFAULT_ACI_PALETTE,
  alpha = 255,
) {
  if (
    !(palette instanceof Uint8Array) ||
    palette.length !== 256 * 4 ||
    !Number.isInteger(alpha) ||
    alpha < 0 ||
    alpha > 255
  ) {
    throw new TypeError("ACI palette payload is invalid");
  }
  const copy = new Uint8Array(palette);
  for (let index = 0; index < 256; index += 1) {
    copy[index * 4 + 3] = alpha;
  }
  return copy;
}
