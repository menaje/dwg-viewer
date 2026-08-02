import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  CtbPlotStyleChannel,
  normalizeCtbName,
  parseCtbPlotStyle,
} from "../src/ctb-plot-style";

const CACHE_ID = "b".repeat(64);

function makeCtb(content: string): Uint8Array {
  const text = Buffer.from(`${content}\0`, "utf8");
  const compressed = deflateSync(text);
  const header = Buffer.alloc(60);
  header.write(
    "PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec",
    0,
    "ascii",
  );
  header.writeUInt32LE(text.byteLength, 52);
  header.writeUInt32LE(compressed.byteLength, 56);
  return new Uint8Array(Buffer.concat([header, compressed]));
}

test("normalizes only bounded CTB basenames", () => {
  assert.equal(normalizeCtbName(String.raw`..\CTB\A3(1-299).CTB`), "a3(1-299).ctb");
  assert.equal(normalizeCtbName("plot.stb"), "");
});

test("parses CTB colors, screening and custom lineweights", () => {
  const table = parseCtbPlotStyle(
    makeCtb(`description="한국 도면
scale_factor=1.0
apply_factor=FALSE
plot_style{
 0{
  color=-1023410176
  mode_color=-1023410176
  color_policy=5
  screen=70
  linetype=31
  adaptive_linetype=TRUE
  lineweight=2
  fill_style=73
  end_style=4
  join_style=5
 }
 1{
  color=-1006632961
  mode_color=-1006632961
  color_policy=1
  screen=100
  linetype=31
  adaptive_linetype=TRUE
  lineweight=0
  fill_style=73
  end_style=4
  join_style=5
 }
}
custom_lineweight_table{
 0=0.00
 1=0.05
 2=0.35
}`),
  );

  assert.equal(table.description, "한국 도면");
  assert.deepEqual(table.styles[0], {
    aci: 1,
    color: 0,
    screen: 70,
    grayscale: false,
    dithering: true,
    lineWeight: 35,
    linetype: 31,
    adaptiveLinetype: true,
    fillStyle: 73,
    endStyle: 4,
    joinStyle: 5,
  });
  assert.equal(table.styles[1].color, undefined);
  assert.equal(table.styles[1].lineWeight, undefined);
});

function simpleCtb(description: string): Uint8Array {
  return makeCtb(`description="${description}
scale_factor=1.0
apply_factor=FALSE
plot_style{
 0{
  color=-1006632961
  mode_color=-1006632961
  color_policy=1
  screen=100
  linetype=31
  adaptive_linetype=TRUE
  lineweight=0
  fill_style=73
 end_style=4
  join_style=5
 }
}
`);
}

function responseCollector(): {
  postMessage: (message: unknown) => Promise<boolean>;
  next: () => Promise<Record<string, any>>;
} {
  const queued: Record<string, any>[] = [];
  const waiting: ((message: Record<string, any>) => void)[] = [];
  return {
    postMessage(message) {
      const response = message as Record<string, any>;
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
      return response
        ? Promise.resolve(response)
        : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function requestCtb(
  channel: CtbPlotStyleChannel,
  requestId: number,
  name: string,
): boolean {
  return channel.handleMessage({
    type: "dwg-plot-style-read/1",
    cacheId: CACHE_ID,
    requestId,
    name,
  });
}

test("uses stored CTB paths and searches project resources before configured folders", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-ctb-test-"));
  const configured = await mkdtemp(path.join(os.tmpdir(), "dwg-ctb-configured-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  context.after(() => rm(configured, { recursive: true, force: true }));
  const drawing = path.join(root, "DWG");
  const nested = path.join(drawing, "plot");
  const project = path.join(root, "CTB,FONT");
  await Promise.all([
    mkdir(nested, { recursive: true }),
    mkdir(project),
  ]);
  await Promise.all([
    writeFile(path.join(nested, "stored.ctb"), simpleCtb("stored")),
    writeFile(path.join(project, "rank.ctb"), simpleCtb("project")),
    writeFile(path.join(configured, "rank.ctb"), simpleCtb("configured")),
  ]);
  const collector = responseCollector();
  const channel = new CtbPlotStyleChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      projectDirectories: [root],
      resourceDirectories: [configured],
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestCtb(channel, 1, String.raw`plot\stored.ctb`);
  const stored = await collector.next();
  assert.equal(stored.status, "loaded");
  assert.equal(stored.source, "stored");
  assert.equal(stored.table.description, "stored");

  requestCtb(channel, 2, "rank.ctb");
  const ranked = await collector.next();
  assert.equal(ranked.status, "loaded");
  assert.equal(ranked.source, "project");
  assert.equal(ranked.table.description, "project");
});

test("lets a manual CTB mapping resolve an equally ranked project match", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dwg-ctb-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const drawing = path.join(root, "DWG");
  const first = path.join(root, "CTB-A");
  const second = path.join(root, "CTB-B");
  await Promise.all([mkdir(drawing), mkdir(first), mkdir(second)]);
  await Promise.all([
    writeFile(path.join(first, "same.ctb"), simpleCtb("first")),
    writeFile(path.join(second, "same.ctb"), simpleCtb("second")),
  ]);
  const selected = path.join(root, "selected.ctb");
  await writeFile(selected, simpleCtb("selected"));
  const collector = responseCollector();
  const channel = new CtbPlotStyleChannel(
    CACHE_ID,
    {
      drawingDirectory: drawing,
      projectDirectories: [root],
    },
    collector.postMessage,
  );
  context.after(() => channel.dispose());

  requestCtb(channel, 1, "same.ctb");
  assert.equal((await collector.next()).status, "ambiguous");
  assert.equal(channel.setSessionMapping("same.ctb", selected), true);
  requestCtb(channel, 2, "same.ctb");
  const mapped = await collector.next();
  assert.equal(mapped.status, "loaded");
  assert.equal(mapped.source, "mapping");
  assert.equal(mapped.table.description, "selected");
});
