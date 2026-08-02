const DEFAULT_MAXIMUM_CODE_POINTS = 4_096;
const MAXIMUM_INPUT_UNITS = 65_536;
const MAXIMUM_FORMAT_DEPTH = 32;
const MAXIMUM_FONT_NAME_LENGTH = 128;
const MAXIMUM_COMMAND_PAYLOAD_UNITS = 512;
const MINIMUM_SCALE = 0.01;
const MAXIMUM_SCALE = 100;

export const DEFAULT_MTEXT_FORMAT = Object.freeze({
  heightScale: 1,
  widthScale: 1,
  tracking: 1,
  obliqueAngle: 0,
  color: null,
  fontFile: "",
  bold: null,
  italic: null,
  underline: false,
  overline: false,
  strikeThrough: false,
  verticalAlignment: 1,
});

function replacePercentCodes(value) {
  return value
    .replace(/%%d/gi, "°")
    .replace(/%%p/gi, "±")
    .replace(/%%c/gi, "⌀");
}

function changedFormat(format, change) {
  return Object.freeze({ ...format, ...change });
}

function appendRun(line, text, format) {
  if (!text) {
    return;
  }
  const normalized = replacePercentCodes(text);
  if (!normalized) {
    return;
  }
  const previous = line.at(-1);
  if (previous?.format === format) {
    previous.text += normalized;
    return;
  }
  line.push({ text: normalized, format });
}

function frozenLine(line) {
  return Object.freeze(
    line
      .filter((run) => run.text.length > 0)
      .map((run) =>
        Object.freeze({
          text: run.text,
          format: run.format,
        }),
      ),
  );
}

function parseBoundedNumber(value) {
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim())
  ) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boundedScale(value) {
  return Math.max(MINIMUM_SCALE, Math.min(MAXIMUM_SCALE, value));
}

function commandTerminator(value, payloadStart) {
  const maximum = Math.min(
    value.length,
    payloadStart + MAXIMUM_COMMAND_PAYLOAD_UNITS + 1,
  );
  const semicolon = value.indexOf(";", payloadStart);
  return semicolon >= 0 && semicolon < maximum ? semicolon : -1;
}

function parseFontFormat(payload, format) {
  const parts = payload.split("|");
  const fontFile = parts.shift()?.trim().slice(0, MAXIMUM_FONT_NAME_LENGTH);
  if (!fontFile) {
    return format;
  }
  let bold = null;
  let italic = null;
  for (const part of parts) {
    const match = /^([bi])([01])$/iu.exec(part.trim());
    if (!match) {
      continue;
    }
    if (match[1].toLocaleLowerCase("en-US") === "b") {
      bold = match[2] === "1";
    } else {
      italic = match[2] === "1";
    }
  }
  return changedFormat(format, {
    fontFile,
    bold,
    italic,
  });
}

function encodedAciColor(value) {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 256) {
    return undefined;
  }
  if (parsed === 256) {
    return 0;
  }
  if (parsed === 0) {
    return 1 << 30;
  }
  return ((2 << 30) | parsed) >>> 0;
}

function applySemicolonCommand(
  command,
  payload,
  format,
  baseHeight,
) {
  if (command === "F" || command === "f") {
    return parseFontFormat(payload, format);
  }
  if (command === "C") {
    const color = encodedAciColor(payload);
    return color === undefined
      ? format
      : changedFormat(format, { color });
  }
  if (command === "H" || command === "h") {
    const relative = /x$/iu.test(payload.trim());
    const number = parseBoundedNumber(
      relative ? payload.trim().slice(0, -1) : payload,
    );
    if (number === undefined || number <= 0) {
      return format;
    }
    return changedFormat(format, {
      heightScale: boundedScale(
        relative ? number : number / baseHeight,
      ),
    });
  }
  if (command === "W" || command === "w") {
    const number = parseBoundedNumber(payload);
    return number === undefined || number <= 0
      ? format
      : changedFormat(format, {
          widthScale: boundedScale(number),
        });
  }
  if (command === "T" || command === "t") {
    const number = parseBoundedNumber(payload);
    return number === undefined || number <= 0
      ? format
      : changedFormat(format, {
          tracking: boundedScale(number),
        });
  }
  if (command === "Q" || command === "q") {
    const number = parseBoundedNumber(payload);
    return number === undefined
      ? format
      : changedFormat(format, {
          obliqueAngle:
            (Math.max(-85, Math.min(85, number)) * Math.PI) / 180,
        });
  }
  if (command === "A" || command === "a") {
    const number = Number(payload.trim());
    return Number.isInteger(number) && number >= 0 && number <= 2
      ? changedFormat(format, { verticalAlignment: number })
      : format;
  }
  return format;
}

