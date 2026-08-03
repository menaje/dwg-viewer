---
type: adr
status: accepted
authority:
  - viewer-core-package-boundary
  - viewer-render-protocol-versioning
last_reviewed: 2026-08-03
decision_id: ADR-0001
tracking:
  - https://github.com/menaje/dwg-viewer/issues/26
  - https://github.com/menaje/dwg-viewer/issues/30
---

# ADR-0001: 독립 Viewer 제품과 공용 Viewer Core 경계

## Context

현재 제품은 raw DWG를 여는 VS Code Custom Editor이며, 검증된 renderer,
camera, interaction, picking과 Scene Cache streaming 구현은
`packages/webview`에 함께 있다. 이 구현은 독립 DWG Viewer에서 계속
동작해야 하지만, Coni Spatial도 renderer 코드를 복사하거나 설치된
DWG Viewer extension을 제어하지 않고 같은 Viewer Core를 사용할 수 있어야
한다. raw BIM을 read/index/render하는 독립 `bim-explorer`도 세 번째
consumer로 추가됐으며 source-neutral lifecycle, identity와 selection
계약을 공유해야 한다.

현재 `dwg-*` Host–Webview message와 `acquireVsCodeApi()` 호출은 제품 shell의
private transport다. 이를 public Viewer–Service protocol로 사용하면 VS Code,
Scene Cache와 현재 message lifecycle이 외부 source 구현에 노출된다.

반대로 계약 없이 renderer 파일부터 이동하면 raw DWG 회귀를 만들고,
Render Snapshot/Delta와 Service integration을 구현할 때 다시 경계를
바꾸게 된다.

## Decision

독립 DWG Viewer, BIM Explorer와 Coni Spatial 제품은 저장소, 설치물과
release를 분리한다. `dwg-viewer`는 다음 versioned package 경계를
소유한다.

| Package | 책임 | 포함하지 않는 것 |
| --- | --- | --- |
| `@dwg-viewer/render-protocol` | source/session/snapshot/range의 Viewer-facing 계약과 fail-closed validation | Spatial Workspace, Agent method, Host private message |
| `@dwg-viewer/viewer-core` | source/host lifecycle, renderer, camera, interaction, picking과 generic layer 합성 | DOM bootstrap, VS Code API, DWG parser, permission 판정 |
| `@dwg-viewer/dwg-scene-source` | Scene Cache reader, range/detail streaming과 `DwgSceneCacheSource` | Viewer UI, Spatial revision authority |
| `@dwg-viewer/viewer-ui` | 일반 toolbar, inspector와 DOM composition | Spatial semantic panel |
| `@dwg-viewer/vscode-bridge` | VS Code resource/range/file association adapter | public Service protocol |
| `@dwg-viewer/browser-bridge` | Blob/HTTP/mock host adapter | VS Code API |

첫 구현 단위는 `render-protocol`과 `viewer-core`의 최소 계약이다. 그 위에
canonical Scene Cache reader와 `DwgSceneCacheSource`를 두고 기존 Webview
경로는 compatibility re-export로 유지한다. renderer/camera/interaction
lifecycle은 Browser/VS Code conformance를 추가한 뒤 Core로 옮긴다.

현재 `@dwg-viewer/*` 이름은 workspace-only experimental package
namespace다. BIM Explorer 3D consumer conformance를 통과하기 전에 이를
source-neutral public namespace로 주장하지 않으며, 이름 변경 여부는
breaking public release 전에 확정한다.

generic 3D renderer와 BIM exploration UI는 `bim-explorer`가 소유한다.
Coni Spatial은 호환 3D/BIM package 위에 revision-bound base/live/diff
overlay와 Context Reference integration을 추가한다. 현재 2D renderer를
범용 3D engine으로 확장하거나 구현을 저장소 사이에 복사하지 않는다.

## Public contract 원칙

`RenderSource`는 지원 render protocol version을 선언하고, 협상된 exact
version으로 session을 연다. 열린 session은 다음을 제공한다.

- session/source/current revision/last-successful revision identity
- bounded resource budget과 feature vocabulary
- revision-bound Render Snapshot
- capability가 선언된 경우에만 range read, revision event, delta와 pick hook
- 취소와 idempotent disposal

