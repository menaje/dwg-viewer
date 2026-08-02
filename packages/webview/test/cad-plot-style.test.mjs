import assert from "node:assert/strict";
import test from "node:test";

import {
  makePlotStyleLineWeights,
  makePlotStylePalette,
  plotStyleDiagnostics,
  plotStyleShownInLayout,
} from "../src/cad-plot-style.mjs";
import { DEFAULT_ACI_PALETTE } from "../src/cad-color.mjs";

const table = {
  styles: [
    {
      aci: 1,
      color: 0,
      screen: 40,
      grayscale: false,
      lineWeight: 35,
    },
    {
      aci: 2,
      screen: 100,
      grayscale: true,
    },
  ],
};

test("builds screened CTB colors without mutating the model palette", () => {
  const palette = makePlotStylePalette(table);
  assert.deepEqual([...palette.slice(4, 8)], [153, 153, 153, 255]);
  assert.deepEqual([...palette.slice(8, 12)], [226, 226, 226, 255]);
  assert.deepEqual(
    [...DEFAULT_ACI_PALETTE.slice(4, 8)],
    [255, 0, 0, 255],
  );
});

test("builds CTB lineweight overrides and diagnostics", () => {
  const weights = makePlotStyleLineWeights(table);
  assert.equal(weights[1], 35);
  assert.equal(weights[2], -1);
  assert.deepEqual(plotStyleDiagnostics(table), {
    styles: 2,
    colorOverrides: 1,
    grayscaleStyles: 1,
    screenedStyles: 1,
    lineWeightOverrides: 1,
  });
});

test("shows CTB on screen only when the layout stores Display Plot Styles", () => {
  assert.equal(plotStyleShownInLayout({ plotFlags: 676 }), false);
  assert.equal(plotStyleShownInLayout({ plotFlags: 678 }), true);
  assert.equal(plotStyleShownInLayout(null), false);
});
