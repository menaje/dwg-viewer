import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  diagnoseLibreDwgAdapter,
  LibreDwgNativeSceneEngine,
  resolveLibreDwgAdapter,
} from "./native-cache";
import { CacheRangeChannel } from "./range-channel";
import { SceneCacheManager } from "./scene-cache-manager";
import {
  isSceneEngineAbort,
  SceneEngineError,
  type SceneEngineDescriptor,
  type SceneEngineProgressPhase,
} from "./scene-engine";
import {
  MAX_SHX_FONT_DIRECTORIES,
  ShxFontChannel,
} from "./shx-font-channel";
import { renderWebviewHtml } from "./webview-html";

const VIEW_TYPE = "dwgViewer.dwg";
const ADD_SHX_FONT_FOLDERS_COMMAND = "dwgViewer.addShxFontFolders";
const SELECT_LIBREDWG_ADAPTER_COMMAND =
  "dwgViewer.selectLibreDwgAdapter";
const DIAGNOSE_LIBREDWG_ADAPTER_COMMAND =
  "dwgViewer.diagnoseLibreDwgAdapter";

function adapterErrorDetails(error: unknown): {
  code: string;
  message: string;
} {
  return error instanceof SceneEngineError
    ? { code: error.code, message: error.userMessage }
    : {
        code: "ADAPTER_DIAGNOSIS_FAILED",
        message: "LibreDWG 변환기를 확인하지 못했습니다.",
      };
}

async function diagnoseAdapterWithProgress(
  adapterPath: string,
): ReturnType<typeof diagnoseLibreDwgAdapter> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "DWG Viewer: LibreDWG 변환기 진단",
      cancellable: false,
    },
    () => diagnoseLibreDwgAdapter(adapterPath),
  );
}

async function selectLibreDwgAdapter(
  output: vscode.OutputChannel,
): Promise<boolean> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    title: "DWG Viewer용 LibreDWG 변환기 선택",
    openLabel: "선택 후 진단",
  });
  const adapterUri = selected?.find((uri) => uri.scheme === "file");
  if (!adapterUri) {
    return false;
  }

  try {
    const adapterPath = await resolveLibreDwgAdapter({
      configuredPath: adapterUri.fsPath,
      extensionPath: "",
    });
    const report = await diagnoseAdapterWithProgress(adapterPath);
    await vscode.workspace
      .getConfiguration("dwgViewer")
      .update(
        "libredwgAdapterPath",
        adapterPath,
        vscode.ConfigurationTarget.Global,
      );
    const linkage =
      report.linkage === "static"
        ? "독립 실행형"
        : "로컬 라이브러리 연결형";
    output.appendLine(
      `[ADAPTER_READY] engine=${report.engineVersion} linkage=${report.linkage} target=${report.platform}-${report.architecture}`,
    );
    void vscode.window.showInformationMessage(
      `DWG Viewer: LibreDWG ${report.engineVersion} 변환기 진단을 통과했습니다 (${linkage}).`,
    );
    return true;
  } catch (error) {
    const details = adapterErrorDetails(error);
    output.appendLine(`[${details.code}] adapter selection failed`);
    void vscode.window.showErrorMessage(
      `DWG Viewer: ${details.message}`,
    );
    return false;
  }
}

