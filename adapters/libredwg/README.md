# LibreDWG engine adapter

This optional process-isolated adapter measures LibreDWG with the same
`dwg-engine-adapter/1` inspection and conversion contract used by the built-in
acadrust engine. It traverses LibreDWG's object model directly instead of
creating a full JSON dump.

The `convert` path writes Scene Cache v1.3 without a whole-drawing intermediate
model. It repeatedly traverses LibreDWG objects and streams sections and
bounded GPU batches directly to a new cache file. The only geometry buffer is
one 8,192-segment batch.

This is a deliberately partial conversion milestone:

- layer and block names stay UTF-8;
- LINE, ARC, CIRCLE, INSERT/MINSERT, LWPOLYLINE, 2D/3D POLYLINE and
  ELLIPSE source records are preserved;
- LINE and normalized polyline geometry are emitted as renderable, instanced
  GPU batches;
- polyline bulges are converted to bounded chords with at most 16 segments per
  revolution, while exact vertices and bulges remain in the source pools;
- every unsupported logical entity is counted under
  `coverage.deferred_entities`;
- ARC/CIRCLE/ELLIPSE chords, spline and text/SHX display expansion remains open in
  GitHub issue #9.

The partial writer produces a structurally valid cache, but it is not yet the
primary production converter. Its detail batches retain source traversal order
rather than the acadrust writer's XY Morton order.

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

On the private 24 MB reference drawing, the polyline milestone had a 2,247 ms
median process wall time and 592,003,072-byte median peak RSS across three
isolated measured runs. The maximums were 2,286 ms and 592,134,144 bytes.
The deterministic 147,372,632-byte cache contains 11,596 polylines and 400,974
pooled vertices; 359,066 of 378,400 logical entities (94.89%) now have source
records. The browser still opens it with eight range reads totaling 5,033,613
bytes, including the fixed 4 MiB overview. Private reports and generated
caches are not committed.
