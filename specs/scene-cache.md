# Scene cache format

Status: draft; implementation tracked by GitHub issue #3.

The cache will be a little-endian, versioned binary container designed for
direct `ArrayBuffer` and typed-array views in a browser.

Planned sections:

1. magic, schema version and source identity;
2. drawing bounds and units;
3. layer, linetype, color and text-style tables;
4. shared block definitions;
5. block instance transforms;
6. packed primitive buffers;
7. text runs and glyph references;
8. spatial chunk directory;
9. entity IDs and diagnostic metadata.

The first implementation must avoid JSON geometry and must permit independent
range reads of visible chunks.
