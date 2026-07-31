# Scene Cache v1.7

Status: source geometry/text writer, bounded HATCH rings and asynchronous
solid/gradient fill and viewport-clipped pattern paths implemented; expansion
tracked by GitHub issues #3 and #9.

The cache is a little-endian, versioned binary container designed for range
reads and browser `ArrayBuffer`/`DataView` access. Geometry is never encoded as
JSON.

## File layout

```text
64-byte header
40-byte section directory entries
8-byte alignment padding
section payloads
```

### Header

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[8]` | magic: `DWGSCN1\0` |
| 8 | `u16` | major version |
| 10 | `u16` | minor version |
| 12 | `u32` | header size |
| 16 | `u32` | section count |
| 20 | `u32` | directory-entry size |
| 24 | `u32` | flags |
| 28 | `u32` | reserved |
| 32 | `u64` | directory offset |
| 40 | `u64` | cache file size |
| 48 | `u64` | source DWG size |
| 56 | `u32` | source DWG version code |
| 60 | `u32` | maintenance version |

### Directory entry

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | section kind |
| 4 | `u32` | record size |
| 8 | `u64` | payload offset |
| 16 | `u64` | payload byte length |
| 24 | `u64` | record count |
| 32 | `u32` | flags |
| 36 | `u32` | reserved |

Section kinds currently written:

| Kind | Payload |
| ---: | --- |
| 1 | drawing metadata and bounds |
| 2 | layer table and UTF-8 strings |
| 3 | shared block-definition table and UTF-8 strings |
| 4 | text-style table and UTF-8 strings |
| 10 | LINE records |
| 11 | ARC records |
| 12 | CIRCLE records |
| 13 | INSERT records |
| 14 | normalized polyline headers |
| 15 | normalized polyline vertex pool |
| 16 | ELLIPSE records |
| 17 | SPLINE headers |
| 18 | SPLINE knot pool |
| 19 | SPLINE weight pool |
| 20 | SPLINE control-point pool |
| 21 | SPLINE fit-point pool |
| 22 | TEXT/MTEXT/ATTDEF/ATTRIB records and UTF-8 strings |
| 23 | MTEXT column-height pool |
| 30 | viewport/LOD GPU line batches |
| 31 | interleaved GPU line vertices |
| 32 | HATCH records and UTF-8 pattern/gradient names |
| 33 | bounded closed HATCH loop records |
| 34 | HATCH loop `f64[3]` vertex pool |
| 35 | HATCH gradient-color pool |
| 36 | HATCH seed-point pool |
| 37 | HATCH pattern-definition-line records |
| 38 | HATCH pattern dash/gap/dot value pool |

Version 1.0 contains kinds 1–3 and 10–13. Version 1.1 adds kinds 14–21.
Version 1.2 adds kinds 30–31 for straight and polyline GPU lines. Version 1.3
extends those GPU sections with bounded curve chords without changing their
binary record sizes. Version 1.4 adds kinds 4 and 22–23 for source text and
font-style metadata. Version 1.5 adds bounded HATCH boundary chords and expands
the packed GPU source-kind field without changing a record size. Version 1.6
adds kinds 32–36 for bounded source-backed HATCH fills. Version 1.7 adds kinds
37–38 for resolved pattern-definition lines and dash values. The validator
continues to accept older v1 caches, while a v1.7 writer always emits all 27
sections, including empty pools.

## Shared primitive prefix

Every primitive record begins with the same 32 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | entity handle |
| 8 | `u64` | owner/block-record handle |
| 16 | `u32` | layer index, or `0xffffffff` |
| 20 | `u32` | encoded source color |
| 24 | `i16` | source line weight |
| 26 | `u16` | flags; bit 0 means invisible |
| 28 | `u32` | reserved |

Color uses the upper two bits as its kind: `00` ByLayer, `01` ByBlock, `10`
ACI index and `11` 24-bit RGB.

Source coordinates are stored as `f64` in v1 to avoid losing precision in large
civil drawings. The v1.2+ GPU sections contain derived, batch-local `f32`
coordinates without replacing these source-precision records.

## String-table sections

Layer, block, text-style and text-entity sections begin with:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | record count |
| 4 | `u32` | record size |
| 8 | `u64` | UTF-8 blob offset relative to the section |

Individual records contain offsets and lengths into the trailing UTF-8 blob.
Layer and block data is stored once; primitive and INSERT records reference it
by index or owner handle.

## Text styles and source text

Scene Cache v1.4 preserves the source strings before attempting display. The
Webview reads the text sections only after the first geometry frame and decodes
an entity's value only after cheap pixel-size and viewport culling.

### Text-style record

Each kind-4 record is 96 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | style handle |
| 8 | `u32[2]` | style-name UTF-8 offset and length |
| 16 | `u32[2]` | primary font-file UTF-8 offset and length |
| 24 | `u32[2]` | BigFont-file UTF-8 offset and length |
| 32 | `u32[2]` | TrueType-name UTF-8 offset and length |
| 40 | `u32` | style flags |
| 44 | `u32` | reserved |
| 48 | `f64` | fixed height |
| 56 | `f64` | width factor |
| 64 | `f64` | oblique angle |
| 72 | `f64` | last height |
| 80 | `u8[16]` | reserved |

Style flag bits are 0 backward, 1 upside down, 2 xref-dependent, 3
annotative, 4 vertical and 5 shape.

### Text-entity record

Each kind-22 record is 336 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u16` | kind: 0 TEXT, 1 MTEXT, 2 ATTDEF, 3 ATTRIB |
| 34 | `u16` | text flags |
| 36 | `u32` | style index, or `0xffffffff` |
| 40 | `u32[2]` | value UTF-8 offset and length |
| 48 | `u32[2]` | attribute tag UTF-8 offset and length |
| 56 | `u32[2]` | attribute prompt UTF-8 offset and length |
| 64 | `u64` | linked handle, or zero |
| 72 | `f64[3]` | insertion point |
| 96 | `f64[3]` | alignment point |
| 120 | `f64[3]` | OCS normal |
| 144 | `f64[3]` | source X-axis direction |
| 168 | `f64` | height |
| 176 | `f64` | width factor |
| 184 | `f64` | rotation |
| 192 | `f64` | oblique angle |
| 200 | `f64` | thickness |
| 208 | `f64` | rectangle width |
| 216 | `f64` | rectangle height |
| 224 | `f64` | extents width |
| 232 | `f64` | extents height |
| 240 | `f64` | line-spacing factor |
| 248 | `f64` | background scale |
| 256 | `u32` | encoded background color |
| 260 | `i32` | background transparency |
| 264 | `i32` | background flags |
| 268 | `i32` | source attribute flags |
| 272 | `i16` | horizontal alignment |
| 274 | `i16` | vertical alignment |
| 276 | `i16` | MTEXT attachment |
| 278 | `i16` | MTEXT flow direction |
| 280 | `i16` | line-spacing style |
| 282 | `i16` | generation flags |
| 284 | `i16` | attribute field length |
| 286 | `i16` | embedded-MTEXT type |
| 288 | `i32` | line count |
| 292 | `i32` | column type |
| 296 | `i32` | column count |
| 300 | `u32` | column flags |
| 304 | `f64` | column width |
| 312 | `f64` | column gutter |
| 320 | `u64` | first kind-23 column height |
| 328 | `u64` | column-height count |

