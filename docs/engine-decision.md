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
WIPEOUT milestone preserves every logical source entity in the reference
drawing. Scene Cache v1.11 also preserves the complete `SORTENTSTABLE` source
needed for correct masking, but block-local/nested ordering, background
composition and exact CAD text layout remain product work on the LibreDWG
path rather than reasons to keep the engine choice open.

## Reproducible evidence

All measurements used macOS arm64, one excluded warmup and three fresh measured
processes with the operating-system file cache left at its default. Reports
exclude the input name, drawing text, diagnostic messages, block names and
absolute coordinates. Private reports remain under the ignored
`benchmarks/results/` directory.

| Candidate | Measured phase | Wall min / median / max | Peak RSS min / median / max | Result |
| --- | --- | ---: | ---: | --- |
| LibreDWG 0.14 | Scene Cache v1.7 conversion | 2,930 / 2,941 / 2,957 ms | 591,560,704 / 591,659,008 / 591,740,928 B | pass |
| LibreDWG 0.14 | Scene Cache v1.10 conversion | 2,880 / 2,886 / 2,890 ms | 591,691,776 / 591,724,544 / 591,724,544 B | pass |
| LibreDWG 0.14 | Scene Cache v1.11 conversion | 2,983 / 2,999 / 3,009 ms | 591,773,696 / 591,822,848 / 591,822,848 B | pass |
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

Scene Cache v1.10 adds kinds 42–43 without changing kinds 2–41. It preserves
all 16 WIPEOUT records and 627 clip vertices in the reference drawing, growing
the deterministic cache by exactly 12,800 bytes to 176,154,336 bytes. Logical
source coverage reaches 378,400 of 378,400 with zero converter-deferred
entities. That is a source-preservation result: the 16 background masks remain
explicitly deferred because correct masking depends on block-local sort tables
and nested INSERT draw order. The drawing-wide frame setting is off, so no
WIPEOUT GPU vertices are generated for this drawing.

Three clean process-isolated v1.10 conversions completed in
2,880 / 2,886 / 2,890 ms with
591,691,776 / 591,724,544 / 591,724,544 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both target gates passed. The
first-frame path remains eight reads and grows only 80 bytes to 5,025,213
bytes; it reads neither WIPEOUT source section. The isolated primitive worker
uses nine bounded reads totaling 726,827 bytes. On the public
`example_2018.dwg` fixture, both engines produce byte-identical kinds 42–43
for two WIPEOUTs and 16 clip vertices plus the same frame setting. The enabled
public frames produce 16 edges in a 1,024-byte GPU payload.
An actual v1.10 Chromium run produced the reference drawing's first usable
line frame in 502.8 ms and reported all 16 source masks as deferred with no
console warning or error.

Scene Cache v1.11 adds kinds 44–45 for normalized draw-order tables and
entity/sort-handle pairs. The reference drawing contains 508 tables and
54,667 entries. Two directory entries, 20,320 table bytes and 874,672 entry
bytes grow the cache by exactly 895,072 bytes (0.51%) to 177,049,408 bytes;
kinds 1–43 remain byte-identical to v1.10. The built-in acadrust oracle and
LibreDWG writer produce byte-identical kind-44 and kind-45 payloads.

Three isolated conversions completed in 2,983 / 2,999 / 3,009 ms with
591,773,696 / 591,822,848 / 591,822,848 bytes peak RSS (minimum / median /
maximum). Output was deterministic and both target gates passed. Opening the
cache still uses two reads; the larger directory adds only 80 bytes. The
Webview does not read either draw-order body section until requested, at
which point two bounded reads total 894,992 bytes.

The completed mask stage combines those two reads with the already deferred
WIPEOUT entity/clip pools: four post-frame reads total 907,712 bytes. The 16
source masks expand through nested and array INSERTs to 2,206 order positions,
then triangulate to 590 triangles (55.3 KiB). A local qualification measured
about 13 ms for the order plan, 24 ms to attach bases while sharing the
existing 97,862 instance matrices, and 16.5 ms to patch the 131,072 overview
vertices in place.

