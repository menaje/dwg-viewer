# Benchmarks

Benchmark results from private drawings must remain under `benchmarks/results/`,
which is ignored by Git.

Build the runner once so measured child processes do not include compilation:

```bash
cargo build --release -p dwg-converter
mkdir -p benchmarks/results
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --runs 3 \
  --warmup-runs 1 \
  --scope all \
  --pretty \
  --output benchmarks/results/acadrust.json
```

Every warmup and measured phase runs in a new process. Conversion caches are
created in a private temporary directory and deleted immediately after each
run. The report contains raw and aggregate timing, peak RSS where supported,
privacy-filtered compatibility fingerprints and automatic target/hard-limit
decisions.

The implemented LibreDWG adapter can be prepared without a global install and
measured in both inspection and partial conversion mode:

```bash
adapters/libredwg/prepare.sh \
  /private/tmp/dwg-viewer-libredwg-build \
  /private/tmp/libredwg-adapter

target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /private/tmp/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.14 \
  --engine-license GPL-3.0-or-later \
  --scope all \
  --output benchmarks/results/libredwg.json
```

The current direct LibreDWG writer is a qualification milestone, not a complete
engine replacement. Its report explicitly identifies deferred entities.
Benchmark gate success proves that this bounded conversion architecture meets
the time/RSS limits; it does not waive geometry, Korean text or spatial-detail
coverage requirements.

External adapters must implement
[`specs/engine-adapter.md`](../specs/engine-adapter.md).

Compare the normalized inspection fingerprints without exposing drawing text
or absolute bounds:

```bash
jq --slurp -f benchmarks/compare-inspection.jq \
  benchmarks/results/acadrust.json \
  benchmarks/results/libredwg.json
```

Parser diagnostics are intentionally excluded from compatibility equality
because engines classify recoverable warnings differently.

## Korean encoding regression

The public Webview suite fixes the legacy Korean mapping contract without
committing private drawings or proprietary SHX files:

```bash
pnpm --filter @dwg-viewer/webview test
```

It distinguishes the 2,350 modern Hangul syllables available through strict
EUC-KR from the complete 11,172-syllable CP949/UHC and Johab sets. CP949 and
Johab boundary/sample codes, automatic glyph probing and per-BigFont overrides
are deterministic regression cases. This is an encoding matrix, not the
20–30-drawing Korean corpus required by issue #7; real geometry/image
qualification remains private until redistributable fixtures are available.

The corpus runner turns a private manifest into one path-free automatic result
table. It executes cases sequentially so converter memory never overlaps:

```bash
pnpm corpus:korean -- \
  --manifest /absolute/private/korean-corpus.json \
  --runner /absolute/path/to/target/release/dwg-converter \
  --adapter /absolute/path/to/libredwg-adapter \
  --output /absolute/path/to/benchmarks/results/korean-corpus.json
```

The manifest has this shape:

```json
{
  "schema": "dwg-korean-corpus-manifest/1",
  "cases": [
    {
      "id": "arch-r2000-001",
      "path": "/absolute/private/drawing.dwg",
      "redistributable": false,
      "discipline": "architecture",
      "sizeClass": "medium",
      "dwgVersion": "AC1015",
      "encodings": ["cp949"],
      "fontKinds": ["shx", "bigfont"],
      "expectedText": {
        "minimumHangulCharacters": 1,
        "maximumReplacementCharacters": 0,
        "maximumNullCharacters": 0
      }
    }
  ]
}
```

Case IDs must be non-sensitive slugs. Paths, text samples, absolute bounds and
adapter diagnostics are never copied into the corpus report. The exclusive
output file is owner-only and is not overwritten. The gate requires at least
20 cases plus all declared DWG versions, architecture/civil/MEP, three size
classes, Unicode/EUC-KR/CP949/Johab and SHX/BigFont/Extended BigFont coverage.
Per-case version, Hangul-loss, deterministic-output, conversion time and RSS
decisions are automatic. `--allow-incomplete` writes an incremental report
without returning a failing exit code while the matrix is still being filled.

## VS Code product qualification

The product runner measures the packaged extension in an isolated, stabilized
VS Code instance rather than adding process RSS values from an existing user
session:

```bash
pnpm --filter dwg-viewer-vscode package:vsix
pnpm --filter dwg-viewer-vscode qualify:host -- \
  --code /absolute/path/to/code-cli \
  --runtime /absolute/path/to/code-runtime \
  --adapter /absolute/path/to/libredwg-adapter \
  --drawing /absolute/path/to/reference.dwg \
  --vsix apps/vscode-extension/dwg-viewer-vscode-0.1.0.vsix \
  --output benchmarks/results/vscode-product.json
```

It runs a cold full-cache open and a close-during-conversion scenario. The
memory gate uses the extension's incremental physical memory above the stable
VS Code renderer/extension-host baseline. macOS uses `footprint`, which
de-duplicates shared mappings; Linux uses summed proportional set size from
`smaps_rollup`. Aggregate RSS and baseline-inclusive physical memory remain in
the report as diagnostics because aggregate Electron RSS double-counts shared
pages and the host baseline is outside the extension.

Use `--progressive-preview` to measure the optional speed-first path. Reports
are created exclusively with owner-only permissions and never overwrite an
existing file.
