export const RenderProtocolDiagnosticCode = Object.freeze({
  VERSION_INCOMPATIBLE: "VIEWER_RENDER_VERSION_INCOMPATIBLE",
  MESSAGE_INVALID: "VIEWER_RENDER_MESSAGE_INVALID",
  CAPABILITY_MISSING: "VIEWER_RENDER_CAPABILITY_MISSING",
  SCOPE_MISMATCH: "VIEWER_RENDER_SCOPE_MISMATCH",
  STALE_REVISION: "VIEWER_RENDER_STALE_REVISION",
  OUT_OF_ORDER: "VIEWER_RENDER_OUT_OF_ORDER",
  SOURCE_DISPOSED: "VIEWER_RENDER_SOURCE_DISPOSED",
  RANGE_INVALID: "VIEWER_RENDER_RANGE_INVALID",
});

export class RenderProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RenderProtocolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
