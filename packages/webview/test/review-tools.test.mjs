import assert from "node:assert/strict";
import test from "node:test";

import {
  ReviewTools,
  angleAtVertex,
  polygonArea,
  polylineLength,
} from "../src/review-tools.mjs";

const camera = {
  origin: [5, 5, 0],
  worldWidth: 10,
  worldHeight: 10,
  width: 1_000,
  height: 1_000,
};

function candidate({
  displayPoint,
  kind = "endpoint",
  coordinateSpace = 1,
  approximated = false,
}) {
  return {
    displayPoint,
    measurementPoint: displayPoint,
    displaySegment: [
      [displayPoint[0] - 1, displayPoint[1], 0],
      [displayPoint[0] + 1, displayPoint[1], 0],
    ],
    kind,
    coordinateSpace,
    approximated,
  };
}

test("completed distance keeps its own guide instead of selecting the last object", () => {
  const first = candidate({ displayPoint: [1, 2, 0] });
  const last = candidate({
    displayPoint: [4, 6, 0],
    kind: "midpoint",
  });
  const shown = [];
  const statuses = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    firstPoint: first,
    measurementGuide: null,
    selection: candidate({ displayPoint: [9, 9, 0] }),
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: (value) => statuses.push(value),
  });

  tools.selectDistancePoint(last);

  assert.equal(tools.firstPoint, null);
  assert.equal(tools.selection, null);
  assert.deepEqual(tools.measurementGuide, {
    first: [1, 2, 0],
    last: [4, 6, 0],
    firstKind: "endpoint",
    lastKind: "midpoint",
  });
  assert.equal(shown[0].title, "두 점 거리");
  assert.deepEqual(shown[0].rows[0], ["거리", "5 mm"]);
  assert.match(statuses[0], /거리 5 mm/u);
});

test("distance output honors the selected display unit and precision", () => {
  const shown = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    firstPoint: candidate({ displayPoint: [0, 0, 0] }),
    measurementGuide: null,
    selection: null,
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    measurementPreferences: {},
    onMeasurementPreferencesChange: () => {},
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: () => {},
  });
  tools.setMeasurementPreferences({
    displayUnit: "m",
    precision: 2,
  });

  tools.selectDistancePoint(
    candidate({ displayPoint: [3_000, 4_000, 0] }),
  );

  assert.deepEqual(shown[0].rows.slice(0, 2), [
    ["거리", "5.00 m"],
    ["ΔX", "3.00 m"],
  ]);
});

test("unit calibration captures two points and preserves their guide", () => {
  const statuses = [];
  let settingsShown = 0;
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    firstPoint: null,
    pendingCalibration: null,
    measurementGuide: null,
    scene: { metadata: { drawing: { insertionUnits: 0 } } },
    activate: () => {
      tools.firstPoint = null;
    },
    showMeasurementSettings: () => {
      settingsShown += 1;
    },
    onStatus: (value) => statuses.push(value),
  });
  const first = candidate({ displayPoint: [10, 20, 0] });
  const last = candidate({
    displayPoint: [70, 100, 0],
    kind: "midpoint",
  });

  assert.equal(tools.selectCalibrationPoint(first), false);
  assert.equal(tools.selectCalibrationPoint(last), true);

  assert.deepEqual(tools.pendingCalibration, {
    drawingDistance: 100,
    approximated: false,
  });
  assert.deepEqual(tools.measurementGuide, {
    first: [10, 20, 0],
    last: [70, 100, 0],
    firstKind: "endpoint",
    lastKind: "midpoint",
  });
  assert.equal(settingsShown, 1);
  assert.match(statuses.at(-1), /100 도면 단위/u);
});

test("measurement math supports cumulative length, polygon area, and three-point angle", () => {
  const rectangle = [
    [0, 0, 0],
    [3, 0, 0],
    [3, 4, 0],
    [0, 4, 0],
  ];

  assert.equal(polylineLength(rectangle), 10);
  assert.equal(polylineLength(rectangle, { closed: true }), 14);
  assert.equal(polygonArea(rectangle), 12);
  assert.equal(
    angleAtVertex([1, 0, 0], [0, 0, 0], [0, 2, 0]),
    90,
  );
  assert.equal(
    angleAtVertex([0, 0, 0], [0, 0, 0], [0, 2, 0]),
    null,
  );
});

