import {
  NativeAdapterErrorCode,
} from "./constants.mjs";

export class NativeDocumentAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "NativeDocumentAdapterError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON() {
    return Object.freeze({
      schema: "dwg-native-adapter-error/1",
      code: this.code,
      message: this.message,
      details: this.details,
    });
  }
}

export function adapterError(code, message, details) {
  throw new NativeDocumentAdapterError(code, message, details);
}

export function invalid(message, details) {
  adapterError(
    NativeAdapterErrorCode.MESSAGE_INVALID,
    message,
    details,
  );
}

export function disposed() {
  adapterError(
    NativeAdapterErrorCode.SOURCE_DISPOSED,
    "native document adapter session is disposed",
  );
}
