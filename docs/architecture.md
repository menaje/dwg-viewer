# Architecture

## Decision

The primary pipeline under validation is:

```text
DWG
  -> native Rust converter
  -> versioned chunked binary scene cache
  -> VS Code Webview
  -> batched and instanced GPU renderer
```

`acadrust` is the first parser candidate. It must pass a representative Korean
DWG corpus before becoming a permanent dependency. ACadSharp or native
LibreDWG may later be evaluated behind the same converter boundary if the
corpus exposes critical gaps.

The complete mlightcad/LibreDWG WASM object-model pipeline is intentionally not
used for large drawings because the full JavaScript model, structured cloning,
render-cache cloning and geometry merging amplify memory.

## Process boundary

DWG parsing runs outside the VS Code extension host and Webview. The converter
writes a compact cache and exits, releasing transient parser memory. The
Webview receives only visible chunks and display metadata.

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

Scene Cache v1.3 writes the drawing/layer/block tables and source-precision
LINE, ARC, CIRCLE, INSERT, LWPOLYLINE/POLYLINE, ELLIPSE and SPLINE records.
The records retain owner handles so block definitions remain shared instead of
being expanded per insertion.

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

Detail ranges are independently capped at 512 KiB. The Webview includes a
byte-budgeted least-recently-used cache so viewport refinement can release
inactive chunks instead of retaining the complete drawing. After the fitted
overview, detail selection starts only at 4x zoom, intersects model and
transformed block bounds with the viewport and limits one visible working set
to 32 MiB. GPU detail resources use a 96 MiB LRU budget. Camera revisions stop
stale queued work, while at most two in-flight local reads are allowed to
finish and become reusable cache entries.

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
