# Third-party notices

This file is included in the VSIX. The summaries below do not replace the
applicable license texts or copyright notices.

## Bundled Webview components

### @mlightcad/shx-parser

- Project: https://github.com/mlightcad/shx-parser
- Version: 1.4.5
- License: MIT
- Usage: browser-local SHX, BigFont, Extended BigFont and Unifont parsing

The Webview imports the package's ESM build. Fonts and glyphs are opened lazily
under explicit byte and record limits; no font data is sent to an external
service.

MIT License

Copyright (c) 2024 mlight-lee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Earcut

- Project: https://github.com/mapbox/earcut
- Version: 3.2.3
- License: ISC
- Usage: browser-local triangulation of bounded HATCH rings after the first
  line frame

The Webview caps source and generated HATCH vertices before triangulation.
Pattern strokes remain deferred; solid and gradient rings are triangulated
locally without an external service.

ISC License

Copyright (c) 2026, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Separately distributed runtime

### GNU LibreDWG

- Project: https://www.gnu.org/software/libredwg/
- Version: 0.14
- License: GNU General Public License 3.0 or later
- Usage: selected process-isolated DWG parsing and Scene Cache conversion
  engine

LibreDWG is not linked into the MPL-2.0 Rust or Webview components. The
separately distributed adapter binary links to LibreDWG and must be distributed
under terms compatible with GPL-3.0-or-later.

The linked adapter is not included in the VSIX. Its separate release archive
includes the full GPL text, the exact LibreDWG source archive, corresponding
adapter source, build scripts, a manifest, and checksums.

## Development and qualification components

### ACadSharp

- Project: https://github.com/DomCR/ACadSharp
- Version: 3.6.51
- License: MIT
- Usage: process-isolated parser-memory preflight and compatibility comparison

ACadSharp is content-hash locked in `adapters/acadsharp/packages.lock.json`.
It is not part of the selected viewer runtime because its parser exceeds the
large-drawing memory hard limit.

### .NET SDK

- Project: https://github.com/dotnet
- SDK version: 9.0.316
- License: MIT on the supported Linux and macOS product distributions
- Usage: downloaded into an isolated build directory only to prepare and run
  the optional ACadSharp benchmark adapter

The downloaded SDK archive includes its authoritative license and third-party
notices. It is not installed globally or bundled in the viewer.

### pkgconf

- Project: https://github.com/pkgconf/pkgconf
- Version: 3.0.4
- License: ISC
- Usage: downloaded only when `pkg-config` is unavailable while preparing the
  separately distributed LibreDWG adapter
