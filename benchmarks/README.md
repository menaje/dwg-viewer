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
measured in inspection-only mode:

```bash
adapters/libredwg/prepare.sh \
  /private/tmp/dwg-viewer-libredwg-build \
  /private/tmp/libredwg-adapter

target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /private/tmp/libredwg-adapter \
  --engine-id libredwg \
  --engine-version 0.13.4 \
  --engine-license GPL-3.0-or-later \
  --scope inspect \
  --output benchmarks/results/libredwg.json
```

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
