#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const projectId = process.env.STITCH_PROJECT_ID ?? "13838323995136021685";
const screenId =
  process.env.STITCH_SCREEN_ID ?? "5a3fb7e9228642a0a52a7f01b67283c6";
const outputBase =
  process.env.STITCH_OUTPUT_BASE ?? "stitch_exports/character-management";
const htmlUrl = process.env.STITCH_HTML_URL;
const imageUrl = process.env.STITCH_IMAGE_URL;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(root, `${outputBase}.html`);
const imagePath = resolve(root, `${outputBase}.png`);

function runCurl(url, outputPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("curl", ["-L", url, "-o", outputPath], {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`curl exited with status ${code}`));
    });
  });
}

if (!htmlUrl || !imageUrl) {
  console.error(
    [
      "Missing Stitch hosted download URLs.",
      `Project: ${projectId}`,
      `Screen: ${screenId}`,
      "Set STITCH_HTML_URL and STITCH_IMAGE_URL to the export URLs from Stitch, then rerun this script.",
    ].join("\n"),
  );
  process.exit(1);
}

await mkdir(dirname(htmlPath), { recursive: true });

await runCurl(htmlUrl, htmlPath);
await runCurl(imageUrl, imagePath);

console.log(`Downloaded HTML: ${htmlPath}`);
console.log(`Downloaded image: ${imagePath}`);
