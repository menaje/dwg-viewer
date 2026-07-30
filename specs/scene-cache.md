# Scene Cache v1.2

Status: minimal writer implemented; expansion tracked by GitHub issue #3.

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
| 30 | viewport/LOD GPU line batches |
| 31 | interleaved GPU line vertices |

Version 1.0 contains kinds 1–3 and 10–13. Version 1.1 adds kinds 14–21.
Version 1.2 adds kinds 30–31. The validator continues to accept v1.0 and v1.1
caches.

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
civil drawings. The v1.2 GPU sections contain derived, batch-local `f32`
coordinates without replacing these source-precision records.

## String-table sections

Layer and block sections begin with:

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | `u32` | record count |
| 4 | `u32` | record size |
| 8 | `u64` | UTF-8 blob offset relative to the section |

Individual records contain offsets and lengths into the trailing UTF-8 blob.
Layer and block data is stored once; primitive and INSERT records reference it
by index or owner handle.

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

## Viewport and LOD GPU lines

LINE and normalized polyline segments are also emitted as interleaved,
GPU-ready line vertices. Model-space geometry and each block definition remain
separate. A block's vertices are stored once regardless of how many INSERT
entities reference it.

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
| 8 | `u32` | flags; bit 0 means at least one curved polyline chord is approximate |
| 12 | `u32` | block-table index, or `0xffffffff` for model space |
| 16 | `u64` | first vertex |
| 24 | `u64` | vertex count |
| 32 | `u32` | line-segment count |
| 36 | `u32` | reserved |
| 40 | `f64[3]` | batch-local origin in source coordinates |
| 64 | `f64[3]` | source-coordinate minimum bounds |
| 88 | `f64[3]` | source-coordinate maximum bounds |
| 112 | `f32` | maximum component error after local `f32` quantization |
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

The packed style stores the signed line-weight bits in bits 0–15, invisibility
in bit 16, source kind in bits 17–19 and the curved-chord approximation flag
in bit 20. Precise bulges and OCS metadata remain available in the source
polyline sections for later curve refinement.

## Deferred v1 work

- text runs and SHX glyph references;
- linetype override table;
- GPU refinement for ARC, CIRCLE, ELLIPSE, SPLINE and polyline bulges;
- entity-selection index and source fingerprint.

Cache files can contain project names and drawing text. They are local,
generated artifacts and must not be committed.
