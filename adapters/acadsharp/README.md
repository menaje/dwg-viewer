# ACadSharp engine adapter

This optional process-isolated adapter implements the inspection half of
`dwg-engine-adapter/1` with ACadSharp. Its purpose is to apply the parser-memory
preflight before investing in another Scene Cache writer.

ACadSharp 3.6.51 is MIT-licensed and supports reading DWG AC1014 through
AC1032. The adapter normalizes block-owned entities, attached attributes,
dimension names and text metrics without including drawing names, text samples,
diagnostic messages or absolute coordinates in benchmark fingerprints.

## Prepare without a global install

The preparation script downloads a checksum-pinned .NET 9.0.316 SDK into a new
build directory, restores the exact ACadSharp package from `packages.lock.json`
and writes an executable wrapper at the requested new path. It does not modify
the system .NET installation.

```bash
build_root=$(mktemp -d)/acadsharp-build
adapter_parent=$(mktemp -d)
adapters/acadsharp/prepare.sh \
  "$build_root" \
  "$adapter_parent/acadsharp-adapter"
```

The supported preparation platforms are macOS and Linux on arm64 or x86_64.
The build directory must remain available while the wrapper is used.

## Run the parser-memory preflight

```bash
cargo build --release -p dwg-converter
target/release/dwg-converter benchmark /path/to/drawing.dwg \
  --adapter "$adapter_parent/acadsharp-adapter" \
  --engine-id acadsharp \
  --engine-version 3.6.51 \
  --engine-license MIT \
  --scope inspect \
  --pretty
```

Inspection is a mandatory subset of conversion. The benchmark runner therefore
rejects an inspect-only candidate when its peak RSS maximum already exceeds the
800,000,000-byte hard limit. A candidate that passes inspection but has no
conversion observation remains `incomplete`.

`convert` is deliberately not implemented. On the reference large drawing,
ACadSharp's parser alone exceeded the hard memory limit, so a second Scene
Cache writer cannot make the candidate eligible and would not be useful work.

## License

The adapter source is MPL-2.0. ACadSharp is consumed as a separate MIT-licensed
NuGet dependency. The downloaded .NET SDK and runtime are MIT-licensed
components with their own third-party notices. This section records engineering
packaging boundaries and is not legal advice.
