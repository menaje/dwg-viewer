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
`subscribeRevisionEvents()`를 요구합니다. Service-backed source는
`pick-resolve`, `context-create`, `source-reveal` capability에 맞춰 각각
`resolvePick()`, `createContext()`, `resolveSourceReveal()`을 구현합니다.

`openRenderSource()`는 version을 협상하고 descriptor/snapshot binding을
검증하며, stale 또는 out-of-order 상태를 화면에 전달하기 전에 거부합니다.
pick/context/reveal 응답도 요청 전후에 active snapshot을 검사하므로 작업
도중 snapshot이 바뀌면 늦은 응답을 `STALE_REVISION`으로 거부합니다. 모든
disposal은 idempotent합니다.

## Render Delta

`render-delta` capability를 선언한 session은
`subscribeRenderDeltas(listener)`를 구현합니다.
`ViewerRenderSourceSession.subscribeRenderDeltas()`는 base snapshot,
from/to revision과 직전 sequence를 검증하고, listener가 전체 delta를
성공적으로 원자 적용한 뒤에만 session의 `revisionId`를 전진시킵니다. 실패한
delta 일부는 노출되지 않으며 subscription의 `lastError`, `whenIdle()`과
`onError`로 관찰할 수 있습니다.

`ViewerRenderDeltaController`는 immutable base를 다시 읽지 않고 변경된
Render ID만 보관합니다.

- entity tombstone filter와 aspect별 upsert overlay
- affected bounds, dependency invalidation과 external identity map 갱신
- 하나의 preview 적용, rollback과 promotion
- delta count/payload bytes/overlay entry 기준 checkpoint 권고 및 hard limit
- stale/out-of-order 입력 전 상태 보존과 idempotent disposal

선택적 renderer adapter는 동기·원자적인 `applyDelta()`,
`rollbackPreview()`, `promotePreview()`, `dispose()` 경계만 구현합니다.
DWG 36-byte vertex layout이나 Spatial packet 의미는 Core 계약에 포함되지
않습니다. `MockRenderDeltaSource`와
`runRenderDeltaConformance()`가 ordered apply, stale replay 거부, pick map
revision과 disposal을 검증합니다.

`createRenderLayerRangeSource()`는 snapshot의 range-backed layer 하나를
기존 bounded reader가 소비할 수 있는 source로 projection합니다.
`openViewerRuntime()`은 source session과 최초 snapshot을 연 뒤 제품이
제공한 `mount()`를 실행하고, 반환된 presentation·source·Host의 lifecycle을
한 번에 소유합니다. mount 실패나 취소에서도 같은 자원을 정리합니다.

`@dwg-viewer/viewer-core/testing`은 브라우저에서도 실행 가능한
`MockRenderSource`, base/live layer와 identity hook을 갖춘
`MockServiceRenderSource`, ordered tombstone/upsert fixture를 갖춘
`MockRenderDeltaSource`를 제공합니다.
`@dwg-viewer/viewer-core/conformance`의
`runRenderSourceConformance()`는 공통 lifecycle/range 계약을,
`runServiceRenderSourceConformance()`는 pick/external identity/context/reveal
계약과 stale pick 거부를 검증합니다. `runRenderDeltaConformance()`는
두 ordered delta 사이의 stale replay가 source와 overlay revision을
오염시키지 않는지 검증합니다.

## ViewerHost

Host는 최소 `handleEvent()`와 `dispose()`를 제공합니다. 선택적으로
host-owned resource를 위한 `openResource()`를 제공할 수 있습니다.

Viewer event vocabulary는 `selection.changed`, `viewport.changed`,
`context.request`, `source.reveal`, `diagnostics.changed`, `diff.open`,
`humanAction.request`입니다. `ViewerIdentityController`는 제품의 bounded pick
projection을 source의 revision-bound external identity로 resolve하고,
opaque Context Reference와 source reveal을 각각 `context.request`,
`source.reveal` event로 전달합니다. 두 event detail은 protocol/session/
revision/snapshot/layer scope, monotonic sequence, reason, identity와 opaque
reference를 포함합니다. `humanAction.request`는 intent일 뿐 capability 또는
approval evidence가 아닙니다.

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
handle, source, layer와 point만 투영합니다. Service source는
`ViewerIdentityController.resolvePick()` 결과를 같은 selection projection에
사용해 external identity token과 world bounds를 유지할 수 있습니다.
Render Delta를 적용한 adapter는
`ViewerSelectionController.advanceRevision()`으로 기존 선택을 지우고 다음
`selection.changed`를 적용된 render revision에 묶습니다.

실제 WebGL CAD shader와 CPU DWG candidate decoder, DOM inspector는 아직
`packages/webview`에 있습니다. Core는 이 구현을 import하지 않으며 이후
renderer data model과 일반 `viewer-ui` 경계를 별도 단계로 이동합니다.

일반 review toolbar와 result panel의 DOM lifecycle은 별도
`@dwg-viewer/viewer-ui` package가 소유합니다. Viewer Core는 이 package를
import하지 않으며 Host event와 rendering lifecycle만 유지합니다.
