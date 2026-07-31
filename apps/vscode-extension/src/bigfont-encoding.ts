import { normalizeShxFontName } from "./shx-font-channel";

export const MAX_BIGFONT_ENCODING_MAPPINGS = 128;

export type BigFontEncoding =
  | "auto"
  | "euc-kr"
  | "cp949"
  | "johab";

const ENCODING_ALIASES = new Map<string, BigFontEncoding>([
  ["auto", "auto"],
  ["euc-kr", "euc-kr"],
  ["euckr", "euc-kr"],
  ["ks-x-1001", "euc-kr"],
  ["ksx1001", "euc-kr"],
  ["cp949", "cp949"],
  ["windows-949", "cp949"],
  ["uhc", "cp949"],
  ["johab", "johab"],
  ["cp1361", "johab"],
  ["windows-1361", "johab"],
]);

export function normalizeBigFontEncodingMappings(
  value: unknown,
  maximumMappings = MAX_BIGFONT_ENCODING_MAPPINGS,
): Readonly<Record<string, BigFontEncoding>> {
  if (!Number.isSafeInteger(maximumMappings) || maximumMappings <= 0) {
    throw new RangeError("maximumMappings must be a positive safe integer");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return Object.freeze({});
  }
  const mappings = new Map<string, BigFontEncoding>();
  for (const [fontName, rawEncoding] of Object.entries(value)) {
    const normalizedName = normalizeShxFontName(fontName);
    const encoding =
      typeof rawEncoding === "string"
        ? ENCODING_ALIASES.get(
            rawEncoding.trim().toLocaleLowerCase("en-US"),
          )
        : undefined;
    if (!normalizedName || !encoding) {
      continue;
    }
    if (
      !mappings.has(normalizedName) &&
      mappings.size >= maximumMappings
    ) {
      continue;
    }
    mappings.set(normalizedName, encoding);
  }
  return Object.freeze(
    Object.fromEntries(
      [...mappings.entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en-US"),
      ),
    ),
  );
}
