# writing-scaffold

A TypeScript MCP server with a frozen library of writing scaffolds, tools for
browsing and retrieving complete examples, and a provider-backed rewriting tool.
Supports stdio, Streamable HTTP, a local browser interface, and a standalone executable.

## Build and run

Requires Node.js 22 or newer and npm. From this directory:

```sh
npm ci
npm run build
node dist/index.js
```

Stdio is the default; launch Node directly when configuring an MCP client.
Generate a client configuration with `npm run --silent config`.

For HTTP, run `node dist/index.js --transport http --port 3000`.
The MCP endpoint is `http://127.0.0.1:3000/mcp`; the browser interface is `/app`.
The default bind address is loopback. Remote hosting requires an authenticated
HTTPS reverse proxy; the server has no built-in authentication or TLS.

## Portable executable

```sh
npm run bundle
./dist/writing-scaffold.mjs --transport http --port 3000
```

The executable embeds dependencies, the tokenizer, all included data, the editable
prompt and the browser interface. Copy that one file to any machine with Node.js 22+;
no adjacent files or npm install are needed to run it. Omit `--transport http` for stdio.

## Tools and credentials

- `write_with_scaffold`: create a writing prompt from an objective and topic.
- `list_scaffolds`: browse paginated previews; filter by source and NSFW status.
- `get_scaffold`: retrieve complete text using its stable sequential ID or canonical ID.
- `detemplatize`: rewrite supplied text against a scaffold using ACS and TypeSafe.
- `list_references`: list enabled external references (currently none).

Browsing and retrieval are offline and need no credentials. Rewriting requires
`ACS_API_KEY` and `TYPESAFE_API_KEY` in the server environment and makes paid
provider requests. Edit `prompts/detemplatize-jev.txt` to change rewriting guidance;
the ordinary build reloads it per call. Rebuild the portable executable to embed edits.
Inspect rewritten text: independent substitutions can introduce wording or grammar errors.

## Included data

The 15 committed JSONL files contain the exact data loaded by the current MCP,
about 98.5 MB total. Full record fields, original texts, stable IDs, attribution,
rights statements and embedded provenance are preserved. Collections include
CopypastaText, Gutenberg letters, Wikisource, Queneau, snowclones, SEC S-1 summaries,
Halimede, RFCs, press releases, Common Sense, ISO/IEC texts, NTSB summaries,
eLife reviews/responses, Spoon River Anthology, Fantastic Fables and LessWrong.
Some source IDs are registered for optional collections whose data is not included;
they contain no entries in this snapshot.

Original rights remain with each source's rights holders. Public availability
does not imply an open license. The Queneau excerpts derive from a user-supplied
copyrighted book; this repository does not grant permission to redistribute it.
Source-specific rights and review scope are recorded in the JSONL records.

This is the buildable MCP distribution. Raw downloads, PDFs/EPUBs, SQLite/text
alternative exports, acquisition scripts, provider caches, experiments, historical
snapshots and workspace logs are excluded from Git. In the original workspace
they remain on disk. Some provenance paths refer to those external archives.
Generated `dist/`, `node_modules/`, local credentials and host configuration are untracked.

## Verification

```sh
npm run check
npm test
```

The committed tests run without acquisition archives or paid provider calls.
They cover core behavior, filtering, pruning, rewriting with provider substitutes,
full original-corpus retrieval over stdio, HTTP, the browser adapter and the
standalone executable from an isolated directory. Historical acquisition audits
are outside this minimal distribution.

## Public Cloudflare deployment

`npm run build` also builds the public Worker at `dist/cloudflare/worker.mjs`
and splits the frozen library into private-bound assets. `npm run deploy` (or
`npx wrangler deploy`) uses `wrangler.jsonc`, so the existing Cloudflare build
commands `npm run build` and `npx wrangler deploy` work without dashboard changes.
The public Streamable HTTP endpoint is
`https://writing-scaffold.wafer4590.workers.dev/mcp`.

The public Worker exposes only `write_with_scaffold`, `list_scaffolds`,
`get_scaffold`, and `list_references`, plus the read-only MCP resources.
Its dependency graph excludes `detemplatize`, provider credentials, the rewrite
page, and the rewrite HTTP endpoint. The local Node server retains rewriting.

Every request reaching the Worker is saved as one JSON object in the private R2
bucket `writing-scaffold-requests`, under `YYYY-MM-DD/<timestamp>-<uuid>.json`.
Logs include the method, URL, headers, request body, response status and duration.
Authorization/cookie/credential headers and sensitive query parameters are
redacted; request bodies may contain user-submitted content. Bodies up to 1 MiB
are accepted in full. Larger requests are rejected with 413 and logged with a
truncated 1 MiB prefix. Logs are retained with no automatic expiration, and are
not exposed by any public route. A storage failure returns 503 instead of
acknowledging an unlogged request. Cloudflare-rejected traffic that never reaches
the Worker cannot be recorded by application code.

Create the log bucket once before the first deployment, if it does not exist:

```sh
npx wrangler r2 bucket create writing-scaffold-requests
npm run build
npm run deploy
```

`npm test` includes the actual Workers runtime with local assets and R2, checking
both supported MCP protocol generations, scaffold retrieval, rejected rewrite
calls, hidden asset routes, and persistent request logs.

### Public setup page

Open `https://writing-scaffold.wafer4590.workers.dev/mcp` in a browser for
Pi, Claude, and Codex installation instructions. Each agent has separate CLI
and GUI buttons, with copyable commands or connection details. Pi's GUI option
uses an editor for `~/.pi/agent/mcp.json` and its in-session `/mcp` panel.
The root URL shows the same page. Browser and plain GET/HEAD requests receive
HTML; explicit MCP protocol headers or an event-stream request continue to the
MCP handler, so existing client connections keep working. These requests use the
same persistent R2 logging as all other public requests.

### Hosted benchmark snapshot

The public "More information" link opens `/pangram-miss-benchmark.html` on the
same deployment. It serves the static copy in `web/pangram-miss-benchmark.html`,
with request logging enabled. The snapshot was copied on 2026-11-16 from
[AI Detection Eval](https://github.com/ampdot-io/ai-detection-eval/blob/main/release/pangram-miss-benchmark.html)
and is not automatically synchronized. The data, figures, and model views come from GitHub; the report copy has been revised locally.
its selected default is Gemini 4 Argon high (100 prompts). Other generator views
remain selectable. Its SHA-256 is
`a14c8019f3368afc9a8ca8fdbb53a60e59d4bd602032b55425419de0679d1fc4`.

### Private live topic viewer

Run `npm run logs:viewer` and open `http://127.0.0.1:54101`. Sign in with
`npx wrangler login` first if necessary. The viewer reads the private production
R2 bucket through your Cloudflare account. It shows the exact topic and objective
of every `write_with_scaffold` call, including repeats and tests, newest first.
Search, pause the display, or export the full loaded history as JSON.

The initial scan loads history; subsequent checks run every five seconds and
stream new cards into the browser. A five-minute overlap catches delayed log
writes. Failed reads are retried before advancing the checkpoint. A local cache
in `.local/topic-viewer/` avoids downloading old records again and contains only
object keys and displayed fields. No logs or credentials are included in Git or
served by the public Worker. The viewer binds only to this computer and rejects
foreign hosts and cross-site requests.

Optional environment variables: `WRITING_LOG_PORT`, `WRITING_LOG_CACHE`, and
`WRITING_LOG_SEED` (a private prior audit snapshot containing `{records:[{key,record}]}`).
Keep the viewer process running while viewing it. Stop it with Ctrl-C.
