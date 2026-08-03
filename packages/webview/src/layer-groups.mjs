const ROOT_GROUP_ID = "root";

function normalizedLayerName(value) {
  return String(value ?? "").normalize("NFC");
}

function searchKey(value) {
  return normalizedLayerName(value).toLocaleLowerCase("ko-KR");
}

export function splitExternalLayerName(value) {
  const fullName = normalizedLayerName(value);
  const separator = fullName.indexOf("|");
  if (separator <= 0 || separator >= fullName.length - 1) {
    return Object.freeze({
      external: false,
      fullName,
      groupName: "",
      localName: fullName,
    });
  }
  return Object.freeze({
    external: true,
    fullName,
    groupName: fullName.slice(0, separator),
    localName: fullName.slice(separator + 1),
  });
}

export function buildLayerGroups(layers) {
  if (!Array.isArray(layers)) {
    throw new TypeError("layers must be an array");
  }
  const root = {
    id: ROOT_GROUP_ID,
    kind: "root",
    name: "현재 도면",
    rows: [],
  };
  const externalByKey = new Map();
  for (const [index, layer] of layers.entries()) {
    const parsed = splitExternalLayerName(layer?.name);
    const row = Object.freeze({
      index,
      fullName: parsed.fullName,
      displayName: parsed.external ? parsed.localName : parsed.fullName,
      searchText: searchKey(
        [parsed.fullName, parsed.groupName, parsed.localName].join("\n"),
      ),
    });
    if (!parsed.external) {
      root.rows.push(row);
      continue;
    }
    const key = searchKey(parsed.groupName);
    let group = externalByKey.get(key);
    if (!group) {
      group = {
        id: `xref:${key}`,
        kind: "xref",
        name: parsed.groupName,
        rows: [],
      };
      externalByKey.set(key, group);
    }
    group.rows.push(row);
  }

  const groups = [
    ...(root.rows.length > 0 ? [root] : []),
    ...[...externalByKey.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "ko-KR", {
        numeric: true,
        sensitivity: "base",
      }),
    ),
  ];
  return Object.freeze(
    groups.map((group) => {
      const rows = Object.freeze(group.rows);
      return Object.freeze({
        id: group.id,
        kind: group.kind,
        name: group.name,
        rows,
        layerIndices: Object.freeze(rows.map(({ index }) => index)),
        searchText: searchKey(
          [group.name, ...rows.map(({ fullName }) => fullName)].join("\n"),
        ),
      });
    }),
  );
}

export function layerGroupVisibility(group, visibility) {
  if (
    !group ||
    !Array.isArray(group.layerIndices) ||
    !Array.isArray(visibility)
  ) {
    throw new TypeError("layer group visibility inputs are invalid");
  }
  let visible = 0;
  for (const index of group.layerIndices) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= visibility.length
    ) {
      throw new RangeError("layer group contains an invalid layer index");
    }
    if (visibility[index]) {
      visible += 1;
    }
  }
  return Object.freeze({
    checked: group.layerIndices.length > 0 && visible === group.layerIndices.length,
    indeterminate: visible > 0 && visible < group.layerIndices.length,
    total: group.layerIndices.length,
    visible,
  });
}

export function setLayerGroupVisibility(visibility, group, visible) {
  if (!Array.isArray(visibility)) {
    throw new TypeError("layer visibility must be an array");
  }
  const next = visibility.map(Boolean);
  layerGroupVisibility(group, next);
  for (const index of group.layerIndices) {
    next[index] = Boolean(visible);
  }
  return next;
}

export function isolateLayerGroup(visibility, group) {
  if (!Array.isArray(visibility)) {
    throw new TypeError("layer visibility must be an array");
  }
  layerGroupVisibility(group, visibility);
  const selected = new Set(group.layerIndices);
  return visibility.map((_visible, index) => selected.has(index));
}
