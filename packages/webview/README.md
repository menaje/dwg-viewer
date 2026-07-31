# Webview renderer

Scene Cache v1.11 range reader, WebGL2 line/fill/point renderer and bounded CAD text
overlay for the VS Code Webview.

## Implemented

- Reads the cache header and section directory without loading the full file.
- Accepts local `Blob`/`File` sources and strict HTTP byte-range sources.
- Validates section bounds, record sizes, string tables and GPU batch ranges.
- Limits the overview to 8 MiB on read; current converters emit at most 4 MiB.
- Limits each detail read to 512 KiB.
- Resolves nested INSERT, MINSERT and DIMENSION picture-block references while
  keeping block geometry shared.
- Stores instance transforms in packed `Float64Array` collections.
- Rebases world coordinates around the camera before WebGL2 `f32` upload.
- Renders overview lines with batched, instanced draw calls.
- Supports anchored wheel/button zoom, pointer pan and fitted-view reset.
- Selects LOD 1 model and transformed block batches against the viewport.
- Streams at most two detail reads concurrently and coalesces redraws.
- Caps one visible detail set at 32 MiB and cached GPU detail at 96 MiB.
- Cancels stale queued work and safely releases in-flight results on disposal.
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
- Draws `PDMODE` point markers in screen space and converts SOLID OCS corners
  to bounded fill triangles or `FILLMODE`-off outlines.
- Draws only the visible, non-degenerate WCS edges of 3DFACE records while
  retaining all four corners and invisible-edge flags for a future shaded
  mode.
- Draws WIPEOUT clip/full-image frames only when the drawing-wide frame
  setting enables them. Exact mask geometry stays source-backed and is
  reported as deferred until draw-order-aware rendering is implemented.
- Caps POINT, SOLID-fill and shared SOLID/3DFACE/WIPEOUT-outline GPU vertices
  at 8, 16 and 8 MiB, runs their one-shot worker before HATCH work, and
  releases its source buffers when the final GPU payload is transferred.
- Loads source text after the first geometry frame and renders selected local
  SHX/BigFont glyphs through byte-bounded caches, with a Korean system-font
  fallback when a CAD font is unavailable.

The current page is an engine verification harness, not the final VS Code
extension UI. Exact MTEXT/OCS layout, lossless analytic HATCH boundary
topology, real-world Korean SHX corpus expansion and view-adaptive high-zoom
curve refinement remain follow-up work.

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
ranges, layer visibility and LRU eviction/request coalescing.
They also cover delayed Korean text reads, SHX/BigFont cache limits and the
v1.7 HATCH range, triangulation, dashed-pattern, block-clipping,
large-coordinate and render-order contracts, plus v1.8 POINT/SOLID, v1.9
3DFACE and v1.10 WIPEOUT range, WCS/OCS, clip-boundary, frame-setting,
instance-sharing and GPU-budget behavior, plus v1.11 draw-order normalization,
contiguous ranges and lazy reads.
