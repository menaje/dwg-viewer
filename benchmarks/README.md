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

An external LibreDWG or ACadSharp wrapper can be measured with the same runner:

```bash
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter /path/to/adapter \
  --engine-id candidate-id \
  --engine-version candidate-version \
  --engine-license SPDX-ID \
  --output benchmarks/results/candidate-id.json
```

External adapters must implement
[`specs/engine-adapter.md`](../specs/engine-adapter.md).