export function parseCadMTextRuns(
  value,
  {
    baseHeight = 1,
    maximumCodePoints = DEFAULT_MAXIMUM_CODE_POINTS,
  } = {},
) {
  const safeBaseHeight =
    Number.isFinite(baseHeight) && baseHeight > 0 ? baseHeight : 1;
  const limit =
    Number.isInteger(maximumCodePoints) && maximumCodePoints > 0
      ? Math.min(maximumCodePoints, DEFAULT_MAXIMUM_CODE_POINTS)
      : DEFAULT_MAXIMUM_CODE_POINTS;
  if (typeof value !== "string" || value.length === 0) {
    return Object.freeze([Object.freeze([])]);
  }

  const lines = [[]];
  let format = DEFAULT_MTEXT_FORMAT;
  const formatStack = [];
  let ignoredFormatDepth = 0;
  let ignoredFormatBase = DEFAULT_MTEXT_FORMAT;
  let codePoints = 0;
  const append = (text) => {
    if (codePoints >= limit || !text) {
      return;
    }
    const characters = [...text].slice(0, limit - codePoints);
    appendRun(lines.at(-1), characters.join(""), format);
    codePoints += characters.length;
  };
  const paragraph = () => {
    if (lines.length < limit) {
      lines.push([]);
    }
  };

  for (
    let index = 0;
    index < Math.min(value.length, MAXIMUM_INPUT_UNITS) &&
    codePoints < limit;

  ) {
    const character = value[index];
    if (character === "{") {
      if (formatStack.length < MAXIMUM_FORMAT_DEPTH) {
        formatStack.push(format);
      } else {
        if (ignoredFormatDepth === 0) {
          ignoredFormatBase = format;
        }
        ignoredFormatDepth += 1;
      }
      index += 1;
      continue;
    }
    if (character === "}") {
      if (ignoredFormatDepth > 0) {
        ignoredFormatDepth -= 1;
        if (ignoredFormatDepth === 0) {
          format = ignoredFormatBase;
        }
      } else if (formatStack.length > 0) {
        format = formatStack.pop();
      }
      index += 1;
      continue;
    }
    if (character !== "\\") {
      const percentCode = value.slice(index, index + 3);
      if (/^%%[dpc]$/iu.test(percentCode)) {
        append(replacePercentCodes(percentCode));
        index += 3;
        continue;
      }
      const codePoint = value.codePointAt(index);
      append(String.fromCodePoint(codePoint));
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }

    const command = value[index + 1] ?? "";
    if (command === "P") {
      paragraph();
      index += 2;
      continue;
    }
    if (command === "~") {
      append(" ");
      index += 2;
      continue;
    }
    if (command === "\\" || command === "{" || command === "}") {
      append(command);
      index += 2;
      continue;
    }
    if (
      (command === "U" || command === "u") &&
      value[index + 2] === "+" &&
      /^[0-9a-f]{4}$/iu.test(value.slice(index + 3, index + 7))
    ) {
      append(
        String.fromCodePoint(
          Number.parseInt(value.slice(index + 3, index + 7), 16),
        ),
      );
      index += 7;
      continue;
    }
    if ("LlOoKk".includes(command)) {
      const key =
        command === "L" || command === "l"
          ? "underline"
          : command === "O" || command === "o"
            ? "overline"
            : "strikeThrough";
      format = changedFormat(format, {
        [key]: command === command.toLocaleUpperCase("en-US"),
      });
      index += 2;
      continue;
    }

    const semicolon = commandTerminator(value, index + 2);
    if (command === "p") {
      if (semicolon === -1) {
        paragraph();
        index += 2;
      } else {
        index = semicolon + 1;
      }
      continue;
    }
    if (semicolon !== -1) {
      const payload = value.slice(index + 2, semicolon);
      if (command === "S" || command === "s") {
        append(payload.replaceAll("^", "/").replaceAll("#", "/"));
      } else {
        format = applySemicolonCommand(
          command,
          payload,
          format,
          safeBaseHeight,
        );
      }
      index = semicolon + 1;
      continue;
    }
    append(command || "\\");
    index += command ? 2 : 1;
  }

  return Object.freeze(lines.map(frozenLine));
}

