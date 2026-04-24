import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function collectTestFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

const requestedFiles = process.argv.slice(2);
const files =
  requestedFiles.length > 0
    ? requestedFiles.map((filePath) => path.resolve(filePath))
    : await collectTestFiles(path.resolve(".test-dist/tests"));

for (const filePath of files) {
  await import(pathToFileURL(filePath).href);
}