async function diagnoseConfiguredLibreDwgAdapter(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<boolean> {
  try {
    const configuration = vscode.workspace.getConfiguration("dwgViewer");
    const adapterPath = await resolveLibreDwgAdapter({
      configuredPath: configuration.get<string>(
        "libredwgAdapterPath",
        "",
      ),
      environmentPath: process.env.DWG_VIEWER_LIBREDWG_ADAPTER,
      extensionPath: context.extensionPath,
    });
    const report = await diagnoseAdapterWithProgress(adapterPath);
    output.appendLine(
      `[ADAPTER_READY] engine=${report.engineVersion} linkage=${report.linkage} target=${report.platform}-${report.architecture}`,
    );
    void vscode.window.showInformationMessage(
      `DWG Viewer: LibreDWG ${report.engineVersion} 변환기가 정상입니다 (${report.platform}-${report.architecture}, ${report.linkage}).`,
    );
    return true;
  } catch (error) {
    const details = adapterErrorDetails(error);
    output.appendLine(`[${details.code}] adapter diagnosis failed`);
    void vscode.window.showErrorMessage(
      `DWG Viewer: ${details.message}`,
    );
    return false;
  }
}

function fontDirectoryKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

async function addShxFontFolders(): Promise<boolean> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    title: "DWG Viewer에서 사용할 SHX·BigFont 폴더 선택",
    openLabel: "글꼴 폴더 추가",
  });
  const directories = (selected ?? [])
    .filter((uri) => uri.scheme === "file")
    .map((uri) => path.resolve(uri.fsPath));
  if (directories.length === 0) {
    return false;
  }

  const configuration = vscode.workspace.getConfiguration("dwgViewer");
  const current = configuration.get<unknown>("shxFontDirectories", []);
  const currentDirectories = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string")
    : [];
  const existingKeys = new Set(
    currentDirectories
      .filter((directory) => path.isAbsolute(directory))
      .map(fontDirectoryKey),
  );
  const merged: string[] = [];
  const seen = new Set<string>();
  let added = 0;
  for (const directory of [
    ...currentDirectories,
    ...directories,
  ]) {
    if (!path.isAbsolute(directory)) {
      continue;
    }
    const resolved = path.resolve(directory);
    const key = fontDirectoryKey(resolved);
    if (
      !seen.has(key) &&
      merged.length < MAX_SHX_FONT_DIRECTORIES - 1
    ) {
      seen.add(key);
      merged.push(resolved);
      if (!existingKeys.has(key)) {
        added += 1;
      }
    }
  }
  await configuration.update(
    "shxFontDirectories",
    merged,
    vscode.ConfigurationTarget.Global,
  );
  void vscode.window.showInformationMessage(
    added > 0
      ? `DWG Viewer: SHX 글꼴 폴더 ${added.toLocaleString()}개를 추가했습니다.`
      : "DWG Viewer: 기존 SHX 글꼴 폴더 설정을 다시 읽습니다.",
  );
  return true;
}

class DwgDocument implements vscode.CustomDocument {
  private readonly sessions = new Set<() => void>();

  constructor(readonly uri: vscode.Uri) {}

  addSession(dispose: () => void): vscode.Disposable {
    this.sessions.add(dispose);
    return new vscode.Disposable(() => this.sessions.delete(dispose));
  }

  dispose(): void {
    for (const dispose of this.sessions) {
      dispose();
    }
    this.sessions.clear();
  }
}

interface HostMessage {
  type?: unknown;
  code?: unknown;
  cacheId?: unknown;
  firstFrameMs?: unknown;
  requestId?: unknown;
  name?: unknown;
}

