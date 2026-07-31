# Architecture

## Decision

The primary pipeline under validation is:

```text
DWG
  -> process-isolated native converter
  -> versioned chunked binary scene cache
  -> VS Code Webview
  -> batched and instanced GPU renderer
```

`acadrust` is the current parser baseline, not a permanent engine decision. It
misses the reference drawing's memory hard gate. LibreDWG 0.13.4 is now the
leading replacement candidate: its inspection adapter passes the current time
and memory targets and matches the normalized geometry and Korean text
fingerprint. Its first direct Scene Cache writer also passes the conversion
time and memory targets. It now renders LINE and LWPOLYLINE/2D/3D POLYLINE
geometry plus bounded ARC/CIRCLE/ELLIPSE and bulge chords, while preserving
source records for a partial entity set. Bounded SPLINE evaluation and
fit/control-point fallback now use the same cache contract. Scene Cache v1.4
also proves UTF-8 TEXT, MTEXT, ATTDEF and attached ATTRIB preservation plus a
bounded SHX/BigFont display path. Scene Cache v1.5 adds a bounded preview of
HATCH line, circular, elliptic, bulge and spline boundaries without adding a
whole-drawing fill mesh. Scene Cache v1.6 adds bounded HATCH source rings and
worker-side solid/gradient fills. Scene Cache v1.7 adds resolved
pattern-definition and dash pools plus viewport-clipped pattern rendering in
the persistent HATCH worker. It does not become the primary engine until the
remaining source families and exact CAD text layout are proved. ACadSharp
remains a fallback candidate through the same adapter protocol.

The complete mlightcad/LibreDWG WASM object-model pipeline is intentionally not
used for large drawings because the full JavaScript model, structured cloning,
render-cache cloning and geometry merging amplify memory.

## Process boundary

DWG parsing runs outside the VS Code extension host and Webview. The converter
writes a compact cache and exits, releasing transient parser memory. The
Webview receives only visible chunks and display metadata.

The `dwg-engine-adapter/1` benchmark boundary invokes `inspect` and `convert`
in a new process for every run. It records process wall time, adapter-reported
time, peak RSS and privacy-filtered compatibility fingerprints. Warmups are
excluded from aggregates, temporary caches are deleted per run, target gates
use the median and hard gates use the maximum. External engine wrappers must
produce the same inspection report and Scene Cache contract; documentation
feature tables alone do not select the primary parser.

On the macOS arm64 reference environment, the current process-isolated
LibreDWG inspection measured 731 ms median wall time and 591,757,312 bytes
median peak RSS. The acadrust baseline measured 878 ms and 935,641,088 bytes.
After normalizing
LibreDWG's separate block markers, owned vertices, table records and attached
attributes, the drawing summary, entity-type counts, Hangul counts and
corruption markers match exactly.

The Scene Cache v1.4 LibreDWG milestone measured 4,069 ms median conversion
wall time and 592,101,376 bytes median peak RSS; measured maximums were
4,246 ms and 592,150,528 bytes. It wrote a deterministic 171,202,960-byte
valid cache with the same 4,194,304-byte overview, 512 KiB maximum detail
batch and 863 detail batches as the preceding Morton milestone. Adding source
text raised logical source coverage from 371,396 to 373,655 of 378,400
entities (98.75%). The remaining 4,745 logical entities are reported rather
than silently dropped.

The Scene Cache v1.5 HATCH-boundary milestone measured 3,526 ms median
conversion wall time and 592,216,064 bytes median peak RSS; measured maximums
were 3,601 ms and 592,232,448 bytes. It added 35,550 bounded HATCH boundary
segments with zero capped HATCH entities and zero non-finite skips. Full-detail
segments rose from 1,624,205 to 1,659,755. The deterministic cache grew by
2,277,760 bytes to 173,480,720 bytes, while the 4 MiB overview and 512 KiB
detail-batch caps stayed unchanged. HATCH source/fill records are deliberately
still deferred, so logical source coverage remains 373,655 of 378,400.

