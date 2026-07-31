# DWG Viewer for VS Code

Free, local-first, read-only DWG viewing inside VS Code.

This early build opens `.dwg` files with a native Custom Editor, converts them
to the project scene-cache format on the local machine, and streams only the
ranges required by the Webview. Drawing data is never uploaded.

## Native converter

The extension deliberately does not bundle the GPL-licensed LibreDWG adapter in
the MPL-licensed VSIX. Build or install the repository's
`libredwg-adapter` separately, then set:

```json
{
  "dwgViewer.libredwgAdapterPath": "/absolute/path/to/libredwg-adapter"
}
```

For local development only, `DWG_VIEWER_LIBREDWG_ADAPTER` can provide the same
absolute path. A separately distributed adapter may also be placed at
`native/<platform>-<architecture>/libredwg-adapter`.

The first open creates a private cache under VS Code's extension storage.
Subsequent opens reuse it until the drawing or converter changes.

## Current scope

- Read-only model-space viewing
- Bounded cache range reads (maximum 8 MiB per request)
- Layer visibility, pan, zoom, hatch, text, and SHX font selection
- Conversion cancellation when the editor closes
- Retry and forced cache rebuild

This is the first integration milestone tracked by GitHub issue #19.
