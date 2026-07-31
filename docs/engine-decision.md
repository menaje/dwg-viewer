# DWG engine decision

Status: accepted on 2026-07-31

Scope: free/open-source local DWG parsing and Scene Cache conversion

Decision: select GNU LibreDWG 0.14

## Decision

GNU LibreDWG 0.14 is the primary parser and converter for continued product
development. It is the only measured candidate that satisfies both the
large-drawing conversion target and hard limits while preserving the required
logical entities, blocks and Korean text.

`acadrust` 0.4.1 remains a cross-engine test oracle and an MPL-only reference
implementation. It is not the default large-drawing engine because it exceeds
the memory hard limit.

ACadSharp 3.6.51 is rejected for the large-drawing path. Its inspect-only
adapter is retained so the result can be reproduced, but a second Scene Cache
writer will not be implemented: parsing alone already exceeds the memory hard
limit, so adding a writer cannot make the candidate eligible.

Selection does not mean that the viewer is feature-complete. The follow-on
3DFACE milestone leaves 16 WIPEOUT source entities plus exact CAD text layout
as product work on the LibreDWG path rather than reasons to keep the engine
choice open.

## Reproducible evidence

All measurements used macOS arm64, one excluded warmup and three fresh measured
processes with the operating-system file cache left at its default. Reports
exclude the input name, drawing text, diagnostic messages, block names and
absolute coordinates. Private reports remain under the ignored
`benchmarks/results/` directory.

| Candidate | Measured phase | Wall min / median / max | Peak RSS min / median / max | Result |
| --- | --- | ---: | ---: | --- |
| LibreDWG 0.14 | Scene Cache v1.7 conversion | 2,930 / 2,941 / 2,957 ms | 591,560,704 / 591,659,008 / 591,740,928 B | pass |
| acadrust 0.4.1 | Scene Cache v1.7 conversion | 7,556 / 7,642 / 7,904 ms | 968,900,608 / 969,310,208 / 969,392,128 B | memory hard fail |
| ACadSharp 3.6.51 | parser inspection preflight | 4,012 / 4,014 / 4,098 ms | 1,441,251,328 / 1,452,392,448 / 1,452,474,368 B | memory hard fail |

ACadSharp's wall value is not a conversion comparison. The inspection phase
loads and normalizes the managed document model but does not write a cache.
Its memory result is sufficient for rejection because parsing is a mandatory
subset of conversion. The benchmark runner now records that case as
`hard_fail`; an inspect-only candidate below the hard limit would remain
`incomplete` until conversion was measured.

The ACadSharp adapter uses the exact, locked 3.6.51 NuGet package published on
2026-07-29. Its normalized output matches the 378,400 logical entity count,
entity-type histogram, 724 blocks, 3,659 block references, 234 layers, 30 text
styles, bounds presence and Korean text fingerprint: 690 text records contain
2,674 Hangul characters, with no NUL, U+FFFD or question-mark corruption
markers. Its non-entity object count is 3,570 rather than the reference 3,933,
so that part of the object model is not considered equivalent. This mismatch
does not affect the memory rejection.

LibreDWG's v1.7 writer produces a deterministic 175,985,184-byte valid cache.
It preserves 377,208 of 378,400 logical source entities (99.68%), the complete
required Korean text fingerprint and the current line, curve, spline and HATCH
display paths. The first line frame range-reads 5,001,757 bytes including a
fixed 4 MiB overview rather than loading the complete cache.

The follow-on v1.8 writer adds 621 POINT and 350 SOLID records and raises
coverage to 378,179 of 378,400 entities (99.94%). Its deterministic
176,113,616-byte cache measured 2,986 ms median conversion wall time and
591,511,552 bytes median peak RSS; maximums were 3,028 ms and 592,150,528
bytes. It therefore preserves the engine-selection result while reducing the
deferred count from 1,192 to 221.

The DIMENSION follow-on reuses the unchanged v1.8 kind-13 block-instance
record. All 171 picture-block references in the reference drawing resolve,
raising coverage to 378,350 of 378,400 entities (99.99%) and reducing the
deferred count to 50. The deterministic cache grows by exactly 23,256 bytes
to 176,136,872 bytes; the GPU batch and vertex sections are byte-identical to
the preceding cache. Three isolated measured conversions completed in
2,921 / 3,215 / 3,860 ms with 590,036,992 / 591,691,776 / 591,708,160 bytes
peak RSS (minimum / median / maximum). Output was deterministic and both gates
passed, so the extra bounded lookup and stream pass do not change the
engine-selection result.

The first-frame reader still performs eight reads. Metadata grows by the same
23,256 bytes, from 5,001,837 to 5,025,093 bytes including the unchanged 4 MiB
overview. Nested ownership expands the 171 source references into 2,668
direct picture occurrences and 380 downstream nested instances; the total
instance graph grows from 94,814 to 97,862 matrices, or 390,144 packed bytes.
A local Node qualification completed the path in 345.6 ms at about 123 MB
process RSS. An actual Chromium run produced the first usable line frame in
450.0 ms with the same 4.57 MiB GPU vertex footprint and no console warning or
error.

