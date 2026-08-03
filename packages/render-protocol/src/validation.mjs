import {
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
} from "./diagnostics.mjs";

const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

export function invalid(message, details = {}) {
  throw new RenderProtocolError(
    RenderProtocolDiagnosticCode.MESSAGE_INVALID,
    message,
    details,
  );
}

export function plainRecord(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${label} must be a plain object`);
  }
  return value;
}

export function exactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    invalid(`${label} contains unknown fields`, {
      fields: unknown.sort(),
    });
  }
}

export function semanticVersion(value, label = "protocol version") {
  if (typeof value !== "string" || !SEMANTIC_VERSION.test(value)) {
    invalid(`${label} must be an exact semantic version`);
  }
  return value;
}

export function semanticVersionTuple(value, label) {
  semanticVersion(value, label);
  return value.split(".").map(Number);
}

export function opaqueIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^file:/i.test(value) ||
    WINDOWS_ABSOLUTE_PATH.test(value)
  ) {
    invalid(`${label} must be a bounded opaque identifier, not a path`);
  }
  return value;
}

export function boundedString(value, label, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid(`${label} must be a bounded string`);
  }
  return value;
}

export function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalid(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function positiveSafeInteger(value, label) {
  return safeInteger(value, label, 1);
}

export function boolean(value, label) {
  if (typeof value !== "boolean") {
    invalid(`${label} must be a boolean`);
  }
  return value;
}

export function nullableTimestamp(value, label) {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    invalid(`${label} must be null or an ISO timestamp`);
  }
  return value;
}

export function enumValue(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    invalid(`${label} is not supported`, { value });
  }
  return value;
}

export function uniqueEnumArray(
  value,
  allowedValues,
  label,
  { minimumLength = 0 } = {},
) {
  if (
    !Array.isArray(value) ||
    value.length < minimumLength ||
    value.length > allowedValues.length
  ) {
    invalid(`${label} must be a bounded array`);
  }
  const seen = new Set();
  for (const entry of value) {
    enumValue(entry, allowedValues, `${label} entry`);
    if (seen.has(entry)) {
      invalid(`${label} must not contain duplicates`, { value: entry });
    }
    seen.add(entry);
  }
  return Object.freeze([...seen].sort());
}

export function scopeMismatch(message, details = {}) {
  throw new RenderProtocolError(
    RenderProtocolDiagnosticCode.SCOPE_MISMATCH,
    message,
    details,
  );
}

export function staleRevision(message, details = {}) {
  throw new RenderProtocolError(
    RenderProtocolDiagnosticCode.STALE_REVISION,
    message,
    details,
  );
}
