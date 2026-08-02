import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeDrawingFontName,
  normalizeShxFontName,
  ShxFontChannel,
} from "../src/shx-font-channel";

const CACHE_ID = "c".repeat(64);

interface FontResponse {
  type: string;
  cacheId: string;
  requestId: number;
  requestedName: string;
  status: string;
  resolvedName?: string;
  source?: string;
  size?: number;
  bytes?: ArrayBuffer;
  error?: string;
}

function responseCollector(): {
  postMessage: (message: unknown) => Promise<boolean>;
  next: () => Promise<FontResponse>;
} {
  const queued: FontResponse[] = [];
  const waiting: ((message: FontResponse) => void)[] = [];
  return {
    postMessage(message) {
      const response = message as FontResponse;
      const resolve = waiting.shift();
      if (resolve) {
        resolve(response);
      } else {
        queued.push(response);
      }
      return Promise.resolve(true);
    },
    next() {
      const response = queued.shift();
      if (response) {
        return Promise.resolve(response);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "dwg-shx-font-test-"));
}

function requestFont(
  channel: ShxFontChannel,
  requestId: number,
  name: string,
  cacheId = CACHE_ID,
): boolean {
  return channel.handleMessage({
    type: "dwg-font-read/1",
    cacheId,
    requestId,
    name,
  });
}

test("normalizes requested Windows, POSIX, extensionless, and invalid names", () => {
  assert.equal(
    normalizeShxFontName("C:\\CAD Fonts\\WHGTXT.SHX"),
    "whgtxt.shx",
  );
  assert.equal(normalizeShxFontName("/fonts/KSC.SHX"), "ksc.shx");
  assert.equal(normalizeShxFontName("txt"), "txt.shx");
  assert.equal(normalizeShxFontName("../font.ttf"), "");
  assert.equal(
    normalizeDrawingFontName("C:\\CAD Fonts\\굵은돋움체.TTF"),
    "굵은돋움체.ttf",
  );
  assert.equal(normalizeDrawingFontName("/fonts/type.OTF"), "type.otf");
  assert.equal(normalizeShxFontName("\0bad.shx"), "");
});

test("loads a case-insensitive SHX match from the drawing folder first", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "drawing");
  const configured = path.join(root, "configured");
  await Promise.all([
    mkdir(drawing),
    mkdir(configured),
  ]);
  await Promise.all([
    writeFile(path.join(drawing, "TXT.SHX"), Uint8Array.of(1, 2, 3)),
    writeFile(path.join(configured, "txt.shx"), Uint8Array.of(9, 9, 9)),
  ]);
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      fontDirectories: [configured],
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  assert.equal(requestFont(channel, 1, "C:\\Fonts\\txt.shx"), true);
  const response = await collector.next();
  assert.equal(response.status, "loaded");
  assert.equal(response.source, "drawing");
  assert.equal(response.resolvedName, "TXT.SHX");
  assert.ok(response.bytes);
  assert.deepEqual([...new Uint8Array(response.bytes)], [1, 2, 3]);
});

test("applies a configured replacement before an exact-name match", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "drawing");
  const configured = path.join(root, "configured");
  await Promise.all([mkdir(drawing), mkdir(configured)]);
  await Promise.all([
    writeFile(path.join(drawing, "WHGTXT.SHX"), Uint8Array.of(1)),
    writeFile(path.join(configured, "KOREAN.SHX"), Uint8Array.of(7, 8)),
  ]);
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      fontDirectories: [configured],
      fontMappings: {
        "whgtxt.shx": "KOREAN.SHX",
      },
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestFont(channel, 1, "WHGTXT.SHX");
  const response = await collector.next();
  assert.equal(response.status, "loaded");
  assert.equal(response.source, "mapping");
  assert.equal(response.resolvedName, "KOREAN.SHX");
  assert.ok(response.bytes);
  assert.deepEqual([...new Uint8Array(response.bytes)], [7, 8]);
});