Text flag bits are 0 alignment point present, 1 rectangle height present, 2
annotative, 3 multiline, 4 position locked and 5 really locked. Column flag
bits are 0 automatic height and 1 reversed flow. Kind 23 is a packed `f64`
pool; every offset/count pair is range-checked.

## Polyline normalization

LWPOLYLINE, 2D POLYLINE and 3D POLYLINE share a 112-byte header and a
64-byte vertex pool. Each header stores:

- the shared 32-byte primitive prefix;
- first vertex index and vertex count;
- source kind and flags;
- elevation, thickness and OCS normal;
- default and constant widths.

Each pooled vertex preserves its `f64` position, bulge, start/end widths,
curve-fit tangent, source flags and vertex ID. Header ranges are validated
against the vertex-pool count.

## Spline normalization

A 208-byte SPLINE header retains degree, flags, knot parameterization, OCS
normal, tolerances and begin/end tangents. It references four typed pools:

- `f64` knots;
- `f64` rational weights;
- `f64[3]` control points;
- `f64[3]` fit points.

All offset/count pairs are checked against their corresponding pool before the
cache is accepted.

## Bounded HATCH source, fill rings and patterns

Scene Cache v1.7 preserves every HATCH as a kind-32 source record, including
its shared primitive prefix, pattern and gradient names, style, flags,
elevation, normal, pattern transform, gradient parameters, seed-point range
and pattern-definition-line count. Closed usable boundary paths become
bounded `f64` rings in kinds 33–34. The duplicated closing endpoint is omitted;
the loop is implicitly closed from its last vertex to its first.

