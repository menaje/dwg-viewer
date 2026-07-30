# dwg-viewer

대형 DWG와 국내 한글 SHX/BigFont 도면을 로컬에서 여는 무료·오픈소스
VS Code 읽기 전용 뷰어입니다.

현재는 제품 기능보다 엔진의 생존 가능성을 먼저 검증하는 단계입니다.
네이티브 변환기는 `acadrust`로 DWG를 검사하고 범위 읽기가 가능한
Scene Cache를 생성합니다. 브라우저 기반 Webview 프로토타입은 캐시
전체를 메모리에 올리지 않고 첫 화면용 버퍼만 읽어 WebGL2로 그립니다.

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

## 최소 Scene Cache 생성

현재 캐시 작성기는 LINE, ARC, CIRCLE, INSERT, LWPOLYLINE/POLYLINE,
ELLIPSE, SPLINE을 레이어 및 공유 블록 정보와 함께 little-endian 이진
형식으로 저장합니다. Scene Cache v1.2는 원본 정밀 좌표와 별도로
로컬 원점 기반 `f32` GPU 선 버퍼를 만들며, 첫 화면용 데이터는 최대
4MiB, 개별 상세 청크는 최대 512KiB로 제한합니다. 블록 형상은 배치
횟수와 관계없이 한 번만 저장합니다. 기존 출력은 안전을 위해
덮어쓰지 않습니다.

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

## Webview 첫 화면 검증

빌드나 외부 패키지 설치 없이 정적 서버로 프로토타입을 실행할 수
있습니다.

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory packages/webview
```

브라우저에서 `http://127.0.0.1:4173`을 열고 변환된 `.cache` 파일을
선택합니다. 브라우저는 로컬 파일에서 헤더, 렌더 메타데이터와 최대
4MiB의 첫 화면 정점만 범위 읽기합니다. 블록 형상은 한 번만 GPU에
올리고 변환 행렬로 반복 배치합니다.

Webview 단위 검사는 다음 명령으로 실행합니다.

```bash
pnpm test:webview
```

## 성능 합격 기준

기준 대형 도면에서 다음을 목표로 합니다.

- 변환기 처리: 5초 이하
- 첫 화면: 목표 5초, 최대 8초
- 전체 정밀화: 15초 이하
- 전체 최고 메모리: 800MB 이하
- Webview 안정 메모리: 300MB 이하
- 배열 할당 실패와 블록 누락: 0건
- 한글 문자열 손실: 0건

개발 로드맵은 [GitHub 이슈 #8](https://github.com/menaje/dwg-viewer/issues/8)에서
관리합니다.
