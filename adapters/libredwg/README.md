# LibreDWG inspection adapter

This optional process-isolated adapter measures LibreDWG with the same
`dwg-engine-adapter/1` inspection contract used by the built-in acadrust
engine. It deliberately traverses LibreDWG's object model directly instead of
creating a full JSON dump.

The adapter currently implements `inspect` only. Scene Cache conversion remains
disabled until entity and Korean text preservation have been compared with the
reference drawing.

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

Use inspection scope until conversion is implemented:

```bash
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /path/to/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.13.4 \
  --engine-license GPL-3.0-or-later \
  --scope inspect \
  --pretty
```

The report never includes the input name, drawing text samples, diagnostic
messages, or a block name. LibreDWG parsing and analysis stay in the adapter
process so all memory is reclaimed when the process exits.

LibreDWG exposes block markers, polyline vertices and attached attributes as
separate raw entities, while acadrust folds them into their owners. The adapter
keeps raw counts under `drawing.raw_*` and `embedded_text`, but normalizes the
main `drawing.entities`, `drawing.objects`, `entity_types` and `text` fields to
the shared logical inspection contract.
