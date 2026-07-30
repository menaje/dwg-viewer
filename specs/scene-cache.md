# Scene Cache v1.1

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

Version 1.0 contains kinds 1–3 and 10–13. Version 1.1 adds kinds 14–21.
The validator continues to accept v1.0 caches.

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

Coordinates are stored as `f64` in v1 to avoid losing precision in large civil
drawings. A later spatial-chunk section will provide rebased `f32` GPU buffers
without changing these source-precision records.

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

## Deferred v1 work

- text runs and SHX glyph references;
- linetype override table;
- viewport-spatial chunk directory and rebased GPU buffers;
- entity-selection index and source fingerprint.

Cache files can contain project names and drawing text. They are local,
generated artifacts and must not be committed.