test("supports an explicit absolute replacement outside indexed folders", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "drawing");
  const replacement = path.join(root, "replacement.shx");
  await mkdir(drawing);
  await writeFile(replacement, Uint8Array.of(4, 5, 6));
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      fontMappings: { "missing.shx": replacement },
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestFont(channel, 1, "missing.shx");
  const response = await collector.next();
  assert.equal(response.status, "loaded");
  assert.equal(response.source, "mapping");
  assert.ok(response.bytes);
  assert.deepEqual([...new Uint8Array(response.bytes)], [4, 5, 6]);
});

test("does not recursively scan configured font folders", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "drawing");
  const fonts = path.join(root, "fonts");
  const nested = path.join(fonts, "nested");
  await Promise.all([mkdir(drawing), mkdir(nested, { recursive: true })]);
  await writeFile(path.join(nested, "hidden.shx"), Uint8Array.of(1));
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      fontDirectories: [fonts],
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestFont(channel, 1, "hidden.shx");
  const response = await collector.next();
  assert.equal(response.status, "missing");
  assert.equal(response.bytes, undefined);
});

test("finds an exact TTF in a sibling project resource folder", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "DWG");
  const fonts = path.join(root, "CTB,FONT");
  await Promise.all([
    mkdir(drawing),
    mkdir(fonts),
  ]);
  await writeFile(
    path.join(fonts, "굵은돋움체.TTF"),
    Uint8Array.of(0, 1, 0, 0, 9),
  );
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      projectDirectories: [root],
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestFont(channel, 1, "C:\\Windows\\Fonts\\굵은돋움체.ttf");
  const response = await collector.next();
  assert.equal(response.status, "loaded");
  assert.equal(response.source, "project");
  assert.equal(response.resolvedName, "굵은돋움체.TTF");
  assert.deepEqual([...new Uint8Array(response.bytes!)], [0, 1, 0, 0, 9]);
});

test("does not silently choose equally near project fonts", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "DWG");
  const first = path.join(root, "FONT-A");
  const second = path.join(root, "FONT-B");
  await Promise.all([mkdir(drawing), mkdir(first), mkdir(second)]);
  await Promise.all([
    writeFile(path.join(first, "same.ttf"), Uint8Array.of(1)),
    writeFile(path.join(second, "SAME.TTF"), Uint8Array.of(2)),
  ]);
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      projectDirectories: [root],
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestFont(channel, 1, "same.ttf");
  const response = await collector.next();
  assert.equal(response.status, "ambiguous");
  assert.equal(response.bytes, undefined);
});

test("rejects fonts and aggregate transfers above configured byte limits", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "drawing");
  await mkdir(drawing);
  await Promise.all([
    writeFile(path.join(drawing, "large.shx"), Buffer.alloc(5)),
    writeFile(path.join(drawing, "first.shx"), Buffer.alloc(4, 1)),
    writeFile(path.join(drawing, "second.shx"), Buffer.alloc(4, 2)),
  ]);
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      maximumFileBytes: 4,
      maximumTransferBytes: 6,
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestFont(channel, 1, "large.shx");
  assert.equal((await collector.next()).status, "too-large");
  requestFont(channel, 2, "first.shx");
  assert.equal((await collector.next()).status, "loaded");
  requestFont(channel, 3, "second.shx");
  const budgetResponse = await collector.next();
  assert.equal(budgetResponse.status, "budget-exceeded");
  assert.equal(budgetResponse.bytes, undefined);
});

test("isolates mismatched caches, invalid names, and unrelated messages", async (context) => {
  const root = await temporaryDirectory();
  context.after(() => rm(root, { recursive: true, force: true }));
  const collector = responseCollector();
  const channel = new ShxFontChannel(
    CACHE_ID,
    { drawingDirectory: root },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  assert.equal(channel.handleMessage({ type: "other" }), false);
  assert.equal(requestFont(channel, 1, "txt.shx", "d".repeat(64)), true);
  assert.equal((await collector.next()).status, "invalid");
  assert.equal(requestFont(channel, 2, "font.woff"), true);
  assert.equal((await collector.next()).status, "invalid");
});
