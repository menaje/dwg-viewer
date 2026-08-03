# dwg-viewer

대형 DWG와 국내 한글 SHX/BigFont 도면을 로컬에서 여는 무료·오픈소스
VS Code 읽기 전용 뷰어입니다.

엔진 비교 결과 GNU LibreDWG 0.14를 주 엔진 경로로 선택했습니다.
이전에 비교 기준으로 사용하던 acadrust 변환기는 폐기·제거했습니다.
ACadSharp 3.6.51도 파싱만으로 메모리 하드 한도를 넘어 대형 도면
경로에서 제외했습니다. 결정 근거와 GPL 배포 경계는
[`docs/engine-decision.md`](docs/engine-decision.md)에 정리되어 있습니다.
브라우저 기반 Webview 프로토타입은 캐시 전체를 메모리에 올리지 않고
첫 화면용 버퍼만 읽어 WebGL2로 그린 뒤 한글 문자 원본을 별도 범위로
읽습니다. HATCH 원본과 채움·패턴 선도 첫 선 화면 이후 별도 워커에서
범위 읽기·생성하고, POINT·SOLID·3DFACE·WIPEOUT 역시 상한이 있는
일회성 워커에서 처리하므로 초기 로딩을 막지 않습니다.

## 원칙

- 도면은 외부 서버로 전송하지 않습니다.
- 원본 전체를 거대한 JavaScript 객체 그래프로 만들지 않습니다.
- 블록은 공유 형상과 인스턴스 변환으로 유지합니다.
- 한글과 대형 도면 성능을 초기 합격 조건으로 다룹니다.
- 유료 SDK나 비공개 렌더링 엔진을 사용하지 않습니다.