`ViewerHost`는 typed Viewer event와 host-owned resource 요청을 처리하는
adapter다. Host는 Workspace authority, Canonical ID authority 또는 trusted
human capability를 발급하지 않는다.

다음은 public package 계약이 아니다.

- `dwg-cache-*`, font/XREF/image와 export를 포함한 기존 Host–Webview message
- `acquireVsCodeApi()`와 Custom Editor lifecycle
- LibreDWG process, native pointer와 실제 source/export path
- IFC parser object, Express ID pointer와 BIM engine 내부 graph
- Coni Spatial의 Agent–Service method, credential와 acceptance/publish 권한

## Version과 compatibility

Viewer Core package, render protocol과 DWG Viewer 제품은 각각 semantic
version을 가진다. BIM Explorer product/source package, Spatial Protocol과
Viewer package version도 서로 독립적이다.

- `0.x`에서 breaking contract change는 minor version을 올린다.
- compatible validation/diagnostic 수정은 patch version을 올린다.
- source와 Core는 exact render protocol version을 handshake에서 선택한다.
- product version이나 Host private message version으로 호환성을 추측하지
  않는다.
- producer manifest는
  [`compatibility/viewer-core.json`](../../compatibility/viewer-core.json)에
  기록한다.
- consumer는 package/version range와 실제 conformance 결과를 별도 manifest에
  pin한다.

초기 package는 `workspace-only`와 `experimental`이다. npm 또는 GitHub
Release artifact 배포 방식이 결정되고 cross-repository fixture가 통과하기
전에는 외부 제품 호환을 주장하지 않는다.

## Extraction 순서

1. 계약 package, producer compatibility manifest와 mock conformance
2. `DwgSceneCacheSource`와 Browser mock source
3. VS Code/DOM bootstrap에서 Viewer lifecycle 분리
4. 같은 Core를 사용하는 Browser와 VS Code qualification
5. Service RenderSource, external identity/context event
6. ordered Render Delta와 revision diff
7. BIM Explorer의 source-neutral 3D consumer conformance
8. Spatial의 BIM base/Canonical identity/live-diff integration conformance

각 단계는 raw DWG open, selection, measurement, Korean text, first-frame와
memory qualification을 유지해야 한다. 파일 이동 자체를 완료 조건으로
삼지 않는다.

## Consequences

- 기존 Webview와 새 package가 잠시 공존한다.
- 초기에는 adapter code가 얇게 중복 연결될 수 있지만 renderer 구현을
  복사하지 않는다.
- public contract는 현재 VS Code message보다 작고 source-neutral하다.
- BIM Explorer는 standalone DWG Viewer 설치 없이 `BimModelSource`와
  generic 3D surface를 제공할 수 있다.
- Coni Spatial은 standalone DWG Viewer 설치 없이 호환 package를 bundle할
  수 있으며 BIM Explorer extension 설치에도 의존하지 않는다.
- 2D와 3D surface는 같은 lifecycle/identity/selection 계약을 사용하지만
  서로 다른 renderer backend와 제품 package를 가질 수 있다.

## Implementation status

