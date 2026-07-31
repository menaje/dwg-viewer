# Third-party notices

## acadrust

- Project: https://github.com/hakanaktt/acadrust
- Version: 0.4.1
- License: Mozilla Public License 2.0
- Usage: native DWG parsing candidate

## Optional dependency: GNU LibreDWG

- Project: https://www.gnu.org/software/libredwg/
- Version: 0.13.4
- License: GNU General Public License 3.0 or later
- Usage: optional process-isolated DWG parsing and Scene Cache conversion
  candidate

LibreDWG is not linked into the MPL-2.0 Rust or Webview components. The optional
adapter binary links to LibreDWG and must be distributed under terms compatible
with GPL-3.0-or-later.

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
