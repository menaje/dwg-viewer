# LibreDWG engine adapter

This optional process-isolated adapter measures LibreDWG with the same
`dwg-engine-adapter/1` inspection and conversion contract used by the built-in
acadrust engine. It traverses LibreDWG's object model directly instead of
creating a full JSON dump.

The `convert` path writes Scene Cache v1.7 without a whole-drawing intermediate
model. It repeatedly traverses LibreDWG objects and streams sections and
bounded GPU batches directly to a new cache file. For large drawings, it
spills fixed-size detail records into private unnamed temporary files, sorts
8,192-record runs, and performs one buffered merge into group-local XY Morton
order. The in-memory sort working set stays bounded below 0.8 MB; the
temporary files are mode `0600`, close-on-exec, and removed automatically.
HATCH sections use repeated bounded passes and retain at most one 65,536-point
ring (about 1.5 MiB) while streaming. Pattern-definition lines and dash values
are streamed in separate bounded passes, and no whole-drawing fill or pattern
mesh is built in the converter.

This is a deliberately partial conversion milestone:

- layer and block names stay UTF-8;
- LINE, ARC, CIRCLE, INSERT/MINSERT, LWPOLYLINE, 2D/3D POLYLINE and
  ELLIPSE source records plus SPLINE headers and knot/weight/control/fit pools
  are preserved;
- text-style names, SHX/BigFont filenames and UTF-8 TEXT, MTEXT, ATTDEF and
  attached ATTRIB source records are preserved, including bounded MTEXT column
  height pools;
- LINE, normalized polyline, ARC, CIRCLE, ELLIPSE, SPLINE and bounded HATCH
  boundary geometry are emitted as renderable, instanced GPU batches;
- circular curves and polyline bulges are converted to bounded chords with at
  most 16 segments per revolution, while exact curve records, vertices and
  bulges remain in the source pools;
- valid SPLINE definitions use one segment for linear spans or two per
  non-empty curved knot span, capped at 256 segments per entity; malformed
  definitions fall back to bounded fit/control-point chords;
- HATCH line, circular, elliptic, bulge and spline boundaries share those
  chord rules and are capped at 65,536 segments per HATCH; reports expose
  rendered boundary segments and any capped entities;
- bounded HATCH entity records retain pattern/gradient metadata, closed `f64`
  rings, gradient colors and seed points; rings are capped at 65,536 vertices
  per HATCH and 1,048,576 vertices globally;
- pattern-definition lines retain their resolved angle, base, offset and dash
  sequence in packed source sections; one HATCH is capped at 4,096 definition
  lines and 65,536 dash values, with global caps of 262,144 and 1,048,576;
- after the first line frame, the Webview fills solid/gradient rings and
  clips pattern strokes to the current viewport in one persistent worker;
- every unsupported logical entity is counted under
  `coverage.deferred_entities`;
- bounded SHX/BigFont and system-font fallback display is implemented in the
  Webview; exact MTEXT/OCS fidelity remains open in GitHub issue #9.

The partial writer produces a structurally valid cache, but it is not yet the
primary production converter. Its large-drawing detail batches now use the
same group-local midpoint quantization and 16-bit XY Morton key as the acadrust
writer, with original source order as the deterministic tie breaker. The
first-frame overview remains capped at 65,536 segments and 4 MiB.

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

On the private 24 MB reference drawing, the Scene Cache v1.7 milestone had a
4,140 ms median process wall time and 591,904,768-byte median peak RSS across
three isolated measured runs. The maximums were 4,200 ms and 592,035,840 bytes,
so both target gates pass. The deterministic 175,985,184-byte cache contains
1,659,755 full-detail segments, including 35,550 HATCH boundary segments; no
HATCH reached the boundary or fill-vertex cap and no non-finite display
segment was skipped.

The seven HATCH sections contain 3,553 source records, 6,365 usable closed
loops, 31,511 fill vertices, 6,704 gradient colors, 3,653 seed points, 6,390
pattern-definition lines and 12,020 dash values. Open and invalid paths stay
explicit in the report. Logical source coverage is 377,208 of 378,400
entities; 392 HATCHes are solid and 3,161 are patterns.

Public LibreDWG fixtures provide a reproducible cross-engine check. Both
writers validated `example_2018.dwg` as one pattern HATCH with two definition
lines and four dash values; the complete kind-37 and kind-38 payloads were
byte-identical. `2018/Dynblocks.dwg` matched at one solid and three pattern
HATCHes, eight loops, 104 fill vertices and four definition lines, again with
byte-identical pattern sections. `2004/HatchG.dwg` matched at two gradient
HATCHes, two loops and 269 fill vertices. None of those fixtures reached a cap
or skipped an invalid source record.

The browser opens the cache with eight range reads totaling 5,001,757 bytes,
including the unchanged 4 MiB overview. A local range-reader qualification
then loaded the seven HATCH sections in seven reads totaling 2,504,181 bytes
in 13.6 ms. A persistent-worker qualification, including block-instance graph
construction, fill triangulation and the fitted-view pattern pass, completed
in about 414 ms with about 137 MB process RSS. It triangulated 379 usable
solid fills into 5,585 triangles and a 536,160-byte GPU buffer. At drawing fit,
the 1.5-pixel density rule correctly omitted all pattern strokes.

An actual Chromium qualification produced the first usable line frame in
449.1 ms. At drawing fit, all 6,442 visible definition passes were below the
1.5-pixel density threshold and the pattern buffer remained empty. After eight
zoom-in actions (17.35x), the worker generated 540 clipped segments in
33.8 KiB for 6 HATCHes. The 32 MiB detail cache, fills, patterns and overview
used 36.54 MiB of GPU vertex buffers together. Toggling every layer moved the
visible count from 234 to 0 and back to 234 without rereading pattern source,
and the browser reported no console errors. These are local qualification
figures, not cross-device browser guarantees.
The 2,289 text records still load separately; their 690 Hangul-bearing values and 2,674
Hangul characters match the inspection fingerprint with no corruption
markers. At peak, the two automatically removed sort files use about 312 MB
of temporary disk for this drawing; they do not become resident geometry
arrays. Private reports and generated caches are not committed.
