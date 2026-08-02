const HANGUL_SYLLABLE_START = 0xac00;
const HANGUL_SYLLABLE_END = 0xd7a3;
const HANGUL_MEDIAL_COUNT = 21;
const HANGUL_FINAL_COUNT = 28;
const HANGUL_SYLLABLES_PER_INITIAL =
  HANGUL_MEDIAL_COUNT * HANGUL_FINAL_COUNT;

const JOHAB_MEDIAL_CODES = Object.freeze([
  3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15,
  18, 19, 20, 21, 22, 23, 26, 27, 28, 29,
]);
const JOHAB_FINAL_CODES = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
  15, 16, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
]);
const JOHAB_NON_KS_SYMBOL_CODES = new Map([
  [0x00ae, 0xd9e7],
  [0x20ac, 0xd9e6],
]);

const ENCODING_ALIASES = new Map([
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
const reverseCodeMaps = new Map();

function validCodePoint(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

export function normalizeLegacyKoreanEncoding(
  value,
  fallback = "auto",
) {
  const normalizedFallback =
    typeof fallback === "string" ? fallback : "auto";
  if (typeof value !== "string") {
    return normalizedFallback;
  }
  return (
    ENCODING_ALIASES.get(
      value.trim().toLocaleLowerCase("en-US"),
    ) ?? normalizedFallback
  );
}

function buildEucKrReverseCodeMap() {
  let decoder;
  try {
    // Decoder implementations differ on CP949 extension bytes. Restricting
    // both bytes to A1-FE fixes this index to the strict KS X 1001 region.
    decoder = new TextDecoder("euc-kr", {
      fatal: true,
      ignoreBOM: true,
    });
  } catch {
    return new Map();
  }
  const bytes = new Uint8Array(2);
  const mapping = new Map();
  for (let lead = 0xa1; lead <= 0xfe; lead += 1) {
    bytes[0] = lead;
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      bytes[1] = trail;
      try {
        const characters = [...decoder.decode(bytes)];
        if (characters.length !== 1) {
          continue;
        }
        const codePoint = characters[0].codePointAt(0);
        if (codePoint > 0x7f && !mapping.has(codePoint)) {
          mapping.set(codePoint, (lead << 8) | trail);
        }
      } catch {
        // Invalid byte pairs are expected while building the reverse index.
      }
    }
  }
  return mapping;
}

function eucKrReverseCodeMap() {
  if (!reverseCodeMaps.has("euc-kr")) {
    reverseCodeMaps.set("euc-kr", buildEucKrReverseCodeMap());
  }
  return reverseCodeMaps.get("euc-kr");
}

function cp949ExtensionCodes() {
  const codes = [];
  const appendRange = (lead, start, end) => {
    for (let trail = start; trail <= end; trail += 1) {
      codes.push((lead << 8) | trail);
    }
  };
  for (let lead = 0x81; lead <= 0xa0; lead += 1) {
    appendRange(lead, 0x41, 0x5a);
    appendRange(lead, 0x61, 0x7a);
    appendRange(lead, 0x81, 0xfe);
  }
  for (let lead = 0xa1; lead <= 0xc5; lead += 1) {
    appendRange(lead, 0x41, 0x5a);
    appendRange(lead, 0x61, 0x7a);
    appendRange(lead, 0x81, 0xa0);
  }
  appendRange(0xc6, 0x41, 0x52);
  return codes;
}

function buildCp949ReverseCodeMap() {
  const strict = eucKrReverseCodeMap();
  const mapping = new Map(strict);
  const extensionCodes = cp949ExtensionCodes();
  let extensionIndex = 0;
  for (
    let codePoint = HANGUL_SYLLABLE_START;
    codePoint <= HANGUL_SYLLABLE_END;
    codePoint += 1
  ) {
    if (strict.has(codePoint)) {
      continue;
    }
    const code = extensionCodes[extensionIndex];
    if (code === undefined) {
      return new Map();
    }
    mapping.set(codePoint, code);
    extensionIndex += 1;
  }
  return extensionIndex === extensionCodes.length
    ? mapping
    : new Map();
}

function cp949ReverseCodeMap() {
  if (!reverseCodeMaps.has("cp949")) {
    reverseCodeMaps.set("cp949", buildCp949ReverseCodeMap());
  }
  return reverseCodeMaps.get("cp949");
}

export function encodeEucKrCode(codePoint) {
  if (!validCodePoint(codePoint)) {
    return undefined;
  }
  return eucKrReverseCodeMap().get(codePoint);
}

export function encodeCp949Code(codePoint) {
  if (!validCodePoint(codePoint)) {
    return undefined;
  }
  return cp949ReverseCodeMap().get(codePoint);
}

function encodeJohabKsX1001Code(codePoint) {
  const nonKsSymbol = JOHAB_NON_KS_SYMBOL_CODES.get(codePoint);
  if (nonKsSymbol !== undefined) {
    return nonKsSymbol;
  }
  const eucKrCode = encodeEucKrCode(codePoint);
  if (eucKrCode === undefined) {
    return undefined;
  }
  const lead = eucKrCode >>> 8;
  const trail = eucKrCode & 0xff;
  let firstLead;
  let johabLead;

  // Windows CP1361 packs two KS X 1001 rows into one Johab lead byte.
  // The first row uses 31-7E and 91-A0; the second keeps A1-FE.
  // This is the transformation recorded by Unicode's authoritative
  // bestfit1361 mapping. A4 is excluded because compatibility Jamo use
  // Johab composition slots instead of this row transform.
  if (lead >= 0xa1 && lead <= 0xac && lead !== 0xa4) {
    firstLead = 0xa1;
    johabLead = 0xd9 + Math.floor((lead - firstLead) / 2);
  } else if (lead >= 0xca && lead <= 0xfd) {
    firstLead = 0xca;
    johabLead = 0xe0 + Math.floor((lead - firstLead) / 2);
  } else {
    return undefined;
  }
  if ((lead - firstLead) % 2 === 1) {
    return (johabLead << 8) | trail;
  }
  const ordinal = trail - 0xa1;
  if (ordinal < 0 || ordinal >= 94) {
    return undefined;
  }
  const johabTrail =
    ordinal < 78 ? 0x31 + ordinal : 0x91 + ordinal - 78;
  return (johabLead << 8) | johabTrail;
}

export function encodeJohabCode(codePoint) {
  if (!validCodePoint(codePoint)) {
    return undefined;
  }
  if (
    codePoint >= HANGUL_SYLLABLE_START &&
    codePoint <= HANGUL_SYLLABLE_END
  ) {
    const ordinal = codePoint - HANGUL_SYLLABLE_START;
    const initial = Math.floor(
      ordinal / HANGUL_SYLLABLES_PER_INITIAL,
    );
    const medial = Math.floor(
      (ordinal % HANGUL_SYLLABLES_PER_INITIAL) /
        HANGUL_FINAL_COUNT,
    );
    const final = ordinal % HANGUL_FINAL_COUNT;
    return (
      0x8000 |
      ((initial + 2) << 10) |
      (JOHAB_MEDIAL_CODES[medial] << 5) |
      JOHAB_FINAL_CODES[final]
    );
  }
  return encodeJohabKsX1001Code(codePoint);
}

function candidateFor(codePoint, encoding) {
  const code =
    encoding === "euc-kr"
      ? encodeEucKrCode(codePoint)
      : encoding === "cp949"
        ? encodeCp949Code(codePoint)
        : encodeJohabCode(codePoint);
  return code === undefined
    ? undefined
    : Object.freeze({ encoding, code });
}

export function legacyKoreanCodeCandidates(
  codePoint,
  encoding = "auto",
) {
  if (!validCodePoint(codePoint)) {
    return Object.freeze([]);
  }
  const normalized = normalizeLegacyKoreanEncoding(encoding);
  const encodings =
    normalized === "auto"
      ? ["euc-kr", "cp949", "johab"]
      : [normalized];
  const codes = new Set();
  const candidates = [];
  for (const candidateEncoding of encodings) {
    const candidate = candidateFor(codePoint, candidateEncoding);
    if (!candidate || codes.has(candidate.code)) {
      continue;
    }
    codes.add(candidate.code);
    candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

export function encodeLegacyBigFontCode(
  codePoint,
  encoding = "euc-kr",
) {
  return legacyKoreanCodeCandidates(codePoint, encoding)[0]?.code;
}

export const LEGACY_KOREAN_ENCODINGS = Object.freeze([
  "auto",
  "euc-kr",
  "cp949",
  "johab",
]);
