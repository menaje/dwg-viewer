# Third-party notices

## Optional dependency: GNU LibreDWG

- Project: https://www.gnu.org/software/libredwg/
- Version: 0.14
- License: GNU General Public License 3.0 or later
- Usage: selected process-isolated DWG parsing and Scene Cache conversion
  engine

LibreDWG is not linked into the MPL-2.0 Rust or Webview components. The optional
adapter binary links to LibreDWG and must be distributed under terms compatible
with GPL-3.0-or-later.

## Optional benchmark dependency: ACadSharp

- Project: https://github.com/DomCR/ACadSharp
- Version: 3.6.51
- License: MIT
- Usage: process-isolated parser-memory preflight and compatibility comparison

ACadSharp is content-hash locked in `adapters/acadsharp/packages.lock.json`.
It is not part of the selected viewer runtime because its parser exceeds the
large-drawing memory hard limit.

## Portable ACadSharp build runtime: .NET

- Project: https://github.com/dotnet
- SDK version: 9.0.316
- License: MIT on the supported Linux and macOS product distributions
- Usage: downloaded into an isolated build directory only to prepare and run
  the optional ACadSharp benchmark adapter

The downloaded SDK archive includes its authoritative license and third-party
notices. It is not installed globally or bundled in the viewer.

## Portable build tool: pkgconf

- Project: https://github.com/pkgconf/pkgconf
- Version: 3.0.4
- License: ISC
- Usage: downloaded only when `pkg-config` is unavailable while preparing the
  optional LibreDWG adapter

## @mlightcad/shx-parser

- Project: https://github.com/mlightcad/shx-parser
- Version: 1.4.5
- License: MIT
- Usage: browser-local SHX, BigFont, Extended BigFont and Unifont parsing

The Webview imports the package's ESM build. Fonts and glyphs are opened lazily
under explicit byte and record limits; no font data is sent to an external
service.

## Earcut

- Project: https://github.com/mapbox/earcut
- Version: 3.2.3
- License: ISC
- Usage: browser-local triangulation of bounded HATCH rings after the first
  line frame

The Webview caps source and generated HATCH vertices before triangulation.
Pattern strokes remain deferred; solid and gradient rings are triangulated
locally without a service or paid SDK.
