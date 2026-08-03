import {
  RenderProtocolDiagnosticCode,
  RenderProtocolError,
} from "./diagnostics.mjs";
import { semanticVersionTuple } from "./validation.mjs";

function normalizeVersionSet(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.MESSAGE_INVALID,
      `${label} must be a non-empty bounded version array`,
    );
  }
  const versions = new Set();
  for (const version of value) {
    semanticVersionTuple(version, `${label} entry`);
    if (versions.has(version)) {
      throw new RenderProtocolError(
        RenderProtocolDiagnosticCode.MESSAGE_INVALID,
        `${label} must not contain duplicate versions`,
        { version },
      );
    }
    versions.add(version);
  }
  return versions;
}

function compareSemanticVersions(left, right) {
  const leftTuple = semanticVersionTuple(left, "left version");
  const rightTuple = semanticVersionTuple(right, "right version");
  for (let index = 0; index < 3; index += 1) {
    if (leftTuple[index] !== rightTuple[index]) {
      return leftTuple[index] - rightTuple[index];
    }
  }
  return 0;
}

export function negotiateRenderProtocolVersion(
  clientVersions,
  sourceVersions,
) {
  const client = normalizeVersionSet(clientVersions, "client versions");
  const source = normalizeVersionSet(sourceVersions, "source versions");
  const common = [...client].filter((version) => source.has(version));
  if (common.length === 0) {
    throw new RenderProtocolError(
      RenderProtocolDiagnosticCode.VERSION_INCOMPATIBLE,
      "Viewer Core and RenderSource do not share a render protocol version",
      {
        clientVersions: [...client].sort(compareSemanticVersions),
        sourceVersions: [...source].sort(compareSemanticVersions),
      },
    );
  }
  common.sort(compareSemanticVersions);
  return common.at(-1);
}
