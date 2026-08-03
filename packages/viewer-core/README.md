# `@dwg-viewer/viewer-core`

Viewer renderer와 source/host lifecycle을 VS Code, DWG parser와 Spatial
Workspace에서 분리하기 위한 최소 public contract입니다.

## RenderSource

Source는 다음을 제공합니다.

- `supportedProtocolVersions`
- `open({ protocolVersion, signal })`
- `dispose()`

열린 session은 `descriptor`, `getSnapshot()`과 `dispose()`를 제공해야
합니다. capability를 선언하면 해당 method도 반드시 구현해야 합니다.
예를 들어 `range-read`는 `readRange()`, `revision-events`는
`subscribeRevisionEvents()`를 요구합니다.

`openRenderSource()`는 version을 협상하고 descriptor/snapshot binding을
검증하며, stale 또는 out-of-order 상태를 화면에 전달하기 전에 거부합니다.
모든 disposal은 idempotent합니다.

`createRenderLayerRangeSource()`는 snapshot의 range-backed layer 하나를
기존 bounded reader가 소비할 수 있는 source로 projection합니다.
`openViewerRuntime()`은 source session과 최초 snapshot을 연 뒤 제품이
제공한 `mount()`를 실행하고, 반환된 presentation·source·Host의 lifecycle을
한 번에 소유합니다. mount 실패나 취소에서도 같은 자원을 정리합니다.

`@dwg-viewer/viewer-core/testing`은 브라우저에서도 실행 가능한
`MockRenderSource`를 제공하고, `@dwg-viewer/viewer-core/conformance`는 source
구현이 실행할 공통 lifecycle/range fixture를 제공합니다.

## ViewerHost

Host는 최소 `handleEvent()`와 `dispose()`를 제공합니다. 선택적으로
host-owned resource를 위한 `openResource()`를 제공할 수 있습니다.

Viewer event vocabulary는 `selection.changed`, `viewport.changed`,
`context.request`, `source.reveal`, `diagnostics.changed`, `diff.open`,
`humanAction.request`입니다. event detail schema와 source reveal/context
conformance는 #30에서 고정합니다. `humanAction.request`는 intent일 뿐
capability 또는 approval evidence가 아닙니다.

현재 package에는 DOM bootstrap, `vscode`, `acquireVsCodeApi()`, Scene Cache
parser와 Spatial permission code가 없습니다. Browser와 VS Code 제품
진입점은 이미 같은 runtime과 `DwgSceneCacheSource`를 거칩니다.
source-neutral
`CameraController2D`와 viewport bounds는 Core의 canonical 구현이며
`@dwg-viewer/viewer-core/camera`로도 노출합니다. Renderer가 소유한 GPU
batch를 byte budget으로 관리하는 `GpuBatchCache`도 source-neutral Core
모듈이며 `@dwg-viewer/viewer-core/batch-cache`로 노출합니다. Canvas
viewport의 pan/zoom/window-zoom, view commit, redraw와 detail lifecycle은
`ViewportInteraction`이 소유합니다.

`ViewerRendererController`는 redraw/camera와 root·external detail target
계약을 fail-closed로 검사하고 target별 GPU resource disposal을 조정합니다.
`DetailStreamingController`는 selection policy와 byte loader를 주입받아
동시성, visible/cache budget, stale work, review geometry와 redraw
coalescing을 소유합니다. 현재 Webview의 `DetailStreamer`는 DWG Scene Cache
batch selection과 reader/renderer mapping만 담당하는 얇은 adapter입니다.

`ViewerSelectionController`는 제품 pick을 source-specific projector로
정규화한 뒤 active session/revision/snapshot에 결합하고 monotonic
`selection.changed` event를 ViewerHost에 전달합니다. 현재 DWG adapter는
handle, source, layer와 point만 투영합니다. 외부 identity 및
`pick-resolve` schema의 stable conformance는 #30에서 고정합니다.

실제 WebGL CAD shader와 CPU DWG candidate decoder, DOM inspector는 아직
`packages/webview`에 있습니다. Core는 이 구현을 import하지 않으며 이후
renderer data model과 일반 `viewer-ui` 경계를 별도 단계로 이동합니다.

일반 review toolbar와 result panel의 DOM lifecycle은 별도
`@dwg-viewer/viewer-ui` package가 소유합니다. Viewer Core는 이 package를
import하지 않으며 Host event와 rendering lifecycle만 유지합니다.