Analytic and bulge edges use the same bounded chord rules as the line display
path. Consequently, kind 34 is a source-backed fill ring rather than a
lossless replacement for the original analytic edge topology. Open,
degenerate and non-finite paths are skipped and reported separately. One
HATCH contributes at most 65,536 ring vertices, the global vertex pool is
capped at 1,048,576 records, and each gradient-color and seed-point pool is
also capped at 1,048,576 records. A truncated entity sets its source flag and
increments `hatch_fills.truncated_fill_hatches`.

### HATCH entity record

Kind 32 uses the standard 16-byte string-table header followed by 192-byte
records:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u8[32]` | shared primitive prefix |
| 32 | `u32[2]` | pattern-name UTF-8 offset and length |
| 40 | `u32[2]` | gradient-name UTF-8 offset and length |
| 48 | `u32` | HATCH flags |
| 52 | `u16` | style: 0 normal, 1 outer, 2 ignore |
| 54 | `u16` | source pattern-type enum |
| 56 | `u64` | first kind-33 loop |
| 64 | `u64` | loop count |
| 72 | `u64` | first kind-35 gradient color |
| 80 | `u64` | gradient-color count |
| 88 | `f64` | elevation |
| 96 | `f64[3]` | finite OCS normal; `[0,0,1]` fallback |
| 120 | `f64` | pattern angle |
| 128 | `f64` | pattern scale |
| 136 | `f64` | pixel size |
| 144 | `f64` | gradient angle |
| 152 | `f64` | gradient shift |
| 160 | `f64` | gradient tint |
| 168 | `u64` | first kind-36 seed point |
| 176 | `u64` | seed-point count |
| 184 | `i32` | source gradient reserved value |
| 188 | `u32` | source pattern-definition-line count |

HATCH flag bits are 0 solid, 1 associative, 2 double, 3 gradient, 4
single-color gradient and 5 truncated.

### HATCH loop and value pools

Each kind-33 record is 48 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | owning kind-32 HATCH index |
| 8 | `u32` | source boundary-path flags |
| 12 | `u32` | source path index within the HATCH |
| 16 | `u64` | first kind-34 vertex |
| 24 | `u64` | vertex count |
| 32 | `u32` | source edge count |
| 36 | `u32` | loop flags; bit 0 means a curve was approximated |
| 40 | `f64` | signed area in the dominant-axis projection |

Kind 34 stores one `f64[3]` vertex per 24-byte record. Kind 35 stores a
gradient stop as `f64 value`, encoded `u32 color` and reserved `u32` in 16
bytes. Kind 36 stores one `f64[2]` seed point in 16 bytes. Entity ranges are
contiguous and monotonic; loop-to-entity, loop-to-vertex, gradient-color and
seed-point ranges are all validated before the cache is accepted.

### HATCH pattern-definition and dash pools

Kind 37 stores each parser-resolved pattern-definition line in a 72-byte
record:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u64` | owning kind-32 HATCH index |
| 8 | `u32` | source definition-line index within the HATCH |
| 12 | `u32` | flags; currently zero |
| 16 | `f64` | resolved line angle in radians |
| 24 | `f64[2]` | resolved base point in HATCH OCS |
| 40 | `f64[2]` | resolved offset vector in HATCH OCS |
| 56 | `u64` | first kind-38 dash value |
| 64 | `u32` | dash-value count |
| 68 | `u32` | reserved; zero |

