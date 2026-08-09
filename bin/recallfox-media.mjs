#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PRODUCTION_UPLOAD_URL = "https://app.recallfox.com/api/v1/media/local-uploads";
const TOOL_VERSION = "0.1.0";

const fail = (message) => {
  throw new Error(message);
};

export const resolveUploadUrl = (environment = process.env) => {
  const configured = environment.RECALLFOX_MEDIA_UPLOAD_URL;
  if (!configured) return PRODUCTION_UPLOAD_URL;
  const parsed = new URL(configured);
  const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    environment.RECALLFOX_MEDIA_ALLOW_LOCAL !== "true" ||
    !localHost ||
    parsed.protocol !== "http:"
  ) {
    fail("A custom upload URL is allowed only for explicit localhost development");
  }
  return parsed.toString();
};

const resolveSafeFile = async (filePath) => {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    fail("path must name one local image file");
  }
  const requested = resolve(filePath);
  const linkInfo = await lstat(requested);
  if (linkInfo.isSymbolicLink()) fail("symbolic-link uploads are not allowed");
  const canonicalPath = await realpath(requested);
  const fileInfo = await stat(canonicalPath);
  if (!fileInfo.isFile()) fail("path must name a regular file");
  if (fileInfo.size < 1) fail("image file is empty");
  if (fileInfo.size > MAX_IMAGE_BYTES) fail(`image file exceeds ${MAX_IMAGE_BYTES} bytes`);
  return { canonicalPath, fileInfo };
};

const sha256File = async (canonicalPath) => {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(canonicalPath)) digest.update(chunk);
  return digest.digest("hex");
};

const assertSupportedImageSignature = async (canonicalPath) => {
  const handle = await open(canonicalPath, "r");
  try {
    const signature = Buffer.alloc(12);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const png = bytesRead >= 8 && signature.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const jpeg = bytesRead >= 3 && signature.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
    const gif = bytesRead >= 6 && ["GIF87a", "GIF89a"].includes(signature.subarray(0, 6).toString("ascii"));
    const webp =
      bytesRead >= 12 &&
      signature.subarray(0, 4).toString("ascii") === "RIFF" &&
      signature.subarray(8, 12).toString("ascii") === "WEBP";
    if (!png && !jpeg && !gif && !webp) {
      fail("file does not have a supported PNG, JPEG, GIF, or WebP signature");
    }
  } finally {
    await handle.close();
  }
};

export const inspectLocalImage = async (filePath) => {
  const { canonicalPath, fileInfo } = await resolveSafeFile(filePath);
  await assertSupportedImageSignature(canonicalPath);
  return {
    path: canonicalPath,
    filename: basename(canonicalPath),
    size_bytes: fileInfo.size,
    sha256: await sha256File(canonicalPath),
  };
};

export const uploadLocalImage = async (
  filePath,
  uploadToken,
  environment = process.env,
) => {
  if (typeof uploadToken !== "string" || !uploadToken.startsWith("rf_upload_")) {
    fail("upload_token is not a RecallFox local upload token");
  }
  const inspected = await inspectLocalImage(filePath);
  const content = await readFile(inspected.path);
  const form = new FormData();
  form.append("file", new Blob([content]), inspected.filename);
  const response = await fetch(resolveUploadUrl(environment), {
    method: "POST",
    headers: { Authorization: `Bearer ${uploadToken}` },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data) {
    const reason = payload?.error?.message || `RecallFox upload failed with HTTP ${response.status}`;
    fail(reason);
  }
  return payload.data;
};

const toolDefinitions = [
  {
    name: "inspect_local_image",
    description:
      "Read metadata and SHA-256 for one explicitly selected local image before requesting a temporary RecallFox upload token.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute or working-directory-relative file path" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      title: "Inspect local image",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "upload_local_image",
    description:
      "Upload the previously inspected local image with a five-minute, one-use token from the remote RecallFox MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        upload_token: { type: "string" },
      },
      required: ["path", "upload_token"],
      additionalProperties: false,
    },
    annotations: {
      title: "Upload local image",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

const toolResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const callTool = async (name, args) => {
  if (name === "inspect_local_image") return toolResult(await inspectLocalImage(args?.path));
  if (name === "upload_local_image") {
    return toolResult(await uploadLocalImage(args?.path, args?.upload_token));
  }
  fail(`Unknown tool: ${name}`);
};

const handleMcpRequest = async (request) => {
  if (request.method === "initialize") {
    return {
      protocolVersion: request.params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "recallfox-media", version: TOOL_VERSION },
    };
  }
  if (request.method === "tools/list") return { tools: toolDefinitions };
  if (request.method === "tools/call") {
    try {
      return await callTool(request.params?.name, request.params?.arguments);
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : "Local upload failed" }],
        isError: true,
      };
    }
  }
  fail(`Unsupported MCP method: ${request.method}`);
};

export const runMcpServer = async () => {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (request.method?.startsWith("notifications/")) continue;
      const result = await handleMcpRequest(request);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
        })}\n`,
      );
    }
  }
};

const option = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "inspect") {
    process.stdout.write(`${JSON.stringify(await inspectLocalImage(args[0]))}\n`);
    return;
  }
  if (command === "upload") {
    const result = await uploadLocalImage(args[0], option(args, "--ticket"));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "mcp") {
    await runMcpServer();
    return;
  }
  fail("Usage: recallfox-media inspect <path> | upload <path> --ticket <token> | mcp");
};

const invokedPath = process.argv[1] ? await realpath(process.argv[1]) : undefined;

if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "RecallFox media helper failed"}\n`);
    process.exitCode = 1;
  });
}
