export const CAD_LINE_WEIGHTS = Object.freeze([
  -3, -2, -1, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40,
  50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211,
]);

export function encodeCadLineStyle({
  lineWeight = -1,
  linetypeCode = 2,
  invisible = false,
} = {}) {
  let lineWeightCode = CAD_LINE_WEIGHTS.indexOf(lineWeight);
  if (lineWeightCode < 0) {
    lineWeightCode = CAD_LINE_WEIGHTS.indexOf(-1);
  }
  const boundedLinetypeCode =
    Number.isInteger(linetypeCode) &&
    linetypeCode >= 0 &&
    linetypeCode <= 2047
      ? linetypeCode
      : 2;
  return (
    lineWeightCode |
    (boundedLinetypeCode << 5) |
    (invisible ? 1 << 16 : 0)
  ) >>> 0;
}