Kind 38 is a packed `f64` pool. A positive value is a drawn dash length, a
negative value is a gap length, and zero is a dot. The two native writers
preserve the values exposed by their parser after the DWG pattern angle and
scale have been resolved; the Webview therefore does not apply the entity
transform a second time. A user-defined pattern with the HATCH double flag
adds one perpendicular display pass. Predefined pattern definitions already
contain their complete resolved line families.

Definition records are grouped by HATCH and ordered by source definition-line
index. Their dash ranges are contiguous, monotonic and cover the complete
kind-38 pool. The validator checks owner indices, source order, flags,
reserved values, finite angle/base/offset/dash values and all range
arithmetic. One HATCH contributes at most 4,096 definition lines and 65,536
dash values; global pools are capped at 262,144 lines and 1,048,576 dash
values. Truncation sets the HATCH source flag and is reported separately from
invalid skipped definitions.

The Webview starts this work only after the first line frame. A dedicated
worker range-reads the seven HATCH sections, applies normal/outer/ignore ring
nesting, triangulates solid and gradient fills, and retains the packed source
and block-instance graph for viewport pattern requests. Pattern definitions
are clipped first to nested HATCH rings and then to the union of visible
model/block-instance viewport intervals. The worker transfers only final
local-origin GPU buffers. Pattern regeneration is debounced by 160 ms and
never rereads the cache. A new file cancels and terminates the previous
worker.

Fill runtime limits are 2,048 loops and 65,536 triangles per entity, 32 MiB of
GPU vertices overall and 24,576 vertices per local-origin batch. Pattern
runtime limits are 2,048 loops and 65,536 segments per HATCH, 250,000 segments
(16 MiB) globally, eight million boundary intersection tests and 32 MiB of
GPU bytes. Definitions closer than 1.5 screen pixels are omitted before
geometry generation. Shared block pattern vertices are stored once, and draw
calls submit only the visible instance indices selected for that viewport.

## Viewport and LOD GPU lines

LINE and normalized polyline segments are emitted as interleaved, GPU-ready
line vertices. Scene Cache v1.3 also emits bounded first-pass chords for ARC,
CIRCLE, ELLIPSE, polyline bulges and NURBS SPLINE entities. Model-space
geometry and each block definition remain separate. A block's vertices are
stored once regardless of how many INSERT entities reference it.

Scene Cache v1.5+ also emits HATCH boundary paths. Straight edges remain exact
within the derived `f32` display buffer; circular, elliptic, bulge and spline
edges use the same bounded chord rules as the corresponding standalone
entities. One HATCH contributes at most 65,536 boundary segments. The
conversion report exposes both `hatch_boundary_segments` and
`truncated_hatch_entities`, so the safety cap cannot silently hide a
pathological boundary. In v1.6, the separate bounded ring pools support
source-backed solid and gradient fills without changing this first-frame line
path.

Circular and bulge curves use no more than 16 segments per revolution. Valid
splines use two segments per non-empty knot span and no more than 256 segments
per entity. Invalid spline definitions fall back to their fit-point or
control-point chords instead of being silently dropped. These limits bound
conversion work and cache growth; source-precision curve records remain the
authority for future view-adaptive refinement.

The converter creates at most 65,536 overview segments across model space and
all non-empty blocks. When the number of non-empty groups fits that budget,
each group receives one segment before the remainder is distributed by segment
count; in the pathological case of more groups than slots, the largest groups
are selected first. If the full drawing is already below the limit, the full
data is also LOD 0 and no duplicate overview is written.

Overview batches are written before all LOD 1 detail batches. Consequently,
the first-frame vertex data is one contiguous prefix of at most 4 MiB. Detail
batches contain no more than 8,192 line segments (512 KiB of vertex data) and
are ordered spatially by a 16-bit XY Morton key. A client can scan the small
batch directory, intersect batch bounds with the viewport and range-read only
the matching vertex spans.

