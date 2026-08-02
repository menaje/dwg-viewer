# Webview renderer

Scene Cache v1.18 range reader, WebGL2 line/fill/point renderer, bounded CAD
text overlay and lazy raster IMAGE overlay for the VS Code Webview.

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
- Reads v1.12 original XREF paths, composes each child model/block instance
  under its parent INSERT and preserves shared geometry across repeated inserts.
- Reads v1.13 INSERT/XREF spatial clips, propagates nested clip chains through
  shared instances and applies one boundary to WebGL geometry and Canvas text.
- Reads v1.14-v1.18 linetype, saved-view, layout, VIEWPORT and raster IMAGE
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
- Range-reads v1.8 POINT/SOLID, v1.9 3DFACE and v1.10 WIPEOUT source only
  after the first line frame, preserving shared block instances without
  expanding geometry per INSERT.
- Range-reads normalized v1.11 `SORTENTSTABLE` tables and entries only on
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
python3 -m http.server 4173 --bind 127.0.0.1 --directory packages/webview
```

Open `http://127.0.0.1:4173` and select a generated `.cache` file. The file
stays local to the browser.

## Test

```bash
pnpm --filter @dwg-viewer/webview check
```

Tests cover bounded range reads, cache validation, nested/DIMENSION block
transforms, invalid targets, cycles and instance/depth caps, large-coordinate
camera rebasing, camera controls, viewport detail selection, GPU resource
ranges, layer visibility, XREF instance/layer/text composition, aggregate XREF
GPU budgets and LRU eviction/request coalescing.
They also cover delayed Korean text reads, strict EUC-KR, CP949 and Johab
mapping, per-BigFont overrides, SHX/BigFont cache limits and the
v1.7 HATCH range, triangulation, dashed-pattern, block-clipping,
large-coordinate and render-order contracts, plus v1.8 POINT/SOLID, v1.9
3DFACE and v1.10 WIPEOUT range, WCS/OCS, clip-boundary, frame-setting,
instance-sharing and GPU-budget behavior, plus v1.11 draw-order normalization,
contiguous ranges, lazy reads, nested/array mask buckets, depth composition,
HATCH/primitive bucket packing and Canvas text clipping.