test("area measurement reports area and perimeter and keeps a closed guide", () => {
  const shown = [];
  const statuses = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    measurementPoints: [
      candidate({ displayPoint: [0, 0, 0] }),
      candidate({ displayPoint: [3, 0, 0] }),
      candidate({ displayPoint: [3, 4, 0] }),
      candidate({ displayPoint: [0, 4, 0] }),
    ],
    measurementGuide: {
      first: [9, 9, 0],
      last: [10, 10, 0],
    },
    measurementPath: null,
    selection: candidate({ displayPoint: [9, 9, 0] }),
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: (value) => statuses.push(value),
  });

  assert.equal(tools.finishAreaMeasurement(), true);

  assert.deepEqual(tools.measurementPoints, []);
  assert.equal(tools.measurementGuide, null);
  assert.equal(tools.selection, null);
  assert.equal(tools.measurementPath.closed, true);
  assert.deepEqual(tools.measurementPath.points, [
    [0, 0, 0],
    [3, 0, 0],
    [3, 4, 0],
    [0, 4, 0],
  ]);
  assert.equal(shown[0].title, "면적·둘레");
  assert.deepEqual(shown[0].rows.slice(0, 2), [
    ["면적", "12 mm²"],
    ["둘레", "14 mm"],
  ]);
  assert.match(statuses[0], /면적 12 mm²/u);
});

test("three-point angle completes automatically after the third point", () => {
  const shown = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    activeTool: "angle",
    measurementPoints: [],
    measurementGuide: null,
    measurementPath: null,
    selection: null,
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: () => {},
  });

  tools.selectMultiPoint(candidate({ displayPoint: [1, 0, 0] }));
  tools.selectMultiPoint(candidate({ displayPoint: [0, 0, 0] }));
  tools.selectMultiPoint(candidate({ displayPoint: [0, 1, 0] }));

  assert.deepEqual(tools.measurementPoints, []);
  assert.equal(tools.measurementPath.closed, false);
  assert.equal(shown[0].title, "세 점 각도");
  assert.deepEqual(shown[0].rows[0], ["각도", "90°"]);
});

test("workspace text navigation keeps a dedicated highlighted point", () => {
  const shown = [];
  let redraws = 0;
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    firstPoint: candidate({ displayPoint: [1, 2, 0] }),
    measurementPoints: [],
    measurementGuide: null,
    measurementPath: null,
    textMatch: null,
    selection: candidate({ displayPoint: [3, 4, 0] }),
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: () => {},
    redraw: () => {
      redraws += 1;
    },
  });

  assert.equal(
    tools.showTextMatch({
      point: [10, 20, 0],
      handle: "ABC",
      kind: "ATTDEF",
      value: "문 번호",
    }),
    true,
  );

  assert.deepEqual(tools.textMatch, {
    point: [10, 20, 0],
    handle: "ABC",
  });
  assert.equal(tools.selection, null);
  assert.equal(shown[0].title, "검색한 문자");
  assert.deepEqual(shown[0].rows[2], ["핸들", "0xABC"]);
  assert.equal(redraws, 1);
});

test("curve measurement reports radius and diameter with a center guide", () => {
  const shown = [];
  const statuses = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    measurementGuide: null,
    measurementPath: null,
    textMatch: { point: [9, 9, 0], handle: "1" },
    selection: candidate({ displayPoint: [9, 9, 0] }),
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: (value) => statuses.push(value),
  });
  const selected = {
    ...candidate({
      displayPoint: [15, 20, 0],
      kind: "quadrant",
    }),
    sourceKindName: "원",
    curveMeasurement: {
      kind: "circle",
      displayCenter: [10, 20, 0],
      measurementCenter: [10, 20, 0],
      majorRadius: 5,
      minorRadius: 5,
    },
  };

  assert.equal(tools.showCurveMeasurement(selected), true);

  assert.equal(tools.selection, null);
  assert.equal(tools.textMatch, null);
  assert.deepEqual(tools.measurementGuide, {
    first: [10, 20, 0],
    last: [15, 20, 0],
    firstKind: "center",
    lastKind: "quadrant",
  });
  assert.equal(shown[0].title, "원 치수");
  assert.deepEqual(shown[0].rows.slice(0, 2), [
    ["반지름", "5 mm"],
    ["지름", "10 mm"],
  ]);
  assert.match(statuses[0], /반지름 5 mm/u);
});