An actual Chromium run reported a 459.7 ms first line frame, 41.0 ms for the
post-frame read/order/attachment stage, a 31.4 MB main-realm JS heap and
4.64 MiB of fitted-view GPU vertex buffers. At 5.95x zoom with the full
32 MiB detail cache selected, the reported JS heap was 148.4 MB and GPU vertex
buffers were 36.64 MiB. WebGL exposed a 24-bit depth buffer, returned no GL
error, and the console had no warning or error. The public fixture also
activates both naturally ordered WIPEOUTs as 12 triangles without requiring a
sort table.

A renderer-memory audit then replaced one `Float32Array` allocation per
instanced draw with a single 1.06 MiB bounded scratch buffer and exposed
current/peak heap and tracked WebGL counters. A repeat Chromium run produced a
517.4 ms first frame, 58.23 MiB fitted-view peak JavaScript heap and 4.64 MiB
tracked WebGL memory. At 5.95x zoom, 297 detail batches reached the intentional
32 MiB detail cap; peak JavaScript heap was 141.26 MiB and tracked WebGL memory
was 36.64 MiB. Returning to fit selected zero detail batches and reduced the
current heap to 44.66 MiB while retaining the bounded detail LRU. A separate
DevTools snapshot reported 20,761,368 bytes used heap, 22,401,296 bytes backing
storage and 4,621,392 bytes embedder heap after return. These counters remain
category measurements rather than a Chromium renderer-process RSS claim.
Console warnings/errors and the WebGL error flag remained zero.

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

The repository now has a deterministic GPL package builder and a separate
Linux x64/macOS arm64 qualification workflow. It requires a stripped,
statically linked adapter, validates the adapter's bounded doctor report,
rejects dynamic LibreDWG dependencies and local build paths, and includes the
exact LibreDWG archive, adapter source, build scripts, license texts, manifest
and checksums. Corresponding source is therefore shipped in the same archive
rather than delegated to an unpinned external URL.

Until public-release signing and the final distribution review are completed:

1. an MPL-only VSIX must not bundle a prebuilt LibreDWG-linked adapter;
2. local development may build the adapter from checksum-pinned source with
   `adapters/libredwg/prepare.sh`;
3. the adapter may only be published as the separately identified
   GPL-3.0-or-later package produced by `adapters/libredwg/package.mjs`;
4. Windows packages remain blocked until the POSIX adapter paths are ported,
   measured and added to the qualification workflow.

ACadSharp 3.6.51 is MIT-licensed, and the optional adapter uses a
checksum-pinned .NET SDK plus a content-hash-locked package. Its permissive
license does not offset its measured memory failure. This section is an
engineering distribution policy, not legal advice.

## Consequences

- Keep the completed v1.11 block-local/nested-INSERT mask buckets, WebGL depth
  composition and Canvas text clipping within their measured order/GPU
  limits; retain the source/frame path as the safe fallback.
- Continue Korean SHX/BigFont and exact MTEXT/OCS work in issues #5 and #7.
- Use acadrust only for public cross-engine fixtures and regression oracles.
- Keep the ACadSharp inspection adapter, package lock and parser preflight test;
  do not build an ACadSharp Scene Cache converter unless a future release
  materially changes the measured memory architecture.
- Keep the source-complete GPL package and two-platform qualification workflow
  as the issue #6 release boundary; complete signing/review before publication.

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
- [Autodesk WIPEOUT DXF group codes](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-2229F9C4-3C80-4C67-9EDA-45ED684808DC.htm)
- [Autodesk WIPEOUTFRAME system variable](https://help.autodesk.com/view/ACD/2024/ENU/?guid=GUID-AF1A9E90-35FB-4A49-AA39-E3456B4F264D)
- [Autodesk object draw order](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-LT-MAC/files/GUID-8203C80A-3D51-49F0-B756-56FDF5D96697.htm)
- [Autodesk SORTENTSTABLE DXF contract](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-462F4378-F850-4E89-90F2-3C1880F55779.htm)
