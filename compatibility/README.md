# Viewer compatibility

`viewer-core.json`은 이 저장소가 생산하는 Viewer Core, Viewer UI와 render
protocol의 호환 기준을 기록한다.

- `public-preview`는 package/API가 공개 배포됐지만 아직 `0.x` compatibility
  window에 있다는 뜻이다.
- `github-release-and-packages`는 공개 GitHub Release tarball과 GitHub
  Packages npm package를 함께 배포한다는 뜻이다.
- consumer는 release tarball의 exact URL과 SHA-256을 pin하거나 GitHub
  Packages의 exact version을 pin한다.
- consumer는 이 파일을 복사하지 않고 자신의 manifest에서 package version
  range와 실행한 conformance fixture를 기록한다.
- `product-runtime`은 해당 Host의 실제 제품 진입점이 Viewer Core runtime을
  거친다는 뜻이며 cross-repository package 배포 완료를 뜻하지 않는다.
- `core-lifecycle-with-*-adapter`는 lifecycle과 fail-closed contract는
  Core가 소유하지만 source-specific renderer 또는 pick decoder는 제품
  adapter가 제공한다는 뜻이다.
- `canonical-with-*-policy`는 cache/concurrency/disposal 구현은 Core가
  canonical이지만 가시성·선택 정책은 source adapter가 주입한다는 뜻이다.
- `canonical-dom-lifecycle-with-*-adapter`는 toolbar/result DOM 상태와
  disposal은 Viewer UI가 소유하고 product-specific 결과 의미는 adapter가
  투영한다는 뜻이다.
- 제품 version, Spatial Protocol version과 Host–Webview message version으로
  Viewer Core 호환성을 추측하지 않는다.

실제 package version, protocol version, artifact digest 또는 conformance
경로가 바뀌면 manifest와 package test를 같은 변경에서 갱신한다.