독립 DWG Viewer와 공용 Viewer Core의 package 경계, version 규칙과 단계적
추출 순서는
[`ADR-0001`](docs/adr/ADR-0001-viewer-core-boundary.md)에 있습니다.
같은 Core의 두 번째 3D consumer는 독립
[`bim-explorer`](https://github.com/menaje/bim-explorer)에서 검증하며,
Coni Spatial은 호환 package만 bundle하고 두 standalone Viewer 제품
설치에 의존하지 않습니다.
`@menaje/viewer-render-protocol`, `@menaje/viewer-core`와
`@menaje/viewer-ui` 0.1.0은
[Viewer Core release](https://github.com/menaje/dwg-viewer/releases/tag/viewer-core-v0.1.0)와
GitHub Packages에 배포된 source-neutral public preview이며 현재 GitHub
Release 상태는 prerelease입니다. 이후 태그 배포는 compatibility manifest의
명시적 승인 없이는 CI가 거부합니다. 기존 VS Code
`dwg-*` message는 public protocol로 노출하지 않습니다. standalone
Browser 파일과 VS Code cache channel은 모두 `DwgSceneCacheSource`와 같은
Viewer Core runtime을 통해 현재 renderer를 mount합니다. Core는
renderer/detail target 계약, 상한형 상세 스트리밍과 revision-bound
selection event lifecycle을 소유합니다. Viewer UI는 review toolbar의 DOM
상태, 접근성 속성, bounded 결과 panel과 event disposal을 소유하며 Webview는
DWG 배치 가시성·객체 판독, CAD 속성 투영과 WebGL 구현만 어댑터로
주입합니다.

Viewer 저장소가 소유하는 public package, clean artifact-only consumer,
standalone runtime과 Browser/VS Code 공용 진입점은 다음 명령으로 한 번에
검증합니다. 이 명령은 외부 저장소를 실행하거나 배포하지 않습니다.

```bash
pnpm run qualify:viewer-boundary
```

## 도면 엔진 벤치마크

`benchmark` 명령은 검사와 변환을 각각 독립 프로세스로 반복해 벽시계
시간, 최고 RSS, 출력 일관성과 성능 기준 판정을 하나의 JSON으로
기록합니다. 기본값은 준비 실행 1회와 측정 3회이며, 측정 중 만든 캐시는
매 회차 즉시 삭제합니다.

```bash
cargo build --release -p dwg-converter
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /absolute/path/to/libredwg-adapter \
  --engine-version 0.14 \
  --engine-license GPL-3.0-or-later \
  --pretty
```

비공개 결과는 Git에서 제외되는 `benchmarks/results/`에만 저장합니다.
선택된 LibreDWG 어댑터는 전역 설치 없이
[`adapters/libredwg`](adapters/libredwg/README.md)에서 준비할 수 있습니다.
실제 LibreDWG 0.14 WASM Worker 후보의 재현 방법과 탈락 근거는
[`adapters/libredwg/wasm`](adapters/libredwg/wasm/README.md)에 있습니다.
ACadSharp 파서 탈락 결과도
[`adapters/acadsharp`](adapters/acadsharp/README.md)에서 재현할 수 있습니다.
모든 후보는 같은 [`engine-adapter`](specs/engine-adapter.md) 계약으로
연결해 비교합니다.

raw DWG의 source-precision query와 change/Save As 판정은 별도
[`native-document-adapter`](specs/native-document-adapter.md) 계약을
사용합니다. 현재 제품은 Scene Cache v1.18 source record의 packed,
bounded handle/region query만 `query-preview`로 허용합니다. 실제
LibreDWG writer와 WASM MEMFS backend는 qualification Gate를 통과하지
못했으므로 output 생성 전에 명시적으로 차단하며, 읽기 전용 Viewer
동작에는 영향을 주지 않습니다.

LibreDWG 직접 변환기는 Scene Cache v1.18만 생성합니다. LINE,
LWPOLYLINE/2D·3D POLYLINE, ARC, CIRCLE, ELLIPSE, SPLINE과 HATCH
경계를 화면 버퍼와 정밀 원본으로 보존합니다. TEXT, MTEXT, ATTDEF,
ATTRIB, SHX/BigFont, POINT, SOLID, 3DFACE, WIPEOUT, 도면 순서,
XREF 경로·공간 클립, 선종류, 저장된 뷰, 다중 레이아웃·뷰포트,
IMAGE/IMAGEDEF도 같은 현재 스키마에 포함합니다. OLE2FRAME은 실제
삽입 외곽선을 표시하지만 포함된 Excel·그림 본문은 아직 해석하지
않습니다. Webview는 현재 화면과 교차하는 JPG·PNG만 요청하고 이미지
전송·디코딩 메모리를 제한합니다.
LibreDWG의 `ANSI_949` 문자열은 캐시에 쓰기 전에 UTF-8로 변환하므로
한글 레이어·블록·문자 때문에 Webview 열기가 중단되지 않습니다. 비공개
코퍼스용 익명 검사도 같은 변환 뒤 한글·손상 문자를 집계합니다.
MTEXT는 저장된 WCS X축, 부착점, 폭, 열 수·폭·간격·높이와 배경 채움을
제한형으로 표시합니다. 중첩된 인라인 글꼴·색·높이·폭·자간·기울기와
밑줄·윗줄·취소선도 4,096자·32단계 상한 안에서 run별로 적용합니다.
`\S` 수평 분수·대각 분수·공차는 작은 글자와 구분선을 별도 배치하고
줄바꿈 중 하나의 단위로 유지합니다. `\p` 첫 줄·좌우 들여쓰기와
왼쪽/가운데/오른쪽 사용자 탭, `^I` 탭도 폭 계산과 실제 배치에 함께
적용하며 저장된 도면 단위는 문자 높이 기준으로 정규화하고 `tz` 탭
초기화를 처리합니다. 명시적인 위→아래 MTEXT와 수직 문자 스타일도 글자를
회전시키지 않은 채 위에서 아래로, 다음 문단을 오른쪽에서 왼쪽 열로
배치합니다. TEXT는 저장된 OCS 평면을 WCS로 변환하고 DWG가 계산한
삽입점을 다시 정렬하지 않으며, Align/Fit만 두 기준점 사이 폭을
적용합니다. 비-Z OCS와 모든 justification 조합의 외부 기준 이미지
대조는 계속 보완합니다.

## Scene Cache v1.18

현재 캐시 작성기는 LINE, ARC, CIRCLE, INSERT, 해석 가능한 DIMENSION
그림 블록 참조, LWPOLYLINE/POLYLINE, ELLIPSE, SPLINE과 네 문자 계열을
레이어·문자 스타일·공유 블록 정보와 함께 little-endian 이진 형식으로
저장합니다. Scene Cache v1.18은
원본 정밀 좌표와 별도로
로컬 원점 기반 `f32` GPU 선 버퍼를 만들며, 첫 화면용 데이터는 최대
4MiB, 개별 상세 청크는 최대 512KiB로 제한합니다. 블록 형상은 배치
횟수와 관계없이 한 번만 저장합니다. 원호, 원, 타원, 폴리라인 불지와
NURBS 스플라인은 상한이 있는 1차 곡선 LOD로 먼저 표시합니다. 4배 이상
확대가 멈추면 별도 Worker가 보존된 정밀 원본을 화면 오차 0.5px 이하로
다시 세분화하며, 블록 정점은 INSERT마다 복제하지 않습니다. HATCH는 같은 상한형
경계 청크와 별도의 `f64` 닫힌 링 원본으로 저장합니다. 솔리드와
그라데이션은 첫 화면 이후 채우고, 패턴 정의선은 현재 화면과
교차하는 구간만 제한형 GPU 선으로 생성합니다.
POINT·SOLID·3DFACE·WIPEOUT 원본은 첫 화면 범위에 포함하지 않으며,
별도 워커가 공유 블록 인스턴스를 유지한 채 최대 32MiB의 GPU 버퍼로
변환합니다. WIPEOUT 프레임은 SOLID/3DFACE와 8MiB 외곽선 버퍼를
공유하고, 가림 채움은 도면 순서 지원 전까지 생성하지 않습니다.
LibreDWG 어댑터는 기존 출력을 덮어쓰지 않으며 생성 직후 헤더, 섹션
범위, 중복, 레코드 크기와 문자열 테이블을 검증합니다. 제품 Webview와
벤치마크 도구는 v1.18 이외의 캐시를 거부합니다.

캐시 형식은 [`specs/scene-cache.md`](specs/scene-cache.md)에 정의되어
있습니다. 생성된 캐시에도 도면 정보가 포함될 수 있으므로 Git에 올리지
않습니다.

## Webview 첫 화면과 한글 검증

MIT 라이선스의 `@mlightcad/shx-parser`를 포함한 잠금 버전 의존성을
준비한 뒤 정적 서버로 프로토타입을 실행합니다. HATCH 삼각분할에는
ISC 라이선스의 `earcut`을 사용하며 두 패키지 모두 정확한 버전으로
잠급니다.

```bash
pnpm install --frozen-lockfile
python3 -m http.server 4173 --bind 127.0.0.1 --directory .
```

브라우저에서 `http://127.0.0.1:4173/packages/webview/`를 엽니다. Scene Cache
reader가 공용 source package로 분리되어 있으므로 저장소 루트를 정적 서버
root로 사용합니다.

브라우저에서 `http://127.0.0.1:4173/packages/webview/`를 열고 변환된 `.cache` 파일을
선택합니다. 브라우저는 로컬 파일에서 헤더, 렌더 메타데이터와 최대
4MiB의 첫 화면 정점만 범위 읽기합니다. 블록 형상은 한 번만 GPU에
올리고 변환 행렬로 반복 배치합니다. 휠 또는 화면 버튼으로 확대하고
마우스로 이동하면 화면과 교차하는 LOD 1 청크만 추가로 읽습니다.
사각 영역을 드래그해 확대하고, 이동·확대 작업의 이전/다음 화면을
오갈 수 있습니다. 현재 화면은 사용자가 정한 이름으로 북마크하며
모델 공간과 각 배치별로 분리해 저장합니다.
레이어 패널에서는 한글 이름을 검색하고 개별 또는 전체 레이어를
켜고 끌 수 있습니다. 현재 도면과 외부참조 그룹은 특정 샘플 이름이나
설정값이 아니라, 열 때마다 해당 DWG의 레이어 테이블과 외부참조 종속
레이어 표기(`참조명|레이어명`)에서 동적으로 만듭니다. 임의의 한글·영문·
혼합 참조명과 중첩 참조를 그대로 처리합니다. 가시성을 바꿀 때는 형상을
다시 읽거나 GPU에 다시 올리지 않고 작은 레이어 가시성 텍스처만
갱신합니다.

객체 선택은 현재 도면뿐 아니라 연결된 임의 이름의 중첩 외부참조에서
HATCH·SOLID·3DFACE를 함께 찾습니다. 외부참조의 INSERT 변환, XCLIP,
루트 레이어 매핑과 가시성, 자식 Layer 0 상속을 그대로 적용하며
`xtitle` 같은 샘플 파일명이나 특정 도면 속성을 기본값으로 가정하지
않습니다.

인스턴스 행렬은 draw call마다 새 배열을 만들지 않고 최대 16,384개짜리
하나의 점진 확장 작업 버퍼를 재사용합니다. 화면 지표에는 Chromium이
제공하는 현재/세션 최고 JavaScript 힙과 WebGL 정점·인스턴스·레이어
텍스처의 현재/최고 추적 메모리를 함께 표시합니다. JavaScript 힙 API가
없는 브라우저에서는 지원하지 않는다고 명시하며 임의의 추정값을 만들지
않습니다. WebGL 드라이버와 기본 framebuffer 같은 브라우저 내부 메모리는
추적 GPU 값에 포함하지 않습니다.

문자는 첫 도형 화면이 나온 뒤 별도 범위로 읽습니다. `SHX 글꼴`에서
도면 스타일이 참조하는 기본 SHX와 BigFont 파일을 함께 선택하면 요청된
글자만 벡터 선분으로 해석해 제한된 LRU 캐시에 보관합니다. 글꼴이 없거나
해당 글리프가 없으면 한글 시스템 글꼴로 대체합니다. 글꼴 파일은 서버로
전송되지 않으며 브라우저 세션 메모리에만 등록됩니다.

VS Code 확장에서는 도면이 실제로 요구한 SHX/BigFont/TTF/OTF만 첫
화면 뒤에 찾습니다. 존재하는 저장 상대·절대 경로, 도면 폴더, 제한된
프로젝트·패키지 폴더, `dwgViewer.shxFontDirectories` 등록 폴더
순서이며 같은 순위 후보는 자동 선택하지 않습니다. 이름이 다른 대체
파일은 `dwgViewer.shxFontMappings`로 연결하거나 글꼴 패널에서 현재
도면에 쓸 파일을 직접 선택할 수 있습니다. 요청은 직렬 처리하며 파일당
32MiB, 도면당 전송 64MiB, 128개 요청으로 제한합니다. 글꼴 패널은
연결, 대체, 동점, 누락, 손상, 읽기 실패와 한도 초과를 구분합니다.

레이아웃이 참조하는 CTB도 같은 경로 우선순위와 제한형 검색을 사용합니다.
동점·누락 시 `출력 선택`에서 현재 도면용 CTB를 직접 고를 수 있고, 출력
색상·선굵기는 해당 레이아웃에만 선택적으로 적용하며 Model 화면에는
강제하지 않습니다.

`PNG/PDF`에서는 현재 화면, 현재 탭 전체 또는 모든 배치를 저장할 수
있습니다. 각 배치가 가진 임의 용지 크기와 회전값을 우선 사용하고 값이
없을 때만 선택한 규격 용지로 대체합니다. 1:N 축척은 DWG 삽입 단위나
사용자가 측정 설정에서 보정한 실제 단위를 사용하며, 단위 없는 도면을
임의로 mm로 해석하지 않습니다. 전체 배치 PNG는 운영체제 기본 압축
도구와 호환되는 ZIP 파일명과 원래 유니코드 배치명 매핑을 함께 저장합니다.

BigFont 한글 코드는 기본적으로 파일명을 추측하지 않고 실제 글리프를
`EUC-KR → CP949/UHC → Johab/CP1361` 순서로 확인합니다. EUC-KR의
94×94 영역과 CP949 확장 완성형을 분리하며, Johab은 현대 한글
11,172자 전체를 조합식으로 변환합니다. CP1361의 KS X 1001 기호
892자·한자 4,888자와 추가 기호 `®`, `€`도 공식 매핑과 같은 슬롯으로
변환합니다. 코드 슬롯이 겹치는 국내 글꼴은 다음처럼 도면이 요청한
BigFont 이름별로 고정할 수 있고, 적용된 방식은 글꼴 패널에 표시됩니다.

```json
{
  "dwgViewer.shxBigFontEncodings": {
    "ksc.shx": "euc-kr",
    "whgtxt.shx": "cp949",
    "hanjohab.shx": "johab"
  }
}
```

허용값은 `auto`, `euc-kr`, `cp949`, `johab`이며 창당 최대 128개입니다.
호환·옛한글 자모처럼 CP1361 슬롯을 아직 명시하지 않은 문자는 직접
Unicode 글리프 또는 시스템 글꼴 대체 경로를 사용합니다.

HATCH도 첫 선 화면이 나온 뒤 전용 워커가 원본 섹션을 읽습니다.
솔리드·그라데이션의 닫힌 링은 블록 공유 구조를 유지한 채 로컬 원점
GPU 삼각형으로 만들고 선보다 먼저 그립니다. 원본은 HATCH당 65,536개,
전체 1,048,576개 정점으로 제한하며, 최종 채움 GPU 버퍼는 32MiB를
넘지 않습니다. v1.7 패턴은 1.5픽셀보다 촘촘한 정의를 생략하고,
보이는 블록 인스턴스의 공통 구간만 생성합니다. 한 화면은 최대
250,000개 패턴 선분(16MiB 정점), HATCH당 65,536개 선분과 800만 회
경계 교차 검사로 제한합니다. 워커는 원본과 인스턴스 그래프를 한 번만
읽어 유지하고, 160ms 동안 화면 조작이 멈춘 뒤 패턴만 다시 만듭니다.
새 파일을 열면 이전 작업은 취소됩니다.

POINT·SOLID·3DFACE·WIPEOUT은 첫 선 화면 뒤 HATCH보다 먼저 일회성
워커에서 읽습니다. POINT 표시는 8MiB, SOLID 채움은 16MiB,
SOLID·3DFACE·WIPEOUT이 공유하는 외곽선은 8MiB로 각각 제한하고,
결과를 전송하면 워커를 종료합니다. 따라서 원본 버퍼를 화면
프로세스에 계속 보관하지 않고 HATCH 원본 처리와의 순간 메모리
중첩도 피합니다.

WIPEOUT 마스크는 Scene Cache 정렬표를 첫 화면 이후에만 읽어 블록별
앞·뒤 순서로 압축합니다. 중첩 INSERT, DIMENSION 그림 블록과 MINSERT
배열은 기존 인스턴스 행렬을 복사하지 않고 순서 기준값 하나만
덧붙입니다. WebGL 깊이 버퍼와 Canvas 문자 클리핑이 같은 순서를
사용하며, 확장 마스크 10,000개 또는 마스크 GPU 8MiB를 넘거나
순환·잘못된 경계를 만나면 마스크만 모두 끄고 도형과 프레임은
계속 표시합니다.

Webview 단위 검사는 다음 명령으로 실행합니다.

```bash
pnpm test:webview
```

## VS Code에서 DWG 열기

`apps/vscode-extension`은 `.dwg`를 읽기 전용 Custom Editor로 엽니다.
원본은 외부로 전송하지 않으며, 별도로 설치한 GPL LibreDWG 어댑터를
로컬 보조 프로세스로 실행해 해시 캐시를 만듭니다. MPL 개발 VSIX에는
GPL 연결 바이너리를 포함하지 않습니다.

```bash
pnpm --filter dwg-viewer-vscode package:vsix
```

생성된 VSIX를 설치한 뒤 명령 팔레트에서
`DWG Viewer: LibreDWG 변환기 선택`을 실행합니다. 선택한 파일은 도면을
열지 않는 5초 제한 진단을 통과해야 저장됩니다. 이 진단은 선택하거나
직접 요청할 때만 실행하므로 평상시 도면 로딩에는 시간이 추가되지
않습니다. 확장 호스트는 캐시 전체를 메모리로 읽지 않고 Webview가
요청하는 구간만 전달합니다. 요청 하나는 최대 8MiB, 동시 파일 읽기는
최대 4개로 제한됩니다. 편집기를 닫거나 진행 알림에서 취소하면 변환
프로세스, 임시 파일, 캐시 파일 핸들과 대기 중 요청을 정리합니다.

Scene Cache v1.18 도면의 외부 DWG 참조는 먼저 사용자가 저장한 수동
연결, 현재 운영체제에서 유효한 원본 절대경로, 도면 기준 상대경로,
도면 옆 `xref` 폴더를 확인합니다. 없으면 파일명이 같은 후보를 도면
폴더와 등록한 검색 폴더 안에서만 찾고, 원본 경로의 바로 위 폴더·그 위
폴더가 더 많이 일치하는 후보를 우선합니다. 최고 점수가 같은 파일은
임의로 고르지 않고 `외부 참조` 패널에서 직접 선택하도록 표시합니다.
선택 결과는 현재 참조, 같은 파일명 또는 이전 폴더 전체 치환 범위로
워크스페이스에 저장할 수 있습니다.

Windows 드라이브·UNC·POSIX·상대경로와 `..`를 운영체제와 무관하게
해석하고, macOS의 Unicode 정규화 차이와 Windows의 대소문자 차이를
비교 단계에서 흡수합니다. 자동검색은 루트 32개, 깊이 8, 항목 50,000개,
후보 256개로 제한하며 심볼릭 링크를 재귀 순회하거나 디스크 전체를
검색하지 않습니다. 참조 변환과 Webview 로드는 각각 직렬화하고,
순환·8단계 중첩·64개 참조를 차단합니다. 참조 첫 화면 원본, 첫 화면
GPU, 상세 GPU는 각각 전체 32MiB 한도를 적용해 참조 수만큼 메모리가
무제한 증가하지 않게 합니다. 추가 검색 폴더는 다음처럼 지정합니다.

```json
{
  "dwgViewer.xrefSearchDirectories": [
    "/absolute/path/to/project-drawings"
  ]
}
```

IMAGE 참조도 같은 경로 우선순위와 수동 선택 방식을 사용합니다. 현재
JPG/JPEG와 PNG만 표시하며, 도면별 추가 검색 폴더는
`dwgViewer.imageSearchDirectories`로 지정합니다. 개별 파일은 32MiB,
원본은 1억 픽셀, 열린 도면의 고유 압축 전송은 64MiB로 제한하고,
Webview 디코딩은 이미지당 약 8백만 픽셀·전체 64MiB RGBA LRU로
제한합니다.

처음 여는 대형 도면은 기본적으로 Native 변환을 먼저 끝낸 뒤 Webview
내용을 초기화합니다. LibreDWG 파서와 완전히 초기화된 Webview 렌더러가
겹치지 않게 해 메모리 피크를 낮추기 위한 순서입니다. 빠른 첫 화면이 더
중요한 고메모리 환경에서는 `dwgViewer.progressivePreview`를 켤 수
있습니다. 이때 같은 변환 프로세스가 4MiB 제한 개요가 든 독립 미리보기
캐시를 먼저 내보내고, Webview는 이를 표시한 채 전체 상세 캐시 준비를
계속합니다. 전체 캐시로 교체되면 미리보기 파일과 읽기 채널을 정리합니다.

LibreDWG 실행 파일은 정적으로 연결하고 정확한 LibreDWG 소스·GPL
전문·빌드 스크립트·체크섬을 동봉한 별도 GPL 패키지로 만듭니다. 같은
바이너리와 소스로 두 번 만들면 바이트 단위로 같은 패키지가 생성됩니다.
현재 자동 검증 대상은 Linux x64, macOS arm64와 Windows x64입니다.
Windows는 Native 임시 파일·프로세스 격리, 드라이브·UNC·상대·한글 경로,
최신 VS Code의 100/125/150/200% 화면 배율을 별도 검증합니다.
VSIX와 세 어댑터를 각각 두 번 만들어 비교하고, GPL 혼입을 검사하며,
체크섬과 무료 GitHub 빌드 증명을 생성하는 최종 절차는
[`docs/distribution.md`](docs/distribution.md)에 정리했습니다.

확장 내부에서는 Native 변환기도
[`dwg-scene-engine/1`](specs/scene-engine.md) 공통 계약 뒤에서
실행합니다. 캐시 키는 도면 지문뿐 아니라 엔진·버전·Native/WASM
백엔드·변환 옵션·실행 구현 리비전을 포함하므로 서로 검증되지 않은
백엔드의 캐시가 섞이지 않습니다. 실제 LibreDWG 0.14 WASM 빌드는 작은
공개 도면에서 Native와 바이트가 같은 캐시를 만들고 Worker 취소도
통과했습니다. 그러나 기준 대형 도면에서는 문자열 테이블은 같아도 문자
배치·GPU·HATCH 형상 5개 섹션이 달랐고, 전체 출력을 비교할 때 최고 RSS가
2,983,854,080바이트까지 증가했습니다. 실제 Chromium Worker에서는 작은
도면도 30초 안에 끝내지 못했습니다.
따라서 [이슈 #17](https://github.com/menaje/dwg-viewer/issues/17)의 현재
WASM 후보는 탈락했으며 설정, 자동 대체 경로, VSIX에 포함하지 않습니다.

한글 SHX/BigFont는 뷰어의 `글꼴` 패널에서 로컬 폴더를 한 번 추가하면
이후 필요한 파일을 자동 연결합니다. 도면과 폴더의 절대 경로는
Webview에 전달하지 않고, 일치한 글꼴의 바이트와 파일명·상태만
전달합니다.

확장 및 Webview 검사는 다음 명령으로 함께 실행합니다.

```bash
pnpm check
```

VS Code 1.131의 격리된 Extension Development Host에서 24,680,147바이트
기준 도면을 실제로 열어 검증했습니다. 새 177,049,408바이트 캐시를
공통 `SceneEngine` 경유 정적 LibreDWG 패키지로 만든 경우 호스트
시작부터 첫 화면까지 4,347ms, Webview 렌더 단계는 494ms였습니다.
같은 캐시를 다시 열었을 때는 각각 615ms와 513ms였고 JavaScript 힙
최고값은 60.01MiB였습니다. 변환기 누락 복구 화면과 별도 진단 명령도
실제 확장 호스트에서 확인했으며, Renderer 경고와 오류는 0건이었습니다.

VS Code 1.131 제품 프로세스 전체를 100ms 간격으로 추적하고 macOS
`footprint`으로 공유 매핑을 중복 제거한 최종 검증에서, 안정된 호스트의
기본 균형 모드는 첫 화면 3,736~3,795ms, VS Code 기준선 대비 증분 물리
메모리 530,435,720~595,660,352바이트를 기록해 두 목표를 모두
통과했습니다. 변환 도중 닫은 경우 편집기 정리 뒤 변환기 0개를 3회 연속
확인했고, 최종 표본의 변환기 종료는 286ms였습니다.

선택형 빠른 미리보기는 안정된 호스트에서 첫 화면 1,824ms, 증분
664,686,480바이트로 시간 목표와 800MB 하드 한도는 통과했지만 600MB
목표는 넘었습니다. VS Code 시작 직후 변환과 렌더러가 겹친 표본에서는
919,359,496바이트로 하드 실패했으므로 기본값은 꺼져 있습니다.
프로세스 RSS 단순 합계와 VS Code 기준선을 포함한 물리 메모리는 보고서에
진단값으로 남기되, 공유 페이지 중복과 호스트 자체 비용 때문에 제품
증분 게이트로 사용하지 않습니다.

## 성능 합격 기준

기준 대형 도면에서 다음을 목표로 합니다.

- 변환기 처리: 5초 이하
- 첫 화면: 목표 5초, 최대 8초
- 전체 정밀화: 15초 이하
- Native 변환기 최고 RSS: 목표 600MB, 최대 800MB
- 안정된 VS Code 기준선 대비 제품 증분 물리 메모리: 목표 600MB,
  최대 800MB
- Webview 안정 메모리: 300MB 이하
- 배열 할당 실패와 블록 누락: 0건
- 한글 문자열 손실: 0건

개발 로드맵은 [GitHub 이슈 #8](https://github.com/menaje/dwg-viewer/issues/8)에서
관리합니다.
