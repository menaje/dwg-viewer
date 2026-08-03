# Viewer compatibility

`viewer-core.json`은 이 저장소가 생산하는 Viewer Core, Viewer UI와 render
protocol의 호환 기준을 기록한다.

- `public-preview`는 package/API가 공개 배포됐지만 아직 `0.x` compatibility
  window에 있다는 뜻이다.
- `releaseStage: prerelease`는 현재 GitHub Release가 최종 승격되지 않았다는
  뜻이다. `tagPublicationApproved: false`인 commit에서는 태그 workflow가
  package나 Release를 배포하지 않는다.
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

`pnpm run qualify:viewer-boundary`는 세 public tarball을 두 번 pack해 byte
동일성과 manifest SHA-256을 확인하고, 빈 임시 consumer에 artifact만 설치해
RenderSource/Service fixture와 standalone runtime을 실행한다. Browser와
VS Code가 같은 Webview entrypoint를 bundle하는지도 확인한다. 이 저장소가
소유하지 않는 BIM/Spatial consumer qualification은 실행하거나 수정하지
않으며 각 consumer manifest가 책임진다. 고정 evidence는
[`evidence/viewer-boundary-2026-08-04.json`](evidence/viewer-boundary-2026-08-04.json)에
있다.

`native-document-adapter.json`은 raw DWG query/change/write backend의
operation별 admission을 별도로 기록한다. 현재 Native는 bounded packed
query만 `query-preview`이고 writer는 실제 no-op round-trip 실패 때문에
output 예약 전에 `blocked`된다. WASM MEMFS 후보도 memory/Browser Gate
실패로 제품 비허용이다. 계약 fixture의 writer 성공은 실제 LibreDWG writer
승격으로 해석하지 않는다. 실행 증거는
[`evidence/native-document-adapter-2026-08-04.json`](evidence/native-document-adapter-2026-08-04.json)에
있다.