### GPU line batch record

Each kind-30 record is 128 bytes:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | sequential batch ID |
| 4 | `u16` | kind: 0 model overview, 1 model detail, 2 block definition |
| 6 | `u16` | LOD: 0 overview/primary, 1 detail |
| 8 | `u32` | flags; bit 0 means at least one curve chord is approximate |
| 12 | `u32` | block-table index, or `0xffffffff` for model space |
| 16 | `u64` | first vertex |
| 24 | `u64` | vertex count |
| 32 | `u32` | line-segment count |
| 36 | `u32` | reserved |
| 40 | `f64[3]` | batch-local origin in source coordinates |
| 64 | `f64[3]` | source-coordinate minimum bounds |
| 88 | `f64[3]` | source-coordinate maximum bounds |
| 112 | `f32` | conservative maximum component error after local `f32` quantization |
| 116 | `u8[12]` | reserved |

Batch vertex ranges are contiguous, non-overlapping and cover the complete
kind-31 vertex pool. The validator checks batch IDs, kinds, LOD ordering,
block references, bounds, vertex/segment counts and pool coverage.

### GPU line vertex record

Each kind-31 record is 32 bytes and can be bound directly as an interleaved GPU
vertex buffer:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `f32[3]` | position relative to the batch origin |
| 12 | `u32` | layer index |
| 16 | `u32` | encoded source color |
| 20 | `u32` | entity handle low 32 bits |
| 24 | `u32` | entity handle high 32 bits |
| 28 | `u32` | packed line weight, visibility, source kind and approximation flag |

For v1.5+, the packed style stores the signed line-weight bits in bits 0–15,
invisibility in bit 16, source kind in bits 17–20 and the curved-chord
approximation flag in bit 21. Source kinds are 0 LINE, 1 LWPOLYLINE, 2 2D
POLYLINE, 3 3D POLYLINE, 4 ARC, 5 CIRCLE, 6 ELLIPSE, 7 SPLINE and 8 HATCH
boundary. In v1.2–v1.4, source kind occupies bits 17–19 and approximation is
bit 20. Precise standalone curve parameters, bulges and OCS metadata remain
available in the source sections for later high-zoom refinement.

## Deferred v1 work

- complete MTEXT formatting, background, column and exact OCS/alignment display
  fidelity beyond the bounded first pass;
- automatic trusted SHX font discovery and project font mapping;
- linetype override table;
- view-adaptive high-zoom refinement beyond the bounded v1.3 curve chords;
- lossless HATCH analytic-edge topology beyond the bounded fill rings;
- entity-selection index and source fingerprint.

Cache files can contain project names and drawing text. They are local,
generated artifacts and must not be committed.

## LibreDWG qualification writer

The optional LibreDWG adapter currently writes a valid but partial v1.7 cache
to measure the direct object-to-cache boundary. It preserves layer/block UTF-8
names and source records for LINE, ARC, CIRCLE, INSERT/MINSERT,
LWPOLYLINE/2D/3D POLYLINE, ELLIPSE and SPLINE, including the four SPLINE value
pools. It also preserves text styles and UTF-8 TEXT, MTEXT, ATTDEF and attached
ATTRIB source records. Its GPU sections render LINE and normalized polyline
segments plus bounded ARC/CIRCLE/ELLIPSE, bulge, SPLINE and HATCH-boundary
chords. Circular curves use the same 16-segments-per-revolution limit; SPLINE
evaluation and malformed-input fallback use the 256-segments-per-entity limit.
It also writes the seven bounded HATCH source/fill/pattern sections. The
Webview range-reads those sections after the first line frame, triangulates
solid and gradient rings, and regenerates clipped pattern strokes in the same
persistent worker. All omitted logical entities, skipped paths and HATCH caps
are exposed in the conversion report rather than silently treated as
supported.

This qualification writer keeps the same 4 MiB overview and 512 KiB detail
limits and uses disk-backed group-local XY Morton ordering for detail batches.
The remaining unsupported source families and exact CAD text-layout fidelity
must be closed before the LibreDWG writer can replace the primary converter.
