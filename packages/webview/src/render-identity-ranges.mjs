const RENDER_IDENTITY_RANGE_WORDS = 4;

function u64Handle(value, label) {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > 0xffff_ffff_ffff_ffffn
  ) {
    throw new TypeError(`${label} requires a u64 handle`);
  }
  return value;
}

export function appendRenderIdentityRange(
  ranges,
  handle,
  firstVertex,
  vertexCount,
) {
  if (
    !Array.isArray(ranges) ||
    !Number.isSafeInteger(firstVertex) ||
    firstVertex < 0 ||
    !Number.isSafeInteger(vertexCount) ||
    vertexCount <= 0
  ) {
    throw new TypeError("render identity range is invalid");
  }
  const normalizedHandle = u64Handle(
    handle,
    "render identity range",
  );
  const previous = ranges.at(-1);
  const expectedFirst = previous
    ? previous.firstVertex + previous.vertexCount
    : 0;
  if (firstVertex !== expectedFirst) {
    throw new RangeError(
      "render identity ranges must be contiguous and ordered",
    );
  }
  if (previous?.handle === normalizedHandle) {
    previous.vertexCount += vertexCount;
    return previous;
  }
  const range = {
    firstVertex,
    vertexCount,
    handle: normalizedHandle,
  };
  ranges.push(range);
  return range;
}

export function packRenderIdentityRanges(
  ranges,
  vertexCount,
) {
  if (
    !Array.isArray(ranges) ||
    !Number.isSafeInteger(vertexCount) ||
    vertexCount < 0
  ) {
    throw new TypeError("render identity range packing is invalid");
  }
  const data = new Uint32Array(
    ranges.length * RENDER_IDENTITY_RANGE_WORDS,
  );
  let expectedFirst = 0;
  for (const [index, range] of ranges.entries()) {
    const handle = u64Handle(
      range?.handle,
      "render identity range",
    );
    if (
      range.firstVertex !== expectedFirst ||
      !Number.isSafeInteger(range.vertexCount) ||
      range.vertexCount <= 0 ||
      range.firstVertex > 0xffff_ffff ||
      range.vertexCount > 0xffff_ffff
    ) {
      throw new RangeError("render identity range packing is invalid");
    }
    const offset = index * RENDER_IDENTITY_RANGE_WORDS;
    data[offset] = range.firstVertex;
    data[offset + 1] = range.vertexCount;
    data[offset + 2] = Number(handle & 0xffff_ffffn);
    data[offset + 3] = Number(handle >> 32n);
    expectedFirst += range.vertexCount;
  }
  if (expectedFirst !== vertexCount) {
    throw new RangeError(
      "render identity ranges must cover every vertex",
    );
  }
  return Object.freeze({
    data,
    count: ranges.length,
  });
}

export function validateRenderIdentityRanges(
  value,
  {
    vertexCount,
    verticesPerPrimitive,
    label = "render identity ranges",
  },
) {
  if (
    !(value?.data instanceof Uint32Array) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    value.data.length !==
      value.count * RENDER_IDENTITY_RANGE_WORDS ||
    !Number.isSafeInteger(vertexCount) ||
    vertexCount < 0 ||
    !Number.isSafeInteger(verticesPerPrimitive) ||
    verticesPerPrimitive <= 0
  ) {
    throw new TypeError(`${label} are invalid`);
  }
  let expectedFirst = 0;
  for (let index = 0; index < value.count; index += 1) {
    const offset = index * RENDER_IDENTITY_RANGE_WORDS;
    const firstVertex = value.data[offset];
    const count = value.data[offset + 1];
    if (
      firstVertex !== expectedFirst ||
      count === 0 ||
      firstVertex % verticesPerPrimitive !== 0 ||
      count % verticesPerPrimitive !== 0 ||
      firstVertex + count > vertexCount
    ) {
      throw new RangeError(`${label} are not contiguous`);
    }
    expectedFirst += count;
  }
  if (expectedFirst !== vertexCount) {
    throw new RangeError(`${label} do not cover every vertex`);
  }
  return value;
}

export { RENDER_IDENTITY_RANGE_WORDS };
