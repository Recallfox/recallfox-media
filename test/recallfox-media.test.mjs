import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  inspectLocalImage,
  resolveUploadUrl,
  uploadLocalImage,
} from "../bin/recallfox-media.mjs";

const imageBytes = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("example-image"),
]);

test("inspect returns exact local byte facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recallfox-media-"));
  const imagePath = join(directory, "map.png");
  await writeFile(imagePath, imageBytes);

  const result = await inspectLocalImage(imagePath);

  assert.equal(result.filename, "map.png");
  assert.equal(result.size_bytes, imageBytes.length);
  assert.equal(result.sha256, createHash("sha256").update(imageBytes).digest("hex"));
});

test("custom destinations are limited to explicit localhost development", () => {
  assert.throws(
    () => resolveUploadUrl({ RECALLFOX_MEDIA_UPLOAD_URL: "https://evil.example/upload" }),
    /only for explicit localhost/,
  );
  assert.equal(
    resolveUploadUrl({
      RECALLFOX_MEDIA_UPLOAD_URL: "http://127.0.0.1:8101/api/v1/media/local-uploads",
      RECALLFOX_MEDIA_ALLOW_LOCAL: "true",
    }),
    "http://127.0.0.1:8101/api/v1/media/local-uploads",
  );
});

test("upload sends the ticket only to the allowed local test endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recallfox-media-"));
  const imagePath = join(directory, "map.png");
  await writeFile(imagePath, imageBytes);
  let authorization;
  let requestBody = "";
  const server = createServer((request, response) => {
    authorization = request.headers.authorization;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ data: { id: "asset-1", filename: "map.png" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    const result = await uploadLocalImage(imagePath, "rf_upload_test-secret", {
      RECALLFOX_MEDIA_UPLOAD_URL: `http://127.0.0.1:${address.port}/api/v1/media/local-uploads`,
      RECALLFOX_MEDIA_ALLOW_LOCAL: "true",
    });
    assert.equal(result.id, "asset-1");
    assert.equal(authorization, "Bearer rf_upload_test-secret");
    assert.match(requestBody, /filename="map.png"/);
  } finally {
    server.close();
  }
});

test("inspect rejects a non-image before upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recallfox-media-"));
  const filePath = join(directory, "secret.txt");
  await writeFile(filePath, Buffer.from("not an image"));

  await assert.rejects(inspectLocalImage(filePath), /supported PNG, JPEG, GIF, or WebP/);
});

test("MCP lists the local image tools and their safety annotations", async () => {
  const executable = fileURLToPath(new URL("../bin/recallfox-media.mjs", import.meta.url));
  const child = spawn(process.execPath, [executable, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, stderr);
  const response = JSON.parse(stdout.trim());
  assert.equal(response.result.tools.length, 2);
  assert.equal(response.result.tools[0].name, "inspect_local_image");
  assert.equal(response.result.tools[0].annotations.readOnlyHint, true);
  assert.equal(response.result.tools[1].name, "upload_local_image");
  assert.equal(response.result.tools[1].annotations.openWorldHint, true);
});