test("text selection reports common CAD and text properties with layer actions", () => {
  const shown = [];
  const statuses = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    sources: new Map([
      [
        "root",
        {
          linetypes: [{ code: 7, name: "HIDDEN" }],
        },
      ],
    ]),
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    showResult: (title, rows, options) =>
      shown.push({ title, rows, options }),
    onStatus: (value) => statuses.push(value),
  });
  const selected = {
    ...candidate({ displayPoint: [1, 2, 0], kind: "entity" }),
    sourceId: "root",
    sourceLabel: "현재 도면",
    sourceKindName: "ATTDEF",
    entityType: "text",
    entityRecord: {
      value: String.raw`{\H1.2x;호실}\P번호`,
      tag: "ROOM_NO",
      prompt: "호실 번호",
      style: { name: "STANDARD" },
      height: 250,
      rotation: Math.PI / 2,
    },
    handle: 0xabcn,
    layerIndex: 3,
    layerName: "A-ANNO-TEXT",
    color: (3 << 30) | 0x12abef,
    lineWeight: 25,
    linetypeCode: 7,
  };

  tools.showSelection(selected);

  assert.equal(shown[0].title, "ATTDEF 속성");
  assert.deepEqual(shown[0].options, {
    layerActions: true,
    layerIndex: 3,
  });
  assert.deepEqual(shown[0].rows.slice(0, 7), [
    ["종류", "ATTDEF"],
    ["핸들", "0xABC"],
    ["레이어", "A-ANNO-TEXT"],
    ["참조", "현재 도면"],
    ["색상", "RGB #12ABEF"],
    ["선종류", "HIDDEN"],
    ["선가중치", "0.25 mm"],
  ]);
  assert.ok(
    shown[0].rows.some(
      ([label, value]) =>
        label === "내용" && value === "호실\n번호",
    ),
  );
  assert.ok(
    shown[0].rows.some(
      ([label, value]) => label === "태그" && value === "ROOM_NO",
    ),
  );
  assert.match(statuses[0], /핸들 0xABC/u);
});

test("polyline selection reports its whole length and enclosed area", () => {
  const shown = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    sources: new Map([["root", { linetypes: [] }]]),
    scene: { metadata: { drawing: { insertionUnits: 4 } } },
    showResult: (title, rows) => shown.push({ title, rows }),
    onStatus: () => {},
  });

  tools.showSelection({
    ...candidate({ displayPoint: [1, 2, 0], kind: "nearest" }),
    sourceId: "root",
    sourceLabel: "현재 도면",
    sourceKind: 1,
    sourceKindName: "경량 폴리선",
    handle: 0x99n,
    layerIndex: 1,
    layerName: "A-WALL",
    color: 0,
    lineWeight: -1,
    linetypeCode: 2,
    objectMeasurement: {
      length: 14,
      area: 12,
      closed: true,
      approximated: false,
    },
  });

  assert.ok(
    shown[0].rows.some(
      ([label, value]) => label === "전체 길이" && value === "14 mm",
    ),
  );
  assert.ok(
    shown[0].rows.some(
      ([label, value]) => label === "면적" && value === "12 mm²",
    ),
  );
});

test("review candidate search includes text and image overlay hits", () => {
  const overlayCandidate = candidate({
    displayPoint: [5, 5, 0],
    kind: "entity",
  });
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    camera,
    getCamera: () => camera,
    canvas: {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 1_000,
        height: 1_000,
      }),
    },
    measurementPoints: [],
    firstPoint: null,
    detailEntries: new Map(),
    ensureIndex: () => ({ find: () => null }),
    findOverlayCandidates: ({ x, y, snapKinds }) => {
      assert.deepEqual([x, y], [500, 500]);
      assert.deepEqual(snapKinds, ["entity", "nearest"]);
      return [overlayCandidate];
    },
  });

  const found = tools.find(
    { clientX: 500, clientY: 500 },
    ["entity", "nearest"],
  );

  assert.equal(found, overlayCandidate);
});

