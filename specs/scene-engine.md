# Scene Engine protocol v1

Issue [#17](https://github.com/menaje/dwg-viewer/issues/17) validates optional
execution backends without replacing the accepted LibreDWG Native path or
forking the renderer. The extension-side contract is
`dwg-scene-engine/1`.

## Boundary

```text
DWG
  -> SceneCacheManager
       -> LibreDWG Native process (product default)
       -> WASM Worker candidate (qualification only)
  -> Scene Cache v1.11
  -> one range reader and one WebGL renderer
```

A `SceneEngine` supplies:

- an immutable engine and backend descriptor;
- a revision snapshot used to detect implementation changes;
- one cancellable conversion method that writes the requested packed cache;
- bounded progress events tied to the descriptor.

The parser and execution backend are separate identities. LibreDWG Native and
a future LibreDWG WASM build therefore share `engineId=libredwg` and the exact
engine version, but use different backend IDs and kinds. Their caches do not
overlap unless a later qualification proves byte-identical output and changes
this policy explicitly.

## Capabilities

Every descriptor declares:

- local-only execution;
- packed Scene Cache output;
- whether a usable preview can be published before the full cache;
- cancellation support;
- supported geometry/text feature families;
- accepted conversion option names.

The current product descriptor is `libredwg` 0.14 on backend `native` with
kind `native-process`. It declares linework, blocks, HATCH, WIPEOUT, text and
SHX/BigFont support. Its converter writes the complete cache atomically, so
`progressivePreview` is false. A WASM candidate may declare true only when its
Worker publishes a bounded, independently readable preview without creating a
whole-drawing JavaScript object graph.

## Progress

Events use `dwg-scene-engine-progress/1` and always include engine ID, engine
version, backend ID and backend kind.

| Phase | Meaning |
| --- | --- |
| `checking` | The cache manager is checking an existing cache and identities. |
| `parsing` | The backend is parsing or converting the DWG. |
| `preview-ready` | A progressive backend has published a bounded usable preview. |
| `validating` | The backend is validating packed output. |
| `cache-ready` | The cache has been validated and committed, or safely reused. |
| `failed` | Preparation ended with an error. |
| `cancelled` | Preparation ended after explicit cancellation. |

`cache-ready`, `failed` and `cancelled` are terminal for one preparation
attempt. Native process termination, temporary-file cleanup and retry
serialization remain unchanged behind the common contract.

## Cache identity

The private cache filename is a SHA-256 digest over length-prefixed fields:

```text
SceneEngine contract
+ Scene Cache version
+ resolved source path, size and modification time
+ engine ID and version
+ backend ID and kind
+ implementation revision
+ canonical sorted conversion options
```

Only the digest becomes the filename. Option order cannot change the identity,
while changing an option value, engine/backend version or implementation
revision must change it. Source and engine snapshots are checked again after
conversion before the temporary output is committed.

## WASM admission

The common TypeScript path can already exercise a progressive
`wasm-worker`-shaped test engine. This is contract scaffolding, not a shipped
WASM parser. A real candidate remains excluded from settings, automatic
selection, fallback and the VSIX until it:

1. writes the same supported Scene Cache contract without a full JavaScript
   drawing graph;
2. passes geometry, Korean text and SHX/BigFont comparison;
3. stays below 300 MB stable Webview memory and 800 MB concurrent total memory;
4. proves cancellation and Worker cleanup;
5. demonstrates a measured installation, isolation or user-perceived
   performance benefit over LibreDWG Native;
6. completes its license and package review.

LibreDWG Native remains the only product backend while those gates are open.
