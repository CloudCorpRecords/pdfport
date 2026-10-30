# pdfport — Build Report

MCP Rebuild 100. Clean-room build for the "pdf-tools" target, which
is a FILL-IN in TARGETS.json (`source_repo: null`): there is no
original server to probe, so the tool spec was defined for this
program from the common public PDF MCP tool pattern and is labelled
as such in the fixture itself. Local build only — nothing pushed
or published.

Identity: repo `pdfport`, npm `@reneturcios/pdfport`,
MCP name `io.github.CloudCorpRecords/pdfport`, version `0.1.0`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `pdfport: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Extract text and metadata from local
  PDFs, and merge or split PDF files." = **72 chars** (≤100 ✓); npm
  entry carries `version: 0.1.0`; OCI entry
  `ghcr.io/cloudcorprecords/pdfport:0.1.0` carries **no** `version`
  field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT `node /app/dist/cli.js`,
  CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/pdfport"`
- `tsconfig.json` (byte-identical to pgport's / shipcheck's),
  `.gitignore`, `LICENSE` (MIT, Copyright (c) 2026 Rene Turcios),
  `README.md` (fresh text), `CHANGELOG.md` (single 0.1.0 entry, 2026-10-26)
- `src/index.ts`, `src/cli.ts` (`mcp`, `extract-text`, `get-metadata`,
  `get-pdf-info`, `merge`, `split`, `--version`; exit 2 usage /
  1 file error), `src/mcp.ts`, `src/types.ts`, `src/pdf.ts`
  (core engine + facade, `VERSION = "0.1.0"`)
