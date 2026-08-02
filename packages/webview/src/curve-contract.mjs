export const CURVE_PIXEL_ERROR = 0.5;
export const CURVE_GEOMETRY_PIXEL_ERROR = 0.45;
export const CURVE_POSITION_PIXEL_ERROR = 0.05;
export const MAX_CURVE_REFINEMENT_GPU_BYTES = 32 * 1024 * 1024;
export const MAX_CURVE_REFINEMENT_BATCH_BYTES = 512 * 1024;
export const MAX_CURVE_SEGMENTS_PER_ENTITY = 65_536;

export function curveRefinementCameraKey(camera) {
  if (!camera) {
    return "";
  }
  return [
    ...camera.origin,
    camera.worldWidth,
    camera.worldHeight,
    camera.width,
    camera.height,
  ]
    .map((value) => Number(value).toPrecision(12))
    .join(":");
}