class DwgEditorProvider
  implements vscode.CustomReadonlyEditorProvider<DwgDocument>
{
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): DwgDocument {
    if (uri.scheme !== "file") {
      throw new Error("DWG Viewer currently supports local files only.");
    }
    return new DwgDocument(uri);
  }

  async resolveCustomEditor(
    document: DwgDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const mediaRoot = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "webview",
    );
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    const template = await readFile(
      path.join(mediaRoot.fsPath, "index.html"),
      "utf8",
    );
    const nonce = randomBytes(24).toString("base64url");
    webviewPanel.webview.html = renderWebviewHtml(template, {
      cspSource: webviewPanel.webview.cspSource,
      nonce,
      stylesUri: webviewPanel.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "styles.css"))
        .toString(),
      scriptUri: webviewPanel.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, "src", "main.mjs"))
        .toString(),
    });

    let disposed = false;
    let generation = 0;
    let conversion: AbortController | undefined;
    const rangeChannels = new Map<string, CacheRangeChannel>();
    const previewReleases = new Map<string, () => Promise<void>>();
    let fontChannel: ShxFontChannel | undefined;
    let activeCacheId: string | undefined;
    let activeCacheReused = false;
    let activeEngine: SceneEngineDescriptor | undefined;
    let openStartedAt = 0;
    // LibreDWG can approach 600 MiB RSS, so retries never overlap processes.
    let startQueue: Promise<void> = Promise.resolve();

    const postState = async (
      state: "preparing" | "converting" | "validating" | "error",
      message: string,
      code?: string,
    ): Promise<void> => {
      await webviewPanel.webview.postMessage({
        type: "dwg-cache-state/1",
        state,
        message,
        code,
      });
    };

    const stopCurrent = async (): Promise<void> => {
      conversion?.abort();
      conversion = undefined;
      activeCacheId = undefined;
      activeEngine = undefined;
      const channels = [...rangeChannels.values()];
      const releases = [...previewReleases.values()];
      rangeChannels.clear();
      previewReleases.clear();
      fontChannel?.dispose();
      fontChannel = undefined;
      await Promise.allSettled(
        channels.map((channel) => channel.dispose()),
      );
      await Promise.allSettled(releases.map((release) => release()));
    };

    const disposePreview = async (cacheId: string): Promise<void> => {
      const channel = rangeChannels.get(cacheId);
      const release = previewReleases.get(cacheId);
      rangeChannels.delete(cacheId);
      previewReleases.delete(cacheId);
      await channel?.dispose();
      await release?.();
    };

    const disposeInactivePreviews = async (): Promise<void> => {
      const previewIds = [...previewReleases.keys()].filter(
        (cacheId) => cacheId !== activeCacheId,
      );
      await Promise.allSettled(
        previewIds.map((cacheId) => disposePreview(cacheId)),
      );
    };

    const createFontChannel = (cacheId: string): ShxFontChannel => {
      const configuration = vscode.workspace.getConfiguration(
        "dwgViewer",
        document.uri,
      );
      const rawDirectories = configuration.get<unknown>(
        "shxFontDirectories",
        [],
      );
      const rawMappings = configuration.get<unknown>("shxFontMappings", {});
      const fontDirectories = Array.isArray(rawDirectories)
        ? rawDirectories.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const fontMappings =
        typeof rawMappings === "object" &&
        rawMappings !== null &&
        !Array.isArray(rawMappings)
          ? (rawMappings as Record<string, string>)
          : {};
      return new ShxFontChannel(
        cacheId,
        {
          drawingDirectory: path.dirname(document.uri.fsPath),
          fontDirectories,
          fontMappings,
        },
        (message) => webviewPanel.webview.postMessage(message),
      );
    };

    const reloadFontConfiguration = (): void => {
      fontChannel?.dispose();
      fontChannel = activeCacheId
        ? createFontChannel(activeCacheId)
        : undefined;
      if (activeCacheId) {
        void webviewPanel.webview.postMessage({
          type: "dwg-font-configuration-changed/1",
          cacheId: activeCacheId,
        });
      }
    };

    const start = async (
      force: boolean,
      currentGeneration: number,
    ): Promise<void> => {
      await stopCurrent();
      if (disposed || currentGeneration !== generation) {
        return;
      }
      const controller = new AbortController();
      conversion = controller;
      activeCacheId = undefined;
      activeCacheReused = false;
      openStartedAt = Date.now();
      await postState(
        "preparing",
        force ? "캐시를 다시 만들 준비 중…" : "도면 캐시 확인 중…",
      );

      try {
        const configuredPath = vscode.workspace
          .getConfiguration("dwgViewer")
          .get<string>("libredwgAdapterPath", "");
        const adapterPath = await resolveLibreDwgAdapter({
          configuredPath,
          environmentPath: process.env.DWG_VIEWER_LIBREDWG_ADAPTER,
          extensionPath: this.context.extensionPath,
        });
        const engine = new LibreDwgNativeSceneEngine(adapterPath);
        activeEngine = engine.descriptor;
        const manager = new SceneCacheManager(
          path.join(this.context.globalStorageUri.fsPath, "cache"),
          engine,
        );
        this.output.appendLine(
          `[ENGINE_SELECTED] id=${engine.descriptor.engineId} version=${engine.descriptor.engineVersion} backend=${engine.descriptor.backendId}`,
        );
        const prepared = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "DWG Viewer",
            cancellable: true,
          },
          async (progress, cancellationToken) => {
            const cancellation = cancellationToken.onCancellationRequested(() =>
              controller.abort(),
            );
            const resolutionCancellation = token.onCancellationRequested(() =>
              controller.abort(),
            );
            try {
              return await manager.prepare(document.uri.fsPath, {
                force,
                signal: controller.signal,
                onPreview: async (preview) => {
                  if (
                    disposed ||
                    controller.signal.aborted ||
                    currentGeneration !== generation
                  ) {
                    await preview.release();
                    return;
                  }
                  const channel = await CacheRangeChannel.open(
                    preview.cacheId,
                    preview.cachePath,
                    preview.size,
                    (message) =>
                      webviewPanel.webview.postMessage(message),
                  );
                  if (
                    disposed ||
                    controller.signal.aborted ||
                    currentGeneration !== generation
                  ) {
                    await channel.dispose();
                    await preview.release();
                    return;
                  }
                  rangeChannels.set(preview.cacheId, channel);
                  previewReleases.set(
                    preview.cacheId,
                    preview.release,
                  );
                  try {
                    await webviewPanel.webview.postMessage({
                      type: "dwg-cache-preview-ready/1",
                      cacheId: preview.cacheId,
                      size: preview.size,
                      engineId: preview.engine.engineId,
                      engineVersion: preview.engine.engineVersion,
                      engineBackend: preview.engine.backendId,
                    });
                  } catch (error) {
                    await disposePreview(preview.cacheId);
                    throw error;
                  }
                },
                onProgress: (event) => {
                  const phaseText: Record<
                    SceneEngineProgressPhase,
                    string
                  > = {
                    checking: "기존 캐시 확인 중…",
                    parsing: `${engine.descriptor.displayName}에서 DWG 해석 중…`,
                    "preview-ready": "첫 화면 데이터 준비 완료",
                    validating: "변환 결과 검사 중…",
                    "cache-ready": "캐시 준비 완료",
                    failed: "변환 엔진 실행 실패",
                    cancelled: "변환 취소됨",
                  };
                  const message = phaseText[event.phase];
                  progress.report({ message });
                  if (
                    event.phase === "parsing" ||
                    event.phase === "preview-ready" ||
                    event.phase === "validating"
                  ) {
                    void postState(
                      event.phase === "parsing"
                        ? "converting"
                        : "validating",
                      message,
                    );
                  }
                },
              });
            } finally {
              cancellation.dispose();
              resolutionCancellation.dispose();
            }
          },
        );
        if (
          disposed ||
          controller.signal.aborted ||
          currentGeneration !== generation
        ) {
          return;
        }
        const channel = await CacheRangeChannel.open(
          prepared.cacheId,
          prepared.cachePath,
          prepared.size,
          (message) => webviewPanel.webview.postMessage(message),
        );
        if (
          disposed ||
          controller.signal.aborted ||
          currentGeneration !== generation
        ) {
          await channel.dispose();
          return;
        }
        rangeChannels.set(prepared.cacheId, channel);
        activeCacheId = prepared.cacheId;
        activeCacheReused = prepared.reused;
        activeEngine = prepared.engine;
        fontChannel = createFontChannel(prepared.cacheId);
        await webviewPanel.webview.postMessage({
          type: "dwg-cache-ready/1",
          cacheId: prepared.cacheId,
          size: prepared.size,
          reused: prepared.reused,
          engineId: prepared.engine.engineId,
          engineVersion: prepared.engine.engineVersion,
          engineBackend: prepared.engine.backendId,
        });
      } catch (error) {
        if (
          disposed ||
          currentGeneration !== generation ||
          isSceneEngineAbort(error)
        ) {
          if (!disposed && currentGeneration === generation) {
            await postState(
              "error",
              "변환이 취소되었습니다. 재시도할 수 있습니다.",
              "CONVERSION_CANCELLED",
            );
          }
          return;
        }
        const code =
          error instanceof SceneEngineError
            ? error.code
            : "VIEWER_PREPARATION_FAILED";
        const message =
          error instanceof SceneEngineError
            ? error.userMessage
            : "도면 뷰어를 준비하지 못했습니다.";
        this.output.appendLine(`[${code}] cache preparation failed`);
        await postState("error", message, code);
      } finally {
        if (conversion === controller) {
          conversion = undefined;
        }
      }
    };

    const requestStart = (force: boolean): void => {
      const currentGeneration = ++generation;
      conversion?.abort();
      startQueue = startQueue
        .catch(() => undefined)
        .then(() => start(force, currentGeneration))
        .catch(() => {
          this.output.appendLine(
            "[VIEWER_START_FAILED] viewer start queue failed",
          );
        });
    };

    const messageSubscription =
      webviewPanel.webview.onDidReceiveMessage((raw: HostMessage) => {
        const messageCacheId =
          typeof raw?.cacheId === "string" ? raw.cacheId : undefined;
        if (
          messageCacheId &&
          rangeChannels.get(messageCacheId)?.handleMessage(raw)
        ) {
          return;
        }
        if (fontChannel?.handleMessage(raw)) {
          return;
        }
        switch (raw?.type) {
          case "dwg-webview-ready/1":
            requestStart(false);
            break;
          case "dwg-cache-retry/1":
            requestStart(false);
            break;
          case "dwg-cache-rebuild/1":
            requestStart(true);
            break;
          case "dwg-adapter-select/1":
            void Promise.resolve(
              vscode.commands.executeCommand<boolean>(
                SELECT_LIBREDWG_ADAPTER_COMMAND,
              ),
            )
              .then((changed) => {
                void webviewPanel.webview.postMessage({
                  type: "dwg-adapter-select-result/1",
                  changed: Boolean(changed),
                });
                if (changed && !disposed) {
                  requestStart(false);
                }
              })
              .catch(() => {
                this.output.appendLine(
                  "[ADAPTER_CONFIGURATION_FAILED] cannot select adapter",
                );
                void webviewPanel.webview.postMessage({
                  type: "dwg-adapter-select-result/1",
                  changed: false,
                  failed: true,
                });
              });
            break;
          case "dwg-font-folder-select/1": {
            const previousChannel = fontChannel;
            void Promise.resolve(
              vscode.commands.executeCommand<boolean>(
                ADD_SHX_FONT_FOLDERS_COMMAND,
              ),
            )
              .then((changed) => {
                if (changed && fontChannel === previousChannel) {
                  reloadFontConfiguration();
                }
                return webviewPanel.webview.postMessage({
                  type: "dwg-font-folder-select-result/1",
                  changed: Boolean(changed),
                });
              })
              .catch(() => {
                this.output.appendLine(
                  "[FONT_CONFIGURATION_FAILED] cannot update SHX font folders",
                );
                return webviewPanel.webview.postMessage({
                  type: "dwg-font-folder-select-result/1",
                  changed: false,
                  failed: true,
                });
              });
            break;
          }
          case "dwg-first-frame-ready/1":
            if (raw.cacheId === activeCacheId) {
              const hostElapsed = Math.max(0, Date.now() - openStartedAt);
              const webviewElapsed =
                typeof raw.firstFrameMs === "number" &&
                Number.isFinite(raw.firstFrameMs) &&
                raw.firstFrameMs >= 0
                  ? Math.round(raw.firstFrameMs)
                  : -1;
              this.output.appendLine(
                `[FIRST_FRAME_READY] cache=${
                  activeCacheReused ? "reused" : "created"
                } engine=${activeEngine?.engineId ?? "unknown"} backend=${
                  activeEngine?.backendId ?? "unknown"
                } host_to_frame_ms=${hostElapsed} webview_frame_ms=${webviewElapsed}`,
              );
              void disposeInactivePreviews();
            } else if (
              typeof raw.cacheId === "string" &&
              previewReleases.has(raw.cacheId)
            ) {
              const hostElapsed = Math.max(0, Date.now() - openStartedAt);
              this.output.appendLine(
                `[PREVIEW_FRAME_READY] engine=${
                  activeEngine?.engineId ?? "libredwg"
                } host_to_frame_ms=${hostElapsed}`,
              );
            }
            break;
          case "dwg-viewer-error/1":
            this.output.appendLine(
              `[WEBVIEW_ERROR] ${
                typeof raw.code === "string" ? raw.code.slice(0, 80) : "unknown"
              }`,
            );
            if (
              typeof raw.cacheId === "string" &&
              previewReleases.has(raw.cacheId)
            ) {
              void disposePreview(raw.cacheId);
            }
            break;
        }
      });

    const fontConfigurationSubscription =
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration(
            "dwgViewer.shxFontDirectories",
            document.uri,
          ) &&
          !event.affectsConfiguration(
            "dwgViewer.shxFontMappings",
            document.uri,
          )
        ) {
          return;
        }
        reloadFontConfiguration();
      });

    let resolutionCancellation: vscode.Disposable | undefined;
    const disposeSession = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      generation += 1;
      messageSubscription.dispose();
      fontConfigurationSubscription.dispose();
      resolutionCancellation?.dispose();
      resolutionCancellation = undefined;
      void stopCurrent();
    };
    const documentSession = document.addSession(disposeSession);
    webviewPanel.onDidDispose(() => {
      documentSession.dispose();
      disposeSession();
    });
    resolutionCancellation =
      token.onCancellationRequested(disposeSession);
    if (disposed) {
      resolutionCancellation.dispose();
      resolutionCancellation = undefined;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("DWG Viewer");
  const provider = new DwgEditorProvider(context, output);
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand(
      ADD_SHX_FONT_FOLDERS_COMMAND,
      addShxFontFolders,
    ),
    vscode.commands.registerCommand(
      SELECT_LIBREDWG_ADAPTER_COMMAND,
      () => selectLibreDwgAdapter(output),
    ),
    vscode.commands.registerCommand(
      DIAGNOSE_LIBREDWG_ADAPTER_COMMAND,
      () => diagnoseConfiguredLibreDwgAdapter(context, output),
    ),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: {
        retainContextWhenHidden: false,
      },
    }),
  );
}

export function deactivate(): void {}
