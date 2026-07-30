# dwg-viewer

대형 DWG와 국내 한글 SHX/BigFont 도면을 로컬에서 여는 무료·오픈소스
VS Code 읽기 전용 뷰어입니다.

현재는 제품 기능보다 엔진의 생존 가능성을 먼저 검증하는 단계입니다.
첫 번째 구성 요소는 `acadrust`로 DWG의 객체 수, 블록, 문자 보존, 진단,
처리 시간과 메모리를 측정하는 네이티브 검사기입니다.

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
