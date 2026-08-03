# Webview renderer

Scene Cache v1.18 range reader, WebGL2 line/fill/point renderer, bounded CAD
text overlay and lazy raster IMAGE overlay for the VS Code Webview.

Standalone Browser의 `File`과 VS Code의 cache channel은 모두
`DwgSceneCacheSource -> Viewer Core runtime -> render-layer range source`를
거쳐 같은 renderer를 mount합니다. Viewer Core가 source/snapshot,
presentation과 Host disposal을 소유하고, 기존 worker transport는
DWG 제품 내부 구현으로 유지됩니다. 2D camera의 canonical 구현은
`viewer-core`에 있으며 source-neutral GPU batch cache와 함께 과거 Webview
import path는 re-export입니다. Viewport interaction lifecycle도 Core
구현을 상속합니다. Core의 renderer controller가 root/XREF detail target을
조정하고 generic detail streaming controller가 cache·concurrency·폐기를
소유합니다. Webview wrapper는 Scene Cache batch 가시성 계산과 vertex
reader/WebGL mapping만 주입합니다. 객체 선택은 DWG candidate decoder에
남지만 선택 상태는 active snapshot에 묶인 Core controller를 통해
`selection.changed` Host event로 전달됩니다.
Review toolbar의 활성 상태, `aria-pressed`, generic result row/action
composition과 DOM listener disposal은 `@dwg-viewer/viewer-ui`가 소유합니다.
이 package는 CAD candidate를 알지 않으며 Webview의 `ReviewTools`가 DWG
속성과 측정 결과를 bounded view model로 투영합니다.

`DwgRenderDeltaAdapter`는 Core의 source-neutral atomic delta hook과 이
package의 private 36-byte line packet을 연결합니다. payload resolver가
descriptor의 digest와 byte bound를 검증한 decoded packet을 동기적으로
제공하면 adapter는 모든 WebGL line resource를 먼저 stage한 뒤 한 번에
활성화합니다. base Scene Cache buffer는 수정하지 않고 line vertex의 DWG
handle과 fill·pattern·POINT·surface·WIPEOUT의 압축 identity-range sidecar로
draw range만 제외합니다. Canvas text도 같은 source/handle suppression을
적용하므로 preview rollback은 base를 다시 읽거나 GPU buffer를 복원하지
않습니다. 같은 state가 native identity별 upsert/tombstone pick 상태도
제공하며, source switch와 disposal은 staged 및 committed delta resource를
모두 회수합니다.

The decoded packet is private to this package:

```text
{
  payloadId, sha256, byteLength,
  operations: [{
    operationId,
    lines: [{ renderId, sceneId, batch, vertices, instanceIndices }]
  }]
}
```

`byteLength` is the exact sum of the non-shared 36-byte line buffers. Every
vertex handle must match its operation's `dwg:<sceneId>:<handle>` Render ID,
and every visual upsert Render ID must be covered. Packet lookup and digest
verification happen before the synchronous Core apply boundary; the adapter
rechecks descriptor binding, operation coverage, byte bounds and native
identity before allocating GPU resources.

The standalone page is the development and qualification shell: it keeps the
framed canvas, diagnostics and full memory/performance dashboard. When hosted
by VS Code, the same renderer switches to an immersive shell that fills the
editor with the drawing, hides metrics and reveals its edge tool shelf and
layout tabs on hover, focus or an explicit click.

## Implemented

- Reads the cache header and section directory without loading the full file.
- Accepts local `Blob`/`File` sources and strict HTTP byte-range sources.
- Validates section bounds, record sizes, string tables and GPU batch ranges.
- Limits the overview to 8 MiB on read; current converters emit at most 4 MiB.
- Limits each detail read to 512 KiB.
- Resolves nested INSERT, MINSERT and DIMENSION picture-block references while
  keeping block geometry shared.
- Reads current original XREF paths, composes each child model/block instance
  under its parent INSERT and preserves shared geometry across repeated inserts.
- Reads current INSERT/XREF spatial clips, propagates nested clip chains through
  shared instances and applies one boundary to WebGL geometry and Canvas text.
- Reads the v1.18 linetype, saved-view, layout, VIEWPORT and raster IMAGE
  sections and
  allows every paper-space tab to be selected without duplicating model data.
- Opens each tab at its saved CAD view while the `전체 보기` action fits the
  complete stored layout extents, including multi-sheet paper-space layouts
  without letting stray off-paper geometry distort the fit.
- Requests only visible JPG/PNG IMAGE references, applies IMAGE and nested
  XREF clipping plus brightness/contrast/fade, deduplicates compressed content
  and bounds decoded bitmap memory with an LRU. Raster footprints participate
  in fitted bounds even for image-only drawings, while decoding follows the
  current on-screen size and upgrades only after a meaningful zoom. IMAGE clip
  pixels are converted from their saved top-origin Y convention before
  placement so cropped rasters stay aligned with CAD geometry.
- Remaps child layers to root XREF-dependent names and renders external
  overview/detail lines and source text without expanding a full scene graph.
- Serializes external first-frame loads and caps aggregate external overview
  source, overview GPU and detail GPU data at 32 MiB each.