test("resolves delta overlay candidates against the active pick revision", () => {
  const overlayCandidate = {
    ...candidate({
      displayPoint: [5, 5, 0],
      kind: "entity",
    }),
    handle: 0x2an,
    sourceId: "root",
    renderDelta: true,
    entityRecord: { ownerHandle: 0x100n },
  };
  const pickIdentity = Object.freeze({
    status: "upsert",
    revisionId: "revision:pick:2",
    renderId: "dwg:root:2A",
  });
  const contexts = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    camera,
    getCamera: () => camera,
    canvas: {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 1_000,
        height: 1_000,
      }),
    },
    measurementPoints: [],
    firstPoint: null,
    detailEntries: new Map(),
    ensureIndex: () => ({ find: () => null }),
    findOverlayCandidates: () => [overlayCandidate],
    resolveRenderPick(context) {
      contexts.push(context);
      return pickIdentity;
    },
  });

  const found = tools.find(
    { clientX: 500, clientY: 500 },
    ["entity"],
  );

  assert.equal(found.renderPick, pickIdentity);
  assert.deepEqual(contexts, [
    {
      origin: "delta",
      sceneId: "root",
      handle: 0x2an,
      ownerHandle: 0x100n,
    },
  ]);
});

test("attaches the active revision once after choosing an unchanged base pick", () => {
  const baseCandidate = {
    ...candidate({
      displayPoint: [5, 5, 0],
      kind: "entity",
    }),
    handle: 0x2bn,
    sourceId: "root",
  };
  const pickIdentity = Object.freeze({
    status: "base",
    revisionId: "revision:pick:2",
    renderId: "dwg:root:2B",
  });
  const contexts = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    camera,
    getCamera: () => camera,
    canvas: {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 1_000,
        height: 1_000,
      }),
    },
    measurementPoints: [],
    firstPoint: null,
    detailEntries: new Map(),
    ensureIndex: () => ({ find: () => baseCandidate }),
    findOverlayCandidates: () => [],
    resolveRenderPick(context) {
      contexts.push(context);
      return context.includeIdentity ? pickIdentity : true;
    },
  });

  const found = tools.find(
    { clientX: 500, clientY: 500 },
    ["entity"],
  );

  assert.equal(found.renderPick, pickIdentity);
  assert.deepEqual(contexts, [
    {
      origin: "base",
      sceneId: "root",
      handle: 0x2bn,
      ownerHandle: null,
      includeIdentity: true,
    },
  ]);
});

test("publishes picked and cleared selection lifecycle changes", () => {
  const changes = [];
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    selection: null,
    onSelectionChange(selection, options) {
      changes.push({ selection, options });
    },
  });
  const selected = candidate({
    displayPoint: [2, 3, 0],
    kind: "entity",
  });

  assert.equal(
    tools.replaceSelection(selected, { reason: "pick" }),
    selected,
  );
  assert.equal(tools.clearSelection("tool.clear"), true);
  assert.equal(tools.clearSelection("tool.clear"), false);
  assert.deepEqual(changes, [
    {
      selection: selected,
      options: { reason: "pick" },
    },
    {
      selection: null,
      options: { reason: "tool.clear" },
    },
  ]);
});

test("delegates stale review state reset to Viewer UI", () => {
  let resets = 0;
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    reviewUi: {
      resetTools() {
        resets += 1;
        return true;
      },
    },
  });

  assert.equal(tools.resetToolControls(), true);
  assert.equal(resets, 1);
});

