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
bounded SHX/BigFont display path. It does not become the primary engine until
the remaining source families and exact CAD text-layout fidelity are proved.
ACadSharp remains a fallback candidate through the same adapter protocol.

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

The external sort keeps either one 8,192-record run or its small merge windows
resident, while two private unnamed files consume about 312 MB of temporary
disk at peak for the reference drawing and disappear on close.

The parser itself accounts for almost all measured RSS: the current conversion
maximum is only 7,964,160 bytes below the 600,000,000-byte target. Therefore
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

Scene Cache v1.4 writes the drawing/layer/block/text-style tables and
source-precision LINE, ARC, CIRCLE, INSERT, LWPOLYLINE/POLYLINE, ELLIPSE,
SPLINE, TEXT, MTEXT, ATTDEF and ATTRIB records. The records retain owner
handles so block definitions remain shared instead of being expanded per
insertion. Text values, tags, prompts, font filenames and BigFont filenames
remain UTF-8, while MTEXT column heights use a separate packed `f64` pool.

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
