# LibreDWG engine adapter

This optional process-isolated adapter measures LibreDWG with the same
`dwg-engine-adapter/1` inspection and conversion contract used by the built-in
acadrust engine. It traverses LibreDWG's object model directly instead of
creating a full JSON dump.

The `convert` path writes Scene Cache v1.3 without a whole-drawing intermediate
model. It repeatedly traverses LibreDWG objects and streams sections and
bounded GPU batches directly to a new cache file. For large drawings, it
spills fixed-size detail records into private unnamed temporary files, sorts
8,192-record runs, and performs one buffered merge into group-local XY Morton
order. The in-memory sort working set stays bounded below 0.8 MB; the
temporary files are mode `0600`, close-on-exec, and removed automatically.

This is a deliberately partial conversion milestone:

- layer and block names stay UTF-8;
- LINE, ARC, CIRCLE, INSERT/MINSERT, LWPOLYLINE, 2D/3D POLYLINE and
  ELLIPSE source records plus SPLINE headers and knot/weight/control/fit pools
  are preserved;
- LINE, normalized polyline, ARC, CIRCLE, ELLIPSE and SPLINE geometry are
  emitted as renderable, instanced GPU batches;
- circular curves and polyline bulges are converted to bounded chords with at
  most 16 segments per revolution, while exact curve records, vertices and
  bulges remain in the source pools;
- valid SPLINE definitions use one segment for linear spans or two per
  non-empty curved knot span, capped at 256 segments per entity; malformed
  definitions fall back to bounded fit/control-point chords;
- every unsupported logical entity is counted under
  `coverage.deferred_entities`;
- text/SHX display expansion remains open in GitHub issue #9.

The partial writer produces a structurally valid cache, but it is not yet the
primary production converter. Its large-drawing detail batches now use the
same group-local midpoint quantization and 16-bit XY Morton key as the acadrust
writer, with original source order as the deterministic tie breaker. The
65,536-segment first-frame overview remains byte-for-byte unchanged.

## Portable build

The reproducible path downloads checksum-pinned LibreDWG and pkgconf sources,
builds them under a new private directory, and writes the adapter to a new
path. It never installs a system package:

```bash
adapters/libredwg/prepare.sh \
  /private/tmp/dwg-viewer-libredwg-build \
  /private/tmp/libredwg-adapter
```

Both paths must not already exist. A C11 compiler, `make`, `curl`, `tar` and a
SHA-256 utility are required.

If LibreDWG 0.13.4 or newer already exists in an isolated prefix, only the
adapter needs to be built:

```bash
LIBREDWG_PREFIX=/path/to/libredwg-prefix \
  adapters/libredwg/build.sh /new/path/to/libredwg-adapter
```

The output binary links to LibreDWG; distributing that binary must comply with
LibreDWG's GPL-3.0-or-later license.

## Benchmark

Run both phases through the same process-isolated benchmark:

```bash
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /path/to/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.13.4 \
  --engine-license GPL-3.0-or-later \
  --scope all \
  --pretty
```

The conversion destination must not exist. The adapter never overwrites or
removes a pre-existing destination, and it removes a newly created partial
cache if writing fails.

Reports never include the input name, drawing text samples, diagnostic
messages, or a block name. LibreDWG parsing, analysis and cache writing stay in
the adapter process so all transient memory is reclaimed when the process
exits.

LibreDWG exposes block markers, polyline vertices and attached attributes as
separate raw entities, while acadrust folds them into their owners. The adapter
keeps raw counts under `drawing.raw_*` and `embedded_text`, but normalizes the
main `drawing.entities`, `drawing.objects`, `entity_types` and `text` fields to
the shared logical inspection contract.

On the private 24 MB reference drawing, the disk-backed Morton milestone had a
3,461 ms median process wall time and 592,019,456-byte median peak RSS across
three isolated measured runs. The maximums were 3,561 ms and 592,035,840 bytes,
so both target gates pass. The deterministic 170,409,424-byte cache preserves
1,624,205 full-detail segments while reducing detail batches from 1,169 to 863.
Across 2,650 fixed grid viewports in the same 106 multi-batch block groups,
intersecting detail bytes fell 15.6%. The browser opens the cache with eight
range reads totaling 4,998,797 bytes, including the unchanged 4 MiB overview.
At peak, the two automatically removed sort files use about 312 MB of
temporary disk for this drawing; they do not become resident geometry arrays.
Private reports and generated caches are not committed.