test("refreshes a composite filled-object index when an XREF mounts", async () => {
  const emptyData = () => ({
    records: [],
    displayPoints: new Float64Array(0),
    measurementPoints: new Float64Array(0),
    ringStarts: new Uint32Array(0),
    ringCounts: new Uint32Array(0),
    ringDepths: new Uint16Array(0),
    clipNodes: [],
    truncated: false,
  });
  const statuses = [];
  let loads = 0;
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    activeTool: "select",
    filledState: "idle",
    filledRevision: 0,
    filledAbortController: null,
    filledLoadPromise: Promise.resolve(),
    filledIndex: null,
    scene: { metadata: { layers: [{ name: "0" }] } },
    getLayerVisibility: () => [true],
    loadFilledObjects: async () => {
      loads += 1;
      return {
        sources: [
          {
            id: "root",
            label: "현재 도면",
            layers: [{ name: "0" }],
            data: emptyData(),
          },
          {
            id: "xref",
            label: "X-TITLE",
            layers: [{ name: "0" }],
            data: emptyData(),
          },
        ],
        truncated: false,
        failedSources: 0,
      };
    },
    onStatus: (value) => statuses.push(value),
    redraw: () => {},
  });

  await tools.prepareFilledObjects();
  assert.equal(loads, 1);
  assert.equal(tools.filledIndex.snapshot().sources, 2);
  assert.match(statuses.at(-1), /외부참조 포함 2개 도면/u);

  await tools.refreshFilledObjects();
  assert.equal(loads, 2);
  assert.equal(tools.filledState, "ready");
});

test("clearing review results also clears the completed distance guide", () => {
  let redraws = 0;
  let resultHidden = false;
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    firstPoint: candidate({ displayPoint: [1, 2, 0] }),
    hover: candidate({ displayPoint: [2, 3, 0] }),
    measurementGuide: {
      first: [1, 2, 0],
      last: [4, 6, 0],
    },
    measurementPoints: [
      candidate({ displayPoint: [3, 4, 0] }),
    ],
    measurementPath: {
      points: [[1, 2, 0], [3, 4, 0]],
      kinds: ["endpoint", "endpoint"],
      closed: false,
    },
    textMatch: {
      point: [8, 9, 0],
      handle: "ABC",
    },
    selection: candidate({ displayPoint: [4, 6, 0] }),
    reviewUi: {
      hideResult() {
        resultHidden = true;
      },
    },
    redraw: () => {
      redraws += 1;
    },
  });

  tools.clear();

  assert.equal(tools.firstPoint, null);
  assert.equal(tools.hover, null);
  assert.equal(tools.measurementGuide, null);
  assert.deepEqual(tools.measurementPoints, []);
  assert.equal(tools.measurementPath, null);
  assert.equal(tools.textMatch, null);
  assert.equal(tools.selection, null);
  assert.equal(resultHidden, true);
  assert.equal(redraws, 1);
});

test("redraw renders the completed distance as a dashed guide with endpoint markers", () => {
  const calls = [];
  const context = {
    setTransform: (...values) => calls.push(["setTransform", ...values]),
    clearRect: (...values) => calls.push(["clearRect", ...values]),
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    translate: (...values) => calls.push(["translate", ...values]),
    setLineDash: (values) => calls.push(["setLineDash", ...values]),
    beginPath: () => calls.push(["beginPath"]),
    moveTo: (...values) => calls.push(["moveTo", ...values]),
    lineTo: (...values) => calls.push(["lineTo", ...values]),
    rect: (...values) => calls.push(["rect", ...values]),
    arc: (...values) => calls.push(["arc", ...values]),
    closePath: () => calls.push(["closePath"]),
    fill: () => calls.push(["fill"]),
    stroke: () => calls.push(["stroke"]),
  };
  const canvas = {
    clientWidth: 1_000,
    clientHeight: 1_000,
    width: 1_000,
    height: 1_000,
  };
  const overlay = {
    width: 1_000,
    height: 1_000,
    getContext: () => context,
  };
  const tools = Object.create(ReviewTools.prototype);
  Object.assign(tools, {
    canvas,
    overlay,
    camera,
    getCamera: () => camera,
    selection: null,
    measurementGuide: {
      first: [0, 0, 0],
      last: [10, 0, 0],
      firstKind: "endpoint",
      lastKind: "midpoint",
    },
    firstPoint: null,
    hover: null,
  });

  tools.redraw();

  assert.equal(
    calls.some(
      (call) =>
        call[0] === "moveTo" && call[1] === 0 && call[2] === 1_000,
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call[0] === "lineTo" && call[1] === 1_000 && call[2] === 1_000,
    ),
    true,
  );
  assert.equal(
    calls.some(
      (call) =>
        call[0] === "setLineDash" && call[1] === 8 && call[2] === 4,
    ),
    true,
  );
  assert.equal(
    calls.filter((call) => call[0] === "translate").length,
    2,
  );
});
