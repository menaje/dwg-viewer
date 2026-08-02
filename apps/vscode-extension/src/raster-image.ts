export const MAX_IMAGE_REFERENCE_PIXELS = 100_000_000;

export interface RasterImageMetadata {
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

function pngMetadata(bytes: Uint8Array): RasterImageMetadata | undefined {
  if (
    bytes.byteLength < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a ||
    bytes[8] !== 0x00 ||
    bytes[9] !== 0x00 ||
    bytes[10] !== 0x00 ||
    bytes[11] !== 0x0d ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0
    ? { mimeType: "image/png", width, height }
    : undefined;
}

function jpegMetadata(bytes: Uint8Array): RasterImageMetadata | undefined {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    return undefined;
  }
  const startOfFrameMarkers = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.byteLength) {
      break;
    }
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= bytes.byteLength) {
      break;
    }
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (
      segmentLength < 2 ||
      offset + segmentLength > bytes.byteLength
    ) {
      break;
    }
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0
        ? { mimeType: "image/jpeg", width, height }
        : undefined;
    }
    offset += segmentLength;
  }
  return undefined;
}

export function inspectRasterImage(
  bytes: Uint8Array,
): RasterImageMetadata {
  const metadata = pngMetadata(bytes) ?? jpegMetadata(bytes);
  if (!metadata) {
    throw new Error("지원하는 JPG 또는 PNG 이미지가 아닙니다.");
  }
  const pixels = metadata.width * metadata.height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels <= 0 ||
    pixels > MAX_IMAGE_REFERENCE_PIXELS
  ) {
    throw new Error("이미지 해상도가 안전 한도를 초과합니다.");
  }
  return metadata;
}