export function plainCadMTextLines(value, options) {
  return Object.freeze(
    parseCadMTextRuns(value, options).map((line) =>
      line.map((run) => run.text).join(""),
    ),
  );
}

function isWhitespace(character) {
  return /^\s$/u.test(character);
}

function appendRichCharacter(line, character, format) {
  const previous = line.at(-1);
  if (previous?.format === format) {
    previous.text += character;
  } else {
    line.push({ text: character, format });
  }
}

function freezeRichLines(lines) {
  return Object.freeze(lines.map(frozenLine));
}

export function wrapCadMTextRuns(
  lines,
  maximumAdvance,
  measureAdvance = () => 1,
) {
  if (!Array.isArray(lines)) {
    throw new TypeError("CAD rich text lines must be an array");
  }
  if (
    !Number.isFinite(maximumAdvance) ||
    maximumAdvance <= 0 ||
    typeof measureAdvance !== "function"
  ) {
    return Object.freeze([...lines]);
  }
  const measured = (character, format) => {
    const advance = measureAdvance(character, format);
    return Number.isFinite(advance) && advance > 0 ? advance : 1;
  };
  const wrapped = [];

  for (const source of lines) {
    const firstWrappedLine = wrapped.length;
    const characters = [];
    const formats = [];
    for (const run of source) {
      for (const character of run.text) {
        characters.push(character);
        formats.push(run.format);
      }
    }
    if (characters.length === 0) {
      wrapped.push([]);
      continue;
    }

    let current = [];
    let currentAdvance = 0;
    let pendingWhitespace = [];
    let pendingWhitespaceAdvance = 0;
    const flush = () => {
      if (current.length > 0) {
        wrapped.push(current);
      }
      current = [];
      currentAdvance = 0;
      pendingWhitespace = [];
      pendingWhitespaceAdvance = 0;
    };
    const appendPendingWhitespace = () => {
      for (const entry of pendingWhitespace) {
        appendRichCharacter(current, entry.character, entry.format);
      }
      currentAdvance += pendingWhitespaceAdvance;
      pendingWhitespace = [];
      pendingWhitespaceAdvance = 0;
    };

    for (let index = 0; index < characters.length; ) {
      if (isWhitespace(characters[index])) {
        if (current.length > 0) {
          while (
            index < characters.length &&
            isWhitespace(characters[index])
          ) {
            pendingWhitespace.push({
              character: characters[index],
              format: formats[index],
            });
            pendingWhitespaceAdvance += measured(
              characters[index],
              formats[index],
            );
            index += 1;
          }
        } else {
          index += 1;
        }
        continue;
      }

      const tokenStart = index;
      let tokenAdvance = 0;
      while (
        index < characters.length &&
        !isWhitespace(characters[index])
      ) {
        tokenAdvance += measured(characters[index], formats[index]);
        index += 1;
      }
      if (
        current.length > 0 &&
        currentAdvance + pendingWhitespaceAdvance + tokenAdvance <=
          maximumAdvance
      ) {
        appendPendingWhitespace();
      } else if (current.length > 0) {
        flush();
      }
      if (tokenAdvance <= maximumAdvance) {
        for (
          let characterIndex = tokenStart;
          characterIndex < index;
          characterIndex += 1
        ) {
          appendRichCharacter(
            current,
            characters[characterIndex],
            formats[characterIndex],
          );
        }
        currentAdvance += tokenAdvance;
        continue;
      }
      for (
        let characterIndex = tokenStart;
        characterIndex < index;
        characterIndex += 1
      ) {
        const advance = measured(
          characters[characterIndex],
          formats[characterIndex],
        );
        if (
          current.length > 0 &&
          currentAdvance + advance > maximumAdvance
        ) {
          flush();
        }
        appendRichCharacter(
          current,
          characters[characterIndex],
          formats[characterIndex],
        );
        currentAdvance += advance;
      }
    }
    flush();
    if (wrapped.length === firstWrappedLine) {
      wrapped.push([]);
    }
  }
  return freezeRichLines(wrapped);
}

export function measureCadMTextLine(
  line,
  measureAdvance = () => 1,
) {
  let total = 0;
  for (const run of line) {
    for (const character of run.text) {
      const advance = measureAdvance(character, run.format);
      total += Number.isFinite(advance) && advance > 0 ? advance : 1;
    }
  }
  return total;
}
