# RecallFox media helper

A small local MCP server and command-line helper for uploading an explicitly selected local image
to [RecallFox](https://recallfox.com).

The remote RecallFox MCP server creates a five-minute, one-use upload token. This helper reads the
selected file and sends it directly to RecallFox. Image bytes and account OAuth tokens do not enter
model context.

## Run from a GitHub Release

```bash
npx --yes \
  --package=https://github.com/Recallfox/recallfox-media/releases/download/v0.1.0/recallfox-media-0.1.0.tgz \
  recallfox-media inspect ./diagram.png
```

Run it as a local MCP server:

```json
{
  "mcpServers": {
    "recallfox-media": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=https://github.com/Recallfox/recallfox-media/releases/download/v0.1.0/recallfox-media-0.1.0.tgz",
        "recallfox-media",
        "mcp"
      ]
    }
  }
}
```

Node.js 22 or newer is required. Releases are built with the current Node.js 24 LTS line. The package has no runtime npm dependencies.

## Security boundary

- A file path must name a regular file of 10 MiB or less.
- Symbolic links are rejected.
- Upload tokens must use the `rf_upload_` namespace.
- Production uploads have one fixed destination:
  `https://app.recallfox.com/api/v1/media/local-uploads`.
- A custom destination is accepted only for explicit localhost development.
- RecallFox verifies the filename, original byte size, and SHA-256 when these values are bound to
  the temporary token.

Run tests with `npm test`. Create the release tarball with `npm pack`.
