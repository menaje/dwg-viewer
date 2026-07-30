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

## Planned dependency: mlightcad/shx-parser

- Project: https://github.com/mlightcad/shx-parser
- License: MIT
- Planned usage: SHX, BigFont and Extended BigFont parsing

The planned dependency is listed for architectural transparency and is not yet
included in a shipped build.