- Stores instance transforms in packed `Float64Array` collections.
- Rebases world coordinates around the camera before WebGL2 `f32` upload.
- Renders overview lines with batched, instanced draw calls.
- Stages bounded DWG Render Delta line packets before one atomic state swap,
  suppresses replaced/tombstoned base lines, HATCH fills/patterns, POINTs,
  SOLID/3DFACE/WIPEOUT primitives and Canvas text without rewriting immutable
  Scene Cache buffers, and restores draw and pick state on preview rollback.
- Supports anchored wheel/button zoom, pointer pan and fitted-view reset.
- Keeps byte-budgeted detail streaming active while zooming out so switching
  to the sampled overview cannot abruptly remove visible objects.
- Selects LOD 1 model and transformed block batches against the viewport.
- Streams at most two detail reads concurrently and coalesces redraws.
- Caps one visible detail set at 32 MiB and cached GPU detail at 96 MiB.
- Cancels stale queued work and safely releases in-flight results on disposal.
- Reuses one geometrically growing instance-upload scratch buffer instead of
  allocating a new typed-array backing store per batched draw call.
- Displays current/peak Chromium JavaScript heap when available and current/
  peak tracked WebGL vertex, instance and layer-texture allocations. It labels
  unsupported heap telemetry and does not count driver-owned framebuffer or
  shader memory as tracked GPU bytes.
- Searches Hangul layer names and toggles individual or all layers without
  rereading geometry or rebuilding GPU buffers.
- Derives root and XREF layer groups at runtime from each drawing's layer
  records and DWG-dependent `reference|layer` names. It does not assume a
  sample reference name and accepts arbitrary Unicode and nested references.
- Fits a dragged rectangular region, records wheel and pan gestures as bounded
  previous/next view-history steps, and stores named camera bookmarks
  independently for model space and each layout.
- Isolates one layer, inverts all layer visibility, and restores the previous
  visibility state with one renderer update.
- Keeps completed measurement guides visible for object/cumulative distance,
  polygon area/perimeter, three-point angle, and exact arc/circle/ellipse
  radius/diameter review tools.
- Selects HATCH, SOLID and 3DFACE objects from the current drawing and resolved
  nested XREFs through one bounded, on-demand index. External candidates keep
  their composed transforms, root layer mapping and visibility, Layer 0
  inheritance and XCLIP chains without assuming any reference filename.
- Converts every measured length, area, radius and coordinate from the DWG
  insertion unit to a selectable display unit with automatic or fixed
  precision. Unitless drawings require an explicit two-point calibration
  before physical units such as mm, m or in can be selected.
- Exports the current screen, the complete current tab or every paper-space
  layout as PNG/PDF without viewer chrome. It reads each layout's arbitrary
  paper dimensions and rotation at runtime, falls back to a user-selected
  preset only when needed, derives 1:N scale from the DWG insertion unit or
  explicit measurement calibration, and can apply the layout CTB to output
  without changing the saved viewer state.
- Packages multi-layout PNG output with portable ASCII entry names and a UTF-8
  `layout-names.txt` map so native ZIP tools retain arbitrary Unicode layout
  labels across macOS, Windows and Linux.
- Displays bounded first-pass chords for arcs, circles, ellipses, polyline
  bulges, NURBS splines and HATCH boundaries emitted by the converter.
- Starts a persistent worker after the first line frame and range-reads the
  v1.6/v1.7 HATCH source sections independently of the first frame.
- Triangulates solid and gradient HATCH rings with pinned Earcut 3.2.3, keeps
  holes and source HATCH styles, and draws fills before boundary lines.
- Retains shared block instances and layer visibility for fill geometry
  without expanding a whole-drawing scene graph.
- Caps HATCH fill GPU vertices at 32 MiB, triangles at 65,536 per entity,
  loops at 2,048 per entity and local-origin batches at 24,576 vertices.
- Preserves v1.7 pattern definition lines and dash/space arrays, clips their
  strokes against normal/outer/ignore rings and draws fill, pattern and
  boundary geometry in that order.
- Regenerates pattern strokes only after a 160 ms viewport debounce, omits
  definitions below 1.5 screen pixels and keeps shared blocks restricted to
  visible instance indices instead of expanding their geometry.
- Caps one pattern result at 250,000 segments (16 MiB of line vertices),
  65,536 segments per HATCH and eight million boundary intersection tests.
- Terminates the previous HATCH worker when another cache is selected.
- Range-reads the current v1.18 POINT/SOLID/3DFACE/WIPEOUT source sections only
  after the first line frame, preserving shared block instances without
  expanding geometry per INSERT.
- Range-reads the current v1.18 normalized `SORTENTSTABLE` tables and entries on
  demand. The first frame reads neither draw-order section.
- Collapses the preserved sort keys to WIPEOUT-only order events, recursively
  includes nested/DIMENSION/MINSERT mask spans and attaches one compact order
  base to each existing block instance without copying its matrix.
- Draws `PDMODE` point markers in screen space and converts SOLID OCS corners
  to bounded fill triangles or `FILLMODE`-off outlines.
