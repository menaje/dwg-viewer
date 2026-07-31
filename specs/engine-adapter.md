# DWG engine adapter protocol v1

Status: accepted engine decision. The built-in acadrust adapter, LibreDWG
inspection/conversion adapter and ACadSharp inspection preflight are
implemented. LibreDWG 0.14 is selected; see
[`docs/engine-decision.md`](../docs/engine-decision.md).

## Purpose

Parser candidates must be compared with the same process boundary, privacy
rules, output checks and performance gates. An adapter is a local executable
that exposes the converter's `inspect` and `convert` command contract. The
benchmark runner never sends a drawing to a server.

The protocol identifier is:

```text
dwg-engine-adapter/1
```

## Process contract

The runner starts a new adapter process for every warmup and measured phase.
It sets:

```text
DWG_VIEWER_ADAPTER_PROTOCOL=dwg-engine-adapter/1
DWG_VIEWER_BENCHMARK_PHASE=inspect|convert
```

Inspection invocation:

```text
adapter inspect INPUT --notification-samples 0
```

Conversion invocation:

```text
adapter convert INPUT TEMPORARY_CACHE
```

The adapter must:

- write exactly one UTF-8 JSON report to standard output;
- use standard error only for bounded failure diagnostics;
- return zero only after the requested operation succeeds;
- create the conversion cache at the requested new path;
- avoid external network access and preserve the input file;
- report peak resident memory in bytes when the platform supports it.

The runner deletes every temporary conversion cache after reading the report.
It also removes its private temporary workspace on success or failure.

## Inspection report

`inspect` must emit `dwg-inspection/1` with `status: "ok"` and these fields:

- `input.size_bytes`;
- `drawing`;
- `performance.parse_ms`, `performance.total_ms` and optional
  `performance.peak_rss_bytes`;
- `entity_types`;
- `unknown_entities`;
- `text`;
- `bounds`;
- `diagnostics`.

The benchmark runner requests zero text and diagnostic samples. Before
comparing repeated outputs it also removes the input name, text samples,
diagnostic samples, largest-block name, absolute bound coordinates and all
performance fields. It retains only whether a valid drawing bound exists.

The common inspection fields describe logical drawing entities. Engine-specific
raw object-model counts may be added under distinct fields, but block markers,
owned polyline vertices and attached attributes must not inflate the common
`drawing.entities`, `drawing.objects`, `entity_types` or `text` values. The
LibreDWG and ACadSharp adapters expose those raw values separately as
`drawing.raw_*` and `embedded_text`.

## Conversion report

`convert` must emit `dwg-scene-cache/1` with `status: "ok"` and these fields:

- `input.size_bytes`;
- `cache`;
- `coverage`;
- `gpu_lines`;
- `performance.parse_ms`, `performance.total_ms` and optional
  `performance.write_ms` and `performance.peak_rss_bytes`;
- `diagnostics`.

The generated cache must follow the current Scene Cache specification. Report
fields other than schema, status, input name and performance form the
repeatability fingerprint.

An experimental adapter may report incomplete entity coverage while its
conversion path is being qualified. It must still emit a valid cache, count
every omitted logical entity in `coverage.deferred_entities`, and must not be
selected as the primary engine until the required geometry and text coverage
gates pass.

## Measurement and decisions

The default run consists of one warmup and three measured processes for both
phases. The operating-system file cache is not flushed or claimed to be cold.
The report records:

- runner version, release/debug profile, operating system, architecture and
  logical CPU count;
- each process wall time and adapter-reported time;
- minimum, integer median and maximum;
- peak RSS when every measured process reports it;
- whether all measured compatibility fingerprints are identical.

Full conversion gates use process wall time and peak RSS:

| Metric | Target | Hard limit | Rule |
| --- | ---: | ---: | --- |
| wall time | 5,000 ms | 8,000 ms | target uses median; hard limit uses maximum |
| peak RSS | 600,000,000 bytes | 800,000,000 bytes | target uses median; hard limit uses maximum |

A missing RSS measurement produces `incomplete`. A non-deterministic
fingerprint or any hard-limit violation produces `hard_fail`. Passing hard
limits but missing a target produces `target_miss`.

Parsing is a mandatory subset of conversion. When conversion has not been
implemented, the runner applies the peak-RSS gate to the inspection process.
Exceeding the hard limit rejects the candidate immediately; otherwise the
decision remains `incomplete` until conversion wall time and memory exist.

The built-in acadrust benchmark refuses to run from a debug build. External
adapters are responsible for identifying and using their optimized build.

## Privacy

Input names are omitted unless explicitly requested. Results from private
drawings belong under ignored `benchmarks/results/` and must not be committed.
Adapters and public reports must not include project names, addresses, drawing
text or private diagnostic messages.