2026-08-03 기준으로 1–2단계의 contract, compatibility manifest,
`DwgSceneCacheSource`, Browser mock과 공용 conformance가 구현되었다.
standalone Browser와 VS Code Webview도 같은 `openViewerRuntime()`에서
source/snapshot을 열고 기존 renderer presentation을 mount한다. canonical
Scene Cache reader는 `dwg-scene-source`에만 있으며 Webview의 과거 경로는
re-export다. source-neutral 2D camera도 Viewer Core로 이동했고 과거
Webview 경로는 같은 구현을 re-export한다.
source-neutral GPU batch LRU도 같은 방식으로 Core가 canonical 구현을
소유한다. Canvas viewport interaction lifecycle 역시 Core가 소유하고,
`ViewerRendererController`가 renderer capability와 root/XREF detail target
수명주기를 검사·조정한다. 상세 청크의 concurrency, byte-budget cache,
stale work, review publication과 redraw coalescing은
`DetailStreamingController`로 이동했다. 현재 Webview adapter는 Scene
Cache batch 가시성 계산과 reader/WebGL mapping만 주입한다.
`ViewerSelectionController`는 DWG pick projection을 active
session/revision/snapshot에 묶어 monotonic `selection.changed` Host event로
전달한다.
`pick.resolve`, Render/Pick/external identity, Context Reference와 source
reveal descriptor도 같은 snapshot layer와 revision에 묶여 검증된다.
`ViewerIdentityController`는 Service source의 identity/context/reveal hook을
호출하고 opaque reference만 `context.request`와 `source.reveal` Host event로
전달한다. `MockServiceRenderSource`와 재사용 가능한 service conformance는
base/live layer 합성, stale pick 거부와 disposal을 실행한다. 실제
`ConiServiceSource`, Canonical ID authority와 Context 저장소는 계속
`coni-spatial`의 책임이다.
`Render Delta`는 base snapshot, exact from/to revision, monotonic sequence,
affected bounds와 bounded opaque payload에 묶인다.
`ViewerRenderDeltaController`는 전체 entity graph 대신 변경된 Render ID의
tombstone/upsert, dependency/identity map과 preview만 보관하고 rollback 시
immutable base를 다시 읽지 않는다. renderer adapter hook은 원자적인 apply,
preview rollback/promotion만 요구하며 현재 Webview의 private DWG GPU
vertex format은 public protocol로 승격하지 않는다. Webview의
`DwgRenderDeltaAdapter`는 검증된 decoded v2 line/triangle-fill packet의 GPU
resource를 공용 64 MiB 한도 안에서 먼저 stage하고 renderer state를 한 번에
교체한다. private v1 line-only packet은 producer 전환 기간에 계속 읽는다.
base tombstone/upsert는 line
vertex handle, HATCH/POINT/SOLID/3DFACE/WIPEOUT의 압축 identity-range
sidecar와 Canvas text의 source-scoped handle filter를 통해 cached draw
range로 적용한다. 따라서 Scene Cache buffer를 수정하지 않으며 preview
rollback과 promotion은 같은 native identity/pick map을 사용한다.
`MockRenderDeltaSource`와 공용 conformance는 stale replay 뒤에도
source/overlay/pick revision이 함께 전진하는지 검증한다.
`@dwg-viewer/viewer-ui`의 첫 public controller는 review toolbar의 active
state와 접근성 속성, bounded text-only result row/action composition,
DOM listener disposal을 소유한다. DWG Webview는 candidate 판독과 CAD 속성,
측정 결과를 이 source-neutral view model로 투영한다.

아직 `packages/webview`에 있는 실제 WebGL CAD shader, DWG candidate decoder와
selection/measurement overlay, generic render data model의 물리적 package
이동은 남아 있다. 일반 Viewer UI도 toolbar/result lifecycle부터 이동했으며
layer/layout panel composition은 이후 단계다. #30의 실제 cross-repository
`ConiServiceSource` qualification과 #27의 fill/text/primitive delta packet,
split/overlay diff UI 및 대형 도면 qualification은 남아 있다. 제품 진입점을
먼저 runtime 계약에 연결했으므로 이후 이동은 raw range transport나 VS Code
private message를 Core API로 승격하지 않고 진행한다.

`bim-explorer`의 `BimModelSource`와 3D consumer는 아직 구현되지 않았다.
따라서 current package가 truly source-neutral하거나 3D-compatible하다고
주장하지 않으며 해당 evidence는
[bim-explorer #3](https://github.com/menaje/bim-explorer/issues/3)에서
추적한다. Spatial BIM identity/overlay integration은
[bim-explorer #9](https://github.com/menaje/bim-explorer/issues/9)가
추적한다.

## Revisit

실제 `DwgSceneCacheSource`, `BimModelSource` 또는 `ConiServiceSource`
conformance가 현재 session/snapshot 경계로 구현되지 않거나, 독립 제품
qualification이 반복해서 깨질 때 이 결정을 재검토한다. public contract
변경은 기존 version의 의미를 바꾸지 않고 새 version과 migration fixture로
수행한다.