Scene Cache v1.9 adds kind 41 without changing any preceding section layout.
Kinds 2–40 remain byte-identical; only the kind-1 serialized-entity count
changes. All 34 3DFACE records in the reference drawing are preserved,
raising coverage to 378,384 of 378,400 entities (99.996%) and reducing
deferred entities to the 16 WIPEOUT records. The cache grows by 4,664 bytes to
176,141,536 bytes: 4,624 bytes of face records and one 40-byte directory
entry. Three clean
process-isolated conversions completed in 3,153 / 3,715 / 4,082 ms with
591,446,016 / 591,675,392 / 591,888,384 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both gates passed.

The first-frame reader still performs eight reads and does not touch kind 41.
Only the directory grows, so first-frame bytes increase by 40 from 5,025,093
to 5,025,133 while the 4 MiB overview is unchanged. The post-frame primitive
path reads 4,624 additional source bytes and adds 7,296 GPU bytes for 114
visible face edges; hidden and degenerate edges are omitted. An actual v1.9
Chromium run produced the first usable line frame in 464.0 ms, reported all
34 faces, used 4.58 MiB of GPU vertex buffers at drawing fit and emitted no
console warning or error.

The stable 0.14 release replaces the earlier 0.13.4 qualification pin. Its
normalized conversion report and cache are byte-identical to 0.13.4 on the
reference drawing, while median conversion wall time improves from 4,140 ms to
2,941 ms. The `0.14.xxxx` nightly tags are marked as prereleases and are not
used as a reproducible product dependency.

## Why LibreDWG

- It is the only candidate below the 600,000,000-byte target and
  800,000,000-byte hard limit.
- Its direct C-to-cache writer avoids a second full drawing object graph.
- Bounded repeated passes, 8,192-record sort runs and disk-backed Morton
  ordering keep conversion memory at the parser-dominated level.
- Korean strings and CP949 support are available in the native parse path,
  while SHX/BigFont glyph parsing stays lazy in the Webview.
- Public cross-engine fixtures validate all current HATCH modes and exact
  pattern-section payloads; POINT and SOLID sections also match byte for byte,
  both engines resolve all nine DIMENSION picture blocks in
  `example_2018.dwg`, and `2000/entities-3d.dwg` matches 3DFACE flags and WCS
  corners.

The memory margin to the 600,000,000-byte target is small. New LibreDWG
coverage must keep the current bounded streaming or disk-backed design; a
whole-drawing geometry array is not allowed.

## License and distribution boundary

The selected engine is free software, but it is not permissively licensed.
[GNU LibreDWG 0.14](https://github.com/LibreDWG/libredwg/releases/tag/0.14)
is GPL-3.0-or-later. The adapter binary links to LibreDWG, so any distribution
of that binary must satisfy GPL-3.0-or-later, including the applicable license,
corresponding source and reproducible build material.

The Rust converter, Webview and VS Code extension code remain MPL-2.0 source
components. LibreDWG is confined to a separate executable and exchanges input
and versioned cache files through `dwg-engine-adapter/1`; it is not linked into
the extension host or Webview. The
[GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation) says
command-line and pipe boundaries normally indicate separate programs, while
also warning that the communication semantics can affect the legal analysis.
The project therefore does not treat process isolation alone as a legal
conclusion.

Until a release-package review is completed:

1. an MPL-only VSIX must not bundle a prebuilt LibreDWG-linked adapter;
2. local development may build the adapter from checksum-pinned source with
   `adapters/libredwg/prepare.sh`;
3. a distribution that bundles the adapter must be published as a separately
   identified GPL-compliant LibreDWG-enabled artifact with the required source,
   license and notices.

ACadSharp 3.6.51 is MIT-licensed, and the optional adapter uses a
checksum-pinned .NET SDK plus a content-hash-locked package. Its permissive
license does not offset its measured memory failure. This section is an
engineering distribution policy, not legal advice.

## Consequences

- Finish WIPEOUT source/display decisions on the LibreDWG writer.
- Continue Korean SHX/BigFont and exact MTEXT/OCS work in issues #5 and #7.
- Use acadrust only for public cross-engine fixtures and regression oracles.
- Keep the ACadSharp inspection adapter, package lock and parser preflight test;
  do not build an ACadSharp Scene Cache converter unless a future release
  materially changes the measured memory architecture.
- Resolve the GPL-enabled release artifact before VSIX publication in issue #6.

## Primary sources

- [GNU LibreDWG 0.14 stable release](https://github.com/LibreDWG/libredwg/releases/tag/0.14)
- [GNU LibreDWG GPL-3.0-or-later statement](https://www.gnu.org/software/libredwg/manual/LibreDWG.html)
- [ACadSharp source and DWG support table](https://github.com/DomCR/ACadSharp)
- [ACadSharp MIT license](https://github.com/DomCR/ACadSharp/blob/v3.6.51/LICENSE)
- [ACadSharp 3.6.51 package](https://www.nuget.org/packages/ACadSharp/3.6.51)
- [.NET license information](https://github.com/dotnet/core/blob/main/license-information.md)
- [GNU GPL FAQ on separate programs and aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
- [Autodesk 3DFACE DXF group codes](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-747865D5-51F0-45F2-BEFE-9572DBC5B151.htm)
- [Autodesk 3DFACE wireframe/shaded behavior](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-Core/files/GUID-5E88BB23-9110-45FB-B54A-3FF2E2002585.htm)