- `test/pdf.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (adapted from pgport; image name and smoke-test server name changed
  to pdfport)

## Implementation notes

- Five MCP tools, exactly as spec'd in the fixture:
  `extract_text`, `get_metadata`, `get_pdf_info` (each
  `{file_path: string}`, required), `merge_pdfs`
  (`{input_files: array<string>, output_file: string}`, both
  required), `split_pdf` (`{file_path, output_dir}`, both required).
  Descriptions match the fixture verbatim. The fixture's `_source`
  reads, in full: "fill-in spec defined for this program from the
  common public PDF MCP tool pattern; no original server probed".
- **Low-level Server API, with reason:** `src/mcp.ts` registers the
  tools via `Server` from `@modelcontextprotocol/sdk/server/index.js`
  with explicit inputSchema literals, not McpServer+zod — the
  high-level path injects `$schema` / `additionalProperties` and caps
  parity at 50% (standing rule from Wave 1). Zod still validates
  every `tools/call` argument set internally.
- **The engine is real.** `SimplePdfEngine` in `src/pdf.ts` is a
  genuine minimal PDF implementation in pure TypeScript with no new
  dependencies (only `node:zlib` for FlateDecode):
  - Parsing: the raw bytes are treated as latin1 (1 byte = 1 char,
    so offsets are byte offsets) and scanned for `N G obj ... endobj`
    blocks; the Catalog is followed to its Pages node and the Kids
    array gives the page order.
  - Text: each page's content stream(s) are decoded (plain, or
    inflated when the dictionary carries `/FlateDecode`) and scanned
    for the Tj / TJ / ' / " show operators; literal strings are
    decoded with the full escape rules (including octal and nested
    parentheses) and hex strings are supported. Text is grouped by
    show operation; pages are joined with a newline.
  - Metadata: the trailer's `/Info` reference (falling back to an
    object carrying `/Title`) is parsed for Title, Author, Subject,
    Keywords, Creator, Producer, CreationDate and ModDate, plus the
    Pages `/Count`.
  - Info: page count, per-page MediaBox sizes (a page's own box,
    else the Pages node's, else Letter), file size in bytes, and the
    `%PDF-x.y` header version.
  - Merge: every input's objects (minus its Catalog and Pages root)
    are renumbered into one graph, references are rewritten in
    dictionary portions only (stream bytes are copied verbatim), a
    new flat Pages node lists all pages in input order, the first
    input's Info object is kept, and a fresh xref table is computed.
  - Split: the same copy is emitted once per page with a
    single-entry Kids list and `/Count 1`, retaining the full
    object set (fonts, content streams, Info) in each output.
- The MCP/CLI layers sit on a file facade (`PdfPort`) behind the
  injectable `PdfEngine` interface, but — per the task requirement —
  the tests exercise the **default engine end-to-end**, not a fake:
  the test helper assembles small PDFs as raw strings (plain and
  `zlib`-deflated content streams, correct xref included) and every
  operation is asserted against the real implementation, then the
  facade is exercised against real files in a temp directory.

## Verification (exact outputs)

### 1. Build / type-check
```
$ ./node_modules/.bin/tsc --noEmit ; echo exit=$?
tsc (noEmit) exit=0
```
See the dist note under Blockers: in this VM the write guard EPERMs
`tsc`'s emitted files (they land as 0 bytes), so type-checking was
verified with `--noEmit` (exit 0) and `dist/*.js` was produced by
transpiling the same sources (esbuild transform, types stripped).
`dist/` contains cli.js (with `#!/usr/bin/env node` shebang),
pdf.js (17,472 bytes), mcp.js, index.js, types.js; `.d.ts` /
`.js.map` companions are absent (see gaps). The dist build is what
the smoke and parity runs below executed.

### 2. Tests
```
$ ./node_modules/.bin/tsx --test test/*.test.ts
ℹ tests 17
ℹ pass 17
ℹ fail 0
```
Against the default engine on generated documents: extraction joins
pages with a newline exactly; FlateDecode streams decode; TJ arrays
concatenate ignoring kerning numbers; literal-string escapes
(`\(`, `\)`, `\\`) decode; multi-line pages yield every shown
string; non-PDF bytes are rejected. Metadata reads Title / Author /
Creator / dates / page count and omits absent fields. Info reports
page count, both custom page sizes, exact file size and version
"1.4". Merge yields a 3-page document extracting all three pages in
order with the first document's metadata and page sizes intact, and
rejects an empty input list. Split yields per-page documents that
each extract only their own text at page count 1 with sizes and
metadata retained, and a merged document splits back into its
pages. The facade then repeats extract / metadata / info / merge /
split against real files, including the `PDF file not found` error.

### 3. MCP + CLI smoke (live, this VM, against dist/)
```
initialize -> serverInfo: {"name":"pdfport","version":"0.1.0"}
tools/list -> exactly the five spec tools with spec-identical schemas
tools/call get_pdf_info {"/tmp/.../alpha.pdf"} ->
  ok: pageCount 2, pageSizes [{612,792},{300,400}], fileSize 1066, pdfVersion "1.4"
tools/call extract_text {"/nonexistent/nope.pdf"} ->
  isError: "PDF file not found: /nonexistent/nope.pdf"
CLI: --version -> 0.1.0 (exit 0); no args -> Usage (exit 2)
CLI on a generated 2-page PDF: extract-text prints both pages'
  text; get-metadata prints Title "Alpha Doc", Author "Ada
  Lovelace", both dates, pageCount 2; merge with a second PDF ->
  page_count 3 and the merged file extracts all three pages;
  split -> alpha-page-1.pdf / alpha-page-2.pdf, and page 2's file
  extracts exactly "Alpha page two"
```

### 4. Parity (harness)
```
$ python3 ~/workspace/mcp-rebuild-100/harness/parity.py \
    --original ~/workspace/mcp-rebuild-100/harness/fixtures/pdf-tools-tools-original.json \
    --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/pdfport/dist/cli.js mcp" \
    --out ~/workspace/mcp-rebuild-100/builds/pdfport/parity-out
verdict=PASS parity_pct=100.0 original_tools=5 rebuild_tools=5 missing=[] extra=[] schema_diffs=[]
(exit 0)
```
`parity-out/parity.json` on disk confirms: verdict PASS,
parity_pct 100.0, identical_tools 5, schema_diffs {}.
`fixture_results: SKIPPED-TOOLS-FILE-MODE` — expected harness
semantics for a tools-file original, not an error.

## Lockfile status

`package-lock.json` was copied from pgport with identity fields
edited; clean lockfile regen required before publish. Edited fields
(verified on disk): top-level `name`, root package `name`, and root
package `bin` key pgport -> pdfport (dependencies are identical
ranges, so the tree is unchanged). Per the fleet lesson in
TEMPLATE.md §2 item 6, a lockfile must be generated clean (no
`node_modules` present) before first publish — **clean regeneration
is deferred to the publish wave**; do not publish from this lockfile
as-is. `node_modules` in this build dir is a `cp -a` copy of
pgport's (local build only, gitignored).

## Blockers / honest gaps

- **Engine subset limits, stated plainly:** the engine handles
  simple PDFs with a **flat page tree** (Catalog -> Pages -> Page
  objects directly), uncompressed or FlateDecode streams, and
  literal/hex strings. It does **not** handle encrypted files,
  object streams or compressed xref streams, **nested page trees**,
  content streams whose glyphs need a ToUnicode CMap to read, or
  form/annotation fidelity on merge/split. Text is grouped by show
  operation, not by visual line, and merge/split retain the source
  object set per output rather than garbage-collecting unreferenced
  objects. Files outside the subset fail with a plain error naming
  what was not found; nothing is invented. All behaviour claims
  above are proven only for the subset the tests generate.
- **No original exists to parity against:** pdf-tools is a fill-in
  (`source_repo: null`); the fixture is a program-defined spec, so
  parity (5/5, 100.0%) proves the rebuild matches the defined spec —
  there is no original-server behaviour to compare against, and
  none is claimed.
- **dist artefacts:** `dist/` was produced via transpile because
  the VM write guard EPERMs `tsc` emit in this environment (same
  guard family recorded in AGENTS.md); `.d.ts` and `.js.map`
  companions were not produced. The publish wave's clean
  `npm ci && npm run build` in CI regenerates the canonical dist.
- Container build not exercised locally (no Docker run in this
  wave); the publish-container workflow smoke-tests the image at
  publish time.
- mcpaudit / mcpvet / shipcheck pre-publish gate not run — that
  belongs to the publish wave, not claimed here.