- Draws only the visible, non-degenerate WCS edges of 3DFACE records while
  retaining all four corners and invisible-edge flags for a future shaded
  mode.
- Triangulates visible WIPEOUT clip/full-image boundaries and records them
  first in a 24-bit WebGL depth buffer. Batched lines, HATCH, SOLID, 3DFACE
  and POINT geometry then use the same compressed order, so only objects
  below each mask are hidden.
- Applies the same expanded order to Canvas text by clipping an occurrence
  only against later WIPEOUT polygons. Layer-hidden masks are omitted from
  both GPU and text composition.
- Caps expanded masks at 10,000 and mask GPU vertices at 8 MiB. Invalid
  boundaries, inverted clipping, sort collisions, block cycles and
  depth/instance/order-limit failures disable every mask while preserving
  ordinary geometry and configured WIPEOUT frames.
- Caps POINT, SOLID-fill and shared SOLID/3DFACE/WIPEOUT-outline GPU vertices
  at 8, 16 and 8 MiB, plus 8 MiB for WIPEOUT triangles. It runs their
  one-shot worker before HATCH work and releases its source buffers when the
  final GPU payload is transferred.
- Loads source text after the first geometry frame and renders selected local
  SHX/BigFont glyphs through byte-bounded caches, with a Korean system-font
  fallback when a CAD font is unavailable.
- Wraps MTEXT paragraphs to their stored drawing or column width, flows at
  most 64 stored columns, and paints bounded background fills. Stored WCS
  X-axis direction, attachment, column width, gutter and height are preserved
  while explicit `\P` paragraph breaks remain bounded.
- Applies nested MTEXT font, ACI color, height, width, tracking, oblique,
  vertical-run alignment, underline, overline and strike-through controls
  within 4,096 code points and 32 formatting levels. Visible inline font
  families are requested lazily from the host instead of scanning off-screen
  strings. `\S` horizontal fractions, diagonal fractions and tolerances retain
  their upper/lower glyph layout and remain indivisible during word wrapping.
- Preserves `\p` first-line, left and right paragraph indents plus left,
  center and right custom tab stops. Stored drawing-unit distances are
  normalized by the initial character height, `tz` clears custom stops, and
  `^I` advances to the same bounded stop during wrapping, measurement and
  final placement.
- Renders explicit top-to-bottom MTEXT and by-style vertical flow as upright
  glyphs descending within right-to-left logical columns. A by-style record
  remains horizontal unless its referenced text style is actually vertical.
- Maps single-line TEXT from its stored OCS plane, retains the decoder-adjusted
  insertion point for left/center/right/middle and vertical justifications,
  and uses the two endpoint span only for Align/Fit.
- Separates strict EUC-KR from CP949/UHC, encodes all 11,172 modern Hangul
  syllables plus the KS X 1001 symbol and Hanja rows as Johab/CP1361, and
  probes actual glyph presence instead of guessing from BigFont filenames.
  A per-font override resolves ambiguous fonts without duplicating compiled
  glyph geometry.

The current page is an engine verification harness, not the final VS Code
extension UI. At a stable 4× or higher zoom, a dedicated worker now refines
ARC, CIRCLE, ELLIPSE, polyline-bulge and valid NURBS geometry to a 0.5 px
screen-error contract without changing the bounded first frame. External
image baselines for every TEXT OCS/justification combination, lossless
analytic HATCH boundary topology and further real-world Korean SHX corpus
expansion remain follow-up work.

## Run

From the repository root:

```bash
pnpm install --frozen-lockfile
python3 -m http.server 4173 --bind 127.0.0.1 --directory .
```

Open `http://127.0.0.1:4173/packages/webview/` and select a generated `.cache`
file. The repository root is the static root because the Webview imports the
shared `packages/dwg-scene-source` package. The file stays local to the browser.

## Test

```bash
pnpm --filter @dwg-viewer/webview check
```

Tests cover bounded range reads, cache validation, nested/DIMENSION block
transforms, invalid targets, cycles and instance/depth caps, large-coordinate
camera rebasing, camera controls, Core renderer/detail lifecycle adapters,
viewport detail selection, GPU resource ranges, selection publication,
layer visibility, arbitrary Unicode/nested XREF layer grouping,
rectangle camera fitting, bounded branching view history, bookmark-state
validation, XREF instance/layer/text composition, aggregate XREF GPU budgets,
bounded root/XREF filled-object selection with layer and clip filtering, and
LRU eviction/request coalescing.
They also cover delayed Korean text reads, strict EUC-KR, CP949 and Johab
mapping, per-BigFont overrides, SHX/BigFont cache limits and the
current v1.18 HATCH range, triangulation, dashed-pattern, block-clipping,
large-coordinate and render-order contracts, plus POINT/SOLID/3DFACE/WIPEOUT
range, WCS/OCS, clip-boundary, frame-setting, instance-sharing and GPU-budget
behavior, plus draw-order normalization,
contiguous ranges, lazy reads, nested/array mask buckets, depth composition,
HATCH/primitive bucket packing and Canvas text clipping.
