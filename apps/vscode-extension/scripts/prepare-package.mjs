import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(extensionRoot, "..", "..");

await Promise.all([
  copyFile(
    path.join(repositoryRoot, "LICENSE"),
    path.join(extensionRoot, "LICENSE"),
  ),
  copyFile(
    path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"),
    path.join(extensionRoot, "THIRD_PARTY_NOTICES.md"),
  ),
]);
