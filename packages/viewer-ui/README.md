# `@dwg-viewer/viewer-ui`

Viewer의 source-neutral DOM composition package입니다. Viewer Core의
renderer/source lifecycle과 분리되어 있으며 DWG Scene Cache, VS Code API,
Spatial Workspace 또는 제품별 selection record를 import하지 않습니다.

현재 첫 public surface인 `ViewerReviewUiController`는 다음을 소유합니다.

- review toolbar의 활성 도구와 `aria-pressed` 상태
- 다점 도구의 완료 버튼 표시
- toolbar/result action event binding과 idempotent disposal
- bounded result view model의 text-only DOM rendering
- generic result action과 product-owned data attribute projection

DWG 후보 탐색, CAD 속성 이름, 측정 계산과 layer action 의미는
`packages/webview` adapter에 남습니다. 다른 제품은 자신의 selection을
`title`, `rows`, `actions` view model로 투영해 같은 controller를 사용할 수
있습니다.

이 package는 DOM bootstrap을 만들지 않습니다. 제품 shell이 이미 소유한
canvas, toolbar와 result element를 주입하며, controller disposal 후에는
다시 사용할 수 없습니다.
