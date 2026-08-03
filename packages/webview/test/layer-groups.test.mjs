import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLayerGroups,
  isolateLayerGroup,
  layerGroupVisibility,
  setLayerGroupVisibility,
  splitExternalLayerName,
} from "../src/layer-groups.mjs";

test("splits only valid XREF-dependent layer names", () => {
  assert.deepEqual(splitExternalLayerName("외부 제목-01|상세 치수"), {
    external: true,
    fullName: "외부 제목-01|상세 치수",
    groupName: "외부 제목-01",
    localName: "상세 치수",
  });
  assert.deepEqual(splitExternalLayerName("A|B|TEXT"), {
    external: true,
    fullName: "A|B|TEXT",
    groupName: "A",
    localName: "B|TEXT",
  });
  assert.equal(splitExternalLayerName("현재 레이어").external, false);
  assert.equal(splitExternalLayerName("|잘못됨").external, false);
  assert.equal(splitExternalLayerName("잘못됨|").external, false);
});

test("groups root layers and case-insensitive XREF prefixes without reordering rows", () => {
  const groups = buildLayerGroups([
    { name: "0" },
    { name: "Reference-A|sht-text" },
    { name: "A-ANNO" },
    { name: "REFERENCE-A|DIM" },
    { name: "설비|PIPE" },
    { name: "reference-a|TEXT" },
  ]);

  assert.deepEqual(
    groups.map(({ kind, name, layerIndices }) => ({
      kind,
      name,
      layerIndices,
    })),
    [
      {
        kind: "root",
        name: "현재 도면",
        layerIndices: [0, 2],
      },
      {
        kind: "xref",
        name: "설비",
        layerIndices: [4],
      },
      {
        kind: "xref",
        name: "Reference-A",
        layerIndices: [1, 3, 5],
      },
    ],
  );
  assert.deepEqual(
    groups[2].rows.map(({ displayName }) => displayName),
    ["sht-text", "DIM", "TEXT"],
  );
  assert.match(groups[2].searchText, /reference-a\|dim/u);
});

test("derives arbitrary Unicode and nested XREF groups only from drawing rows", () => {
  const groups = buildLayerGroups([
    { name: "" },
    { name: "설비 01|급수 배관" },
    { name: "설비 01|환기|덕트-A" },
    { name: "MEP Δ-02|照明-1" },
    { name: "사용자 자유 레이어" },
  ]);

  assert.deepEqual(
    groups.map(({ name, layerIndices }) => ({ name, layerIndices })),
    [
      { name: "현재 도면", layerIndices: [0, 4] },
      { name: "설비 01", layerIndices: [1, 2] },
      { name: "MEP Δ-02", layerIndices: [3] },
    ],
  );
  assert.deepEqual(
    groups[1].rows.map(({ displayName }) => displayName),
    ["급수 배관", "환기|덕트-A"],
  );
});

test("computes mixed group state and applies group visibility immutably", () => {
  const [, xref] = buildLayerGroups([
    { name: "0" },
    { name: "title|A" },
    { name: "title|B" },
  ]);
  const visibility = [true, true, false];

  assert.deepEqual(layerGroupVisibility(xref, visibility), {
    checked: false,
    indeterminate: true,
    total: 2,
    visible: 1,
  });
  assert.deepEqual(
    setLayerGroupVisibility(visibility, xref, true),
    [true, true, true],
  );
  assert.deepEqual(
    setLayerGroupVisibility(visibility, xref, false),
    [true, false, false],
  );
  assert.deepEqual(isolateLayerGroup(visibility, xref), [
    false,
    true,
    true,
  ]);
  assert.deepEqual(visibility, [true, true, false]);
});

test("rejects stale group indices before changing visibility", () => {
  const group = {
    layerIndices: [2],
  };
  assert.throws(
    () => setLayerGroupVisibility([true, false], group, true),
    /invalid layer index/u,
  );
  assert.throws(
    () => isolateLayerGroup([true, false], group),
    /invalid layer index/u,
  );
});
