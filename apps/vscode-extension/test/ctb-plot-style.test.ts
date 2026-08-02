import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  normalizeCtbName,
  parseCtbPlotStyle,
} from "../src/ctb-plot-style";

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