The Scene Cache v1.6 source-backed fill milestone measured 4,120 ms median
conversion wall time and 592,150,528 bytes median peak RSS; measured maximums
were 4,134 ms and 592,265,216 bytes. The extra bounded source passes increase
conversion time but still pass the 5-second target, while peak memory remains
at the parser-dominated v1.5 level. The deterministic cache is 175,428,864
bytes and contains 3,553 HATCH records, 6,365 usable closed loops, 31,511
`f64` fill vertices, 6,704 gradient colors and 3,653 seed points. Logical
source coverage rises to 377,208 of 378,400 entities (99.68%); the remaining
1,192 entities and skipped open/invalid HATCH paths stay explicit in the
report.

The Scene Cache v1.7 pattern milestone measured 4,140 ms median conversion
wall time and 591,904,768 bytes median peak RSS; measured maximums were
4,200 ms and 592,035,840 bytes. The deterministic 175,985,184-byte cache adds
6,390 resolved pattern-definition records and 12,020 dash values. Those two
sections add 556,320 bytes over v1.6 while the line overview and detail
batches remain unchanged. The corresponding acadrust conversion measured
7,642 ms median and 969,310,208 bytes median peak RSS, confirming that it still
fails the memory hard gate while LibreDWG passes both conversion gates.

Cross-engine conversion of public LibreDWG fixtures covers every HATCH mode.
`example_2018.dwg` produces one pattern HATCH, two definition lines and four
dash values; kinds 37–38 are byte-identical between acadrust and LibreDWG.
`2018/Dynblocks.dwg` matches at one solid plus three pattern HATCHes, eight
loops, 104 fill vertices and four definition lines, with identical pattern
sections. `2004/HatchG.dwg` matches at two gradient HATCHes, two loops and 269
fill vertices. Both generated caches validate in every case, with no
truncation or invalid-record skip.

The new text-style and text-source payload is 793,407 bytes on the reference
drawing. Its 2,289 records include 2,259 logical TEXT/MTEXT/ATTDEF records and
30 attached ATTRIB records. The cache reproduces the inspection fingerprint
exactly: 690 Hangul-bearing records, 2,674 Hangul characters and zero null,
replacement or question-mark corruption markers.

The first-frame range path remains eight reads and grows by only the three
new 40-byte directory entries, from 4,998,797 to 4,998,917 bytes. After that
frame, source text requires three additional reads totaling 793,407 bytes.
A Node-based range-reader measurement completed header, metadata, 94,814 block
instances and overview in about 324 ms with about 124 MB process RSS; text
validation and loading took about 5 ms more. This is a qualification
measurement rather than a browser-memory guarantee, but it confirms that the
cache is not read wholesale.

With v1.5 boundary batches, the same first-frame path remains eight reads and
5,001,477 bytes. The 2,560-byte increase is only the larger GPU batch
directory; overview vertices remain exactly 4,194,304 bytes.

With v1.6, the five new directory entries add only 200 bytes to that path:
eight first-frame reads total 5,001,677 bytes. A Node range-reader
qualification loaded the five post-frame HATCH sections in five reads totaling
1,947,941 bytes in 11.8 ms, then triangulated the supported fills in 14.9 ms.
It rendered 379 solid HATCHes as 5,585 triangles in a 536,160-byte GPU buffer;
3,161 pattern HATCHes were retained but skipped, the 32 MiB GPU cap was not
reached, and process peak RSS was about 122 MB. These are local qualification
figures rather than a cross-device browser guarantee.

With v1.7, two directory entries add 80 bytes to the same path: eight
first-frame reads total 5,001,757 bytes, and the unchanged overview remains
4 MiB. Loading the seven HATCH source sections took seven reads totaling
2,504,181 bytes and 13.6 ms. An end-to-end persistent-worker qualification
including its own block-instance graph, fill mesh and fitted-view pattern pass
completed in about 414 ms at about 137 MB process RSS.

An actual Chromium qualification produced the first usable line frame in
449.1 ms. At drawing fit, the 1.5-pixel rule omitted all 6,442 visible
definition passes and emitted no pattern buffer. After eight zoom-in actions
(17.35x), the worker emitted 540 clipped segments (33.8 KiB) for 6 HATCHes.
With the 32 MiB detail cache full, overview, detail, fill and pattern vertex
buffers totaled 36.54 MiB. Layer all-off/all-on changed the visible count from
234 to 0 and back to 234 without a source reread; no browser console error was
reported. The largest measured sequential Node qualification RSS was about
147 MB. These figures validate bounded behavior on the reference drawing, not
a cross-device frame-rate guarantee.

