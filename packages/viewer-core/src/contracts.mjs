import {
  RenderCapability,
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
} from "@dwg-viewer/render-protocol";

function objectLike(value, label) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function method(value, name, label) {
  if (typeof value[name] !== "function") {
    throw new TypeError(`${label} must implement ${name}()`);
  }
}

export function assertRenderSource(value) {
  const source = objectLike(value, "RenderSource");
  if (
    !Array.isArray(source.supportedProtocolVersions) ||
    source.supportedProtocolVersions.length === 0
  ) {
    throw new TypeError(
      "RenderSource must declare supportedProtocolVersions",
    );
  }
  method(source, "open", "RenderSource");
  method(source, "dispose", "RenderSource");
  return source;
}

const CAPABILITY_METHODS = Object.freeze({
  [RenderCapability.REVISION_EVENTS]: "subscribeRevisionEvents",
  [RenderCapability.RENDER_DELTA]: "subscribeRenderDeltas",
  [RenderCapability.RANGE_READ]: "readRange",
  [RenderCapability.PICK_RESOLVE]: "resolvePick",
  [RenderCapability.CONTEXT_CREATE]: "createContext",
  [RenderCapability.DIAGNOSTICS]: "subscribeDiagnostics",
  [RenderCapability.DIFF]: "openDiff",
  [RenderCapability.SOURCE_REVEAL]: "resolveSourceReveal",
  [RenderCapability.HUMAN_ACTION_INTENT]: "requestHumanAction",
});

export function assertRenderSourceSession(value, descriptor) {
  const session = objectLike(value, "RenderSource session");
  method(session, "getSnapshot", "RenderSource session");
  method(session, "dispose", "RenderSource session");
  for (const capability of descriptor.capabilities) {
    const requiredMethod = CAPABILITY_METHODS[capability];
    if (requiredMethod && typeof session[requiredMethod] !== "function") {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.CAPABILITY_MISSING,
        `RenderSource declared ${capability} without ${requiredMethod}()`,
        { capability, requiredMethod },
      );
    }
  }
  return session;
}

export function assertViewerHost(value) {
  const host = objectLike(value, "ViewerHost");
  method(host, "handleEvent", "ViewerHost");
  method(host, "dispose", "ViewerHost");
  if (
    host.openResource !== undefined &&
    typeof host.openResource !== "function"
  ) {
    throw new TypeError(
      "ViewerHost openResource must be a function when provided",
    );
  }
  return host;
}
