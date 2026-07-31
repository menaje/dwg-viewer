# dwg-viewer

대형 DWG와 국내 한글 SHX/BigFont 도면을 로컬에서 여는 무료·오픈소스
VS Code 읽기 전용 뷰어입니다.

엔진 비교 결과 GNU LibreDWG 0.14를 주 엔진 경로로 선택했습니다.
`acadrust`는 교차 회귀 기준으로 유지하고, ACadSharp 3.6.51은 파싱만으로
메모리 하드 한도를 넘어 대형 도면 경로에서 제외했습니다. 결정 근거와
GPL 배포 경계는 [`docs/engine-decision.md`](docs/engine-decision.md)에
정리되어 있습니다.
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

## DWG 검사기

Rust 1.88 이상이 필요합니다.

```bash
cargo run --release -p dwg-converter -- inspect /path/to/drawing.dwg --pretty
```

기본 보고서는 도면 파일명과 실제 문자 샘플을 숨깁니다. 로컬 진단에만
필요하다면 다음 옵션을 명시적으로 사용합니다.

```bash
cargo run --release -p dwg-converter -- inspect /path/to/drawing.dwg \
  --pretty \
  --include-input-name \
  --text-samples 5
```

## 도면 엔진 벤치마크

`benchmark` 명령은 검사와 변환을 각각 독립 프로세스로 반복해 벽시계
시간, 최고 RSS, 출력 일관성과 성능 기준 판정을 하나의 JSON으로
기록합니다. 기본값은 준비 실행 1회와 측정 3회이며, 측정 중 만든 캐시는
매 회차 즉시 삭제합니다.

```bash
cargo build --release -p dwg-converter
target/release/dwg-converter benchmark /path/to/drawing.dwg --pretty
```

비공개 결과는 Git에서 제외되는 `benchmarks/results/`에만 저장합니다.
LibreDWG 후보는 전역 설치 없이
[`adapters/libredwg`](adapters/libredwg/README.md)에서 준비할 수 있습니다.
ACadSharp 파서 탈락 결과도
[`adapters/acadsharp`](adapters/acadsharp/README.md)에서 재현할 수 있습니다.
모든 후보는 같은 [`engine-adapter`](specs/engine-adapter.md) 계약으로
연결해 비교합니다.

LibreDWG의 현재 직접 변환기는 LINE, LWPOLYLINE/2D·3D POLYLINE,
ARC, CIRCLE, ELLIPSE, SPLINE과 HATCH 경계를 화면 버퍼로 만듭니다.
원호·원·타원과 폴리라인 불지는 회전당 최대 16개, SPLINE은 엔티티당
최대 256개 선분으로 제한하고, 지원되는 독립 곡선의 정밀 원본 레코드와
knot·weight·control/fit point는 별도로 보존합니다. Scene Cache v1.4는
TEXT, MTEXT, ATTDEF, ATTRIB과 문자 스타일·SHX/BigFont 파일명을 UTF-8로
함께 보존하고, v1.5는 HATCH당 최대 65,536개의 제한형 경계 미리보기를
추가합니다. v1.6은 닫힌 HATCH 경계, 패턴·그라데이션 메타데이터, 색상과
시드 점을 제한형 원본 레코드로 보존하고, Webview에서 솔리드와
그라데이션을 채웁니다. v1.7은 패턴 정의선과 dash 풀을 보존하고
화면 기반 패턴 선을 생성합니다. v1.8은 POINT의 WCS 좌표와
PDMODE/PDSIZE, SOLID의 OCS 네 모서리와 FILLMODE를 보존하고 첫 화면 뒤
표시합니다. 해석 가능한 DIMENSION은 별도 형상을 만들지 않고 도면이
가진 익명 그림 블록을 기존 블록 인스턴스 흐름에 연결합니다. v1.9는
3DFACE의 WCS 네 꼭짓점과 가장자리 숨김 비트를 보존하고 기본 선화
뷰에서 보이는 가장자리만 지연 표시합니다. v1.10은 WIPEOUT의 이미지
기준 벡터, 표시 속성, 원본 클립 경계와 전역 프레임 설정을 보존하고,
설정이 켜진 프레임만 첫 화면 뒤 안전하게 표시합니다. 실제 배경 가림은
블록 내부 그리기 순서가 준비될 때까지 명시적으로 보류합니다. v1.11은
`SORTENTSTABLE`의 블록 소유자, 엔티티 핸들과 정렬 핸들을 결정적이고
제한된 두 섹션으로 보존하며 첫 화면에서는 읽지 않습니다. 남은
엔티티 계열 및 정밀
MTEXT/OCS 배치는 선택된 LibreDWG 경로의 제품 완성도 작업으로 계속
진행합니다.

