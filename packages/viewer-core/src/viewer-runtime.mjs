import { assertViewerHost } from "./contracts.mjs";
import { openRenderSource } from "./render-source-session.mjs";

function throwIfAborted(signal) {
  signal?.throwIfAborted?.();
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("operation aborted", "AbortError")
    );
  }
}

function assertPresentation(value) {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    typeof value.dispose !== "function"
  ) {
    throw new TypeError(
      "Viewer Core mount() must return a disposable presentation",
    );
  }
  return value;
}

async function settleDisposal(...resources) {
  const results = await Promise.allSettled(
    resources
      .filter(Boolean)
      .map((resource) =>
        Promise.resolve().then(() => resource.dispose()),
      ),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Viewer Core disposal failed");
  }
}

export class ViewerRuntime {
  #sourceSession;
  #host;
  #presentation;
  #disposed = false;
  #disposePromise;

  constructor({ sourceSession, snapshot, host, presentation }) {
    this.#sourceSession = sourceSession;
    this.#host = host;
    this.#presentation = presentation;
    this.snapshot = snapshot;
  }

  get descriptor() {
    return this.#sourceSession.descriptor;
  }

  get sourceSession() {
    return this.#sourceSession;
  }

  get host() {
    return this.#host;
  }

  get presentation() {
    return this.#presentation;
  }

  get disposed() {
    return this.#disposed;
  }

  handleEvent(event) {
    if (this.#disposed) {
      throw new DOMException(
        "Viewer Core runtime is disposed",
        "InvalidStateError",
      );
    }
    return this.#host.handleEvent(event);
  }

  dispose() {
    if (!this.#disposePromise) {
      this.#disposed = true;
      this.#disposePromise = settleDisposal(
        this.#presentation,
        this.#sourceSession,
        this.#host,
      );
    }
    return this.#disposePromise;
  }
}

export async function openViewerRuntime(
  source,
  {
    host: inputHost,
    mount,
    supportedProtocolVersions,
    signal,
  } = {},
) {
  const host = assertViewerHost(inputHost);
  if (typeof mount !== "function") {
    throw new TypeError("Viewer Core requires a mount() function");
  }

  let sourceSession;
  let presentation;
  try {
    throwIfAborted(signal);
    sourceSession = await openRenderSource(source, {
      supportedProtocolVersions,
      signal,
    });
    const snapshot = await sourceSession.getSnapshot({ signal });
    throwIfAborted(signal);
    presentation = assertPresentation(
      await mount(
        Object.freeze({
          sourceSession,
          snapshot,
          host,
          signal,
        }),
      ),
    );
    throwIfAborted(signal);
    return new ViewerRuntime({
      sourceSession,
      snapshot,
      host,
      presentation,
    });
  } catch (error) {
    try {
      await settleDisposal(presentation, sourceSession, host);
    } catch {
      // Preserve the open/mount failure; cleanup errors are secondary.
    }
    throw error;
  }
}