The external sort keeps either one 8,192-record run or its small merge windows
resident, while two private unnamed files consume about 312 MB of temporary
disk at peak for the reference drawing and disappear on close.

The parser itself accounts for almost all measured RSS: the current conversion
maximum is only 7,734,784 bytes below the 600,000,000-byte target. Therefore
future LibreDWG coverage must retain streaming or disk-backed bounded passes;
a whole-drawing geometry vector would erase the margin.

The implemented Webview first-frame path opens the cache with `Blob.slice`
or HTTP byte ranges. It validates the 64-byte header and section directory
before reading metadata, resolves nested INSERT/MINSERT transforms into packed
matrix arrays and uploads one bounded overview vertex prefix to WebGL2.
World-space transforms remain `f64` on the CPU; the renderer rebases each
batch around the camera before converting matrices to `f32`.

## Data rules

- No entity-per-JavaScript-object scene model.
- No entity-per-Three.js-object renderer.
- Coordinate data is stored in packed typed-array-compatible buffers.
- Block definitions are stored once and referenced by transform instances.
- Chunks can be loaded and released independently.
- Unsupported entities are reported; they are never silently dropped.
- Cache identity includes the source fingerprint and converter format version.

## Implemented cache slice

Scene Cache v1.7 writes the drawing/layer/block/text-style tables and
source-precision LINE, ARC, CIRCLE, INSERT, LWPOLYLINE/POLYLINE, ELLIPSE,
SPLINE, TEXT, MTEXT, ATTDEF and ATTRIB records. The records retain owner
handles so block definitions remain shared instead of being expanded per
insertion. Text values, tags, prompts, font filenames and BigFont filenames
remain UTF-8, while MTEXT column heights use a separate packed `f64` pool.
HATCH adds source records plus bounded closed `f64` ring, gradient-color and
seed-point pools. Pattern-definition lines preserve parser-resolved angles,
bases, offsets and dash/gap/dot sequences in separate typed pools. Original
analytic HATCH edge topology is not yet a lossless source record.

The v1.2 display slice added local-origin `f32` line buffers. It keeps model
space and block definitions separate, assigns every non-empty block a bounded
overview allocation within the global 65,536-segment budget, writes the
complete first-frame vertex set as one
contiguous prefix of at most 4 MiB and caps each spatial detail batch at
512 KiB.

The v1.3 display slice adds bounded first-pass chords for ARC, CIRCLE, ELLIPSE,
polyline bulges and NURBS SPLINE entities. Circular curves use at most 16
segments per revolution. Valid splines use two segments per non-empty knot span
with a 256-segment entity cap; malformed splines fall back to bounded fit-point
or control-point chords. Approximation bits stay attached to the GPU vertices,
and the source-precision records remain available for later view-adaptive
high-zoom refinement. Batch-local position error is recorded as a conservative
`f32` upper bound without a second geometry traversal.

The v1.5 display slice extends the same path to HATCH boundaries. Each HATCH
is traversed directly from the parser object and contributes at most 65,536
segments; straight edges, circular/elliptic arcs, bulges and rational spline
edges all stay in the existing overview, Morton detail and byte-bounded cache
pipeline. Reports count rendered boundary segments and capped HATCH entities.
Solid, gradient and clipped pattern fills are intentionally left for a
separate source-backed renderer.

The v1.6 fill slice implements that separate path without changing the line
first frame. After the overview is visible, a dedicated worker reopens the
local cache, range-reads only the five HATCH sections, triangulates solid and
gradient rings with the pinned ISC-licensed Earcut implementation and
transfers only the final packed GPU buffer. Fills use the same shared block
ownership and layer texture as line geometry, are split into local-origin
batches and draw before boundary lines. Source planning is capped at 65,536
vertices per HATCH and 1,048,576 globally; browser work is capped at 2,048
loops and 65,536 triangles per entity and 32 MiB of GPU vertices overall.
Opening another file terminates the previous worker.