## 최소 Scene Cache 생성

현재 캐시 작성기는 LINE, ARC, CIRCLE, INSERT, 해석 가능한 DIMENSION
그림 블록 참조, LWPOLYLINE/POLYLINE, ELLIPSE, SPLINE과 네 문자 계열을
레이어·문자 스타일·공유 블록 정보와 함께 little-endian 이진 형식으로
저장합니다. Scene Cache v1.11은
원본 정밀 좌표와 별도로
로컬 원점 기반 `f32` GPU 선 버퍼를 만들며, 첫 화면용 데이터는 최대
4MiB, 개별 상세 청크는 최대 512KiB로 제한합니다. 블록 형상은 배치
횟수와 관계없이 한 번만 저장합니다. 원호, 원, 타원, 폴리라인 불지와
NURBS 스플라인은 상한이 있는 1차 곡선 LOD로 표시하고, 정밀 원본은
후속 고배율 정밀화를 위해 그대로 보존합니다. HATCH는 같은 상한형
경계 청크와 별도의 `f64` 닫힌 링 원본으로 저장합니다. 솔리드와
그라데이션은 첫 화면 이후 채우고, 패턴 정의선은 현재 화면과
교차하는 구간만 제한형 GPU 선으로 생성합니다.
POINT·SOLID·3DFACE·WIPEOUT 원본은 첫 화면 범위에 포함하지 않으며,
별도 워커가 공유 블록 인스턴스를 유지한 채 최대 32MiB의 GPU 버퍼로
변환합니다. WIPEOUT 프레임은 SOLID/3DFACE와 8MiB 외곽선 버퍼를
공유하고, 가림 채움은 도면 순서 지원 전까지 생성하지 않습니다.
기존 출력은 안전을 위해 덮어쓰지 않습니다.

```bash
cargo run --release -p dwg-converter -- convert \
  /path/to/drawing.dwg \
  /path/to/drawing.dwg.cache \
  --pretty
```

생성 직후 헤더, 섹션 범위, 중복, 레코드 크기와 문자열 테이블을 자동
검증합니다. 기존 캐시를 별도로 검사할 수도 있습니다.

```bash
cargo run --release -p dwg-converter -- validate-cache \
  /path/to/drawing.dwg.cache \
  --pretty
```

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
python3 -m http.server 4173 --bind 127.0.0.1 --directory packages/webview
```

브라우저에서 `http://127.0.0.1:4173`을 열고 변환된 `.cache` 파일을
선택합니다. 브라우저는 로컬 파일에서 헤더, 렌더 메타데이터와 최대
4MiB의 첫 화면 정점만 범위 읽기합니다. 블록 형상은 한 번만 GPU에
올리고 변환 행렬로 반복 배치합니다. 휠 또는 화면 버튼으로 확대하고
마우스로 이동하면 화면과 교차하는 LOD 1 청크만 추가로 읽습니다.
레이어 패널에서는 한글 이름을 검색하고 개별 또는 전체 레이어를
켜고 끌 수 있습니다. 이때 형상을 다시 읽거나 GPU에 다시 올리지 않고
작은 레이어 가시성 텍스처만 갱신합니다.

문자는 첫 도형 화면이 나온 뒤 별도 범위로 읽습니다. `SHX 글꼴`에서
도면 스타일이 참조하는 기본 SHX와 BigFont 파일을 함께 선택하면 요청된
글자만 벡터 선분으로 해석해 제한된 LRU 캐시에 보관합니다. 글꼴이 없거나
해당 글리프가 없으면 한글 시스템 글꼴로 대체합니다. 글꼴 파일은 서버로
전송되지 않으며 브라우저 세션 메모리에만 등록됩니다.

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

WIPEOUT 마스크는 v1.11 정렬표를 첫 화면 이후에만 읽어 블록별
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

## 성능 합격 기준

기준 대형 도면에서 다음을 목표로 합니다.

- 변환기 처리: 5초 이하
- 첫 화면: 목표 5초, 최대 8초
- 전체 정밀화: 15초 이하
- 전체 최고 메모리: 목표 600MB, 최대 800MB
- Webview 안정 메모리: 300MB 이하
- 배열 할당 실패와 블록 누락: 0건
- 한글 문자열 손실: 0건

개발 로드맵은 [GitHub 이슈 #8](https://github.com/menaje/dwg-viewer/issues/8)에서
관리합니다.