The v1.7 pattern slice retains the same worker and source buffers after fill
initialization. Camera changes are debounced by 160 ms and regenerate pattern
strokes without cache reads. Infinite pattern lines are intersected with
normal/outer/ignore ring groups, dashed in source units and clipped to the
current viewport. Definitions below 1.5 screen pixels are omitted before
intersection work. For shared block definitions, only the union of visible
instance intervals is generated and the GPU draw uses an explicit visible
instance-index set, so a heavily reused block does not expand into one mesh
per INSERT.

Pattern work is capped at 2,048 loops, 65,536 segments per HATCH, 250,000
segments globally and eight million edge intersection tests; the packed
vertices have both a 16 MiB effective segment cap and a 32 MiB byte guard.
Local origins retain display precision at large coordinates. Positive dash
values draw, negative values skip and zero values become one-pixel dots.
User-defined double patterns add the perpendicular pass; predefined
definition lines are already resolved by the native parser.

Large-drawing detail records are ordered by group and a 32-bit interleaved XY
Morton key computed from each segment midpoint within that group's finite
bounds. Original traversal order resolves key ties deterministically. The
LibreDWG writer creates sorted 8,192-record runs in a private temporary file
and performs one bounded k-way merge into a second file, so it never retains
the complete spatial index or geometry set in memory.

Detail ranges are independently capped at 512 KiB. The Webview includes a
byte-budgeted least-recently-used cache so viewport refinement can release
inactive chunks instead of retaining the complete drawing. After the fitted
overview, detail selection starts only at 4x zoom, intersects model and
transformed block bounds with the viewport and limits one visible working set
to 32 MiB. GPU detail resources use a 96 MiB LRU budget. Camera revisions stop
stale queued work, while at most two in-flight local reads are allowed to
finish and become reusable cache entries.

Text is deliberately outside the first geometry frame. The Webview then reads
the three v1.4 text ranges and keeps the 336-byte records in their packed
buffer. Numeric display fields are read into one reused scratch record;
UTF-8 values are decoded only for text that survives pixel-size and viewport
culling. One redraw is capped at 50,000 source records, 10,000 visible
occurrences, 250,000 SHX line segments and 50,000 system-font fallback
glyphs.

The MIT-licensed `@mlightcad/shx-parser` is used only after a user selects
local SHX files. Primary SHX and paired BigFont names are normalized by
basename, extension and case. Hangul is mapped to paired legacy BigFont codes
through an on-demand EUC-KR reverse index. Glyphs are parsed lazily into compact
`Float32Array` line pairs and retained in a byte-bounded LRU. Limits are
32 MiB per font file, 64 MiB registered font bytes, 48 MiB concurrently parsed
font bytes, 4,096 compiled glyphs, 64 MiB compiled glyph bytes and 8,192
segments per glyph. One malformed glyph is negatively cached without disabling
the rest of its font. Missing fonts or glyphs use an upright local system-font
fallback so Korean text remains readable.

Layer visibility is stored in a compact one-dimensional GPU texture indexed by
the existing layer index on every vertex. Hiding a layer therefore updates only
that texture and redraws the current camera; it does not reread cache ranges,
rebuild geometry or upload vertex buffers. The visibility test runs before
color resolution in the fragment shader, so by-layer and explicit-color
entities follow the same hidden-layer state. The Webview layer panel searches
Unicode names locally and supports individual, all-on and all-off changes.

## Performance gates

| Metric | Target | Hard limit |
| --- | ---: | ---: |
| Native conversion | <= 5 s | <= 8 s |
| First usable frame | <= 5 s | <= 8 s |
| Full refinement | <= 10 s | <= 15 s |
| Total peak RSS | <= 600 MB | <= 800 MB |
| Stable Webview memory | <= 200 MB | <= 300 MB |
| Dropped blocks | 0 | 0 |
| Hangul replacement/loss | 0 | 0 |

These gates apply to the current 24MB/approximately 378k-entity reference
drawing. Results from private drawings must not be committed.

## Privacy

Real drawings and generated reports may contain project names, addresses,
handles and text. They are ignored by default. Only synthetic or explicitly
redistributable fixtures belong in the public repository.
