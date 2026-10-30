# pdfport

pdfport does the five PDF jobs that come up over and over: pull the
text out of a file, read its document metadata, summarise it (pages,
page sizes, file size, PDF version), merge several files into one,
and split a file into one document per page. It works on local files
only — nothing is uploaded anywhere.

The engine is a small, genuine PDF implementation written in pure
TypeScript for this project. No PDF library is bundled and there are
no runtime dependencies beyond the MCP SDK. The engine scans a
document's indirect objects, follows the Catalog to its Pages tree,
decodes plain and FlateDecode content streams, and recovers text
from the standard text-showing operators. Merges renumber the source
objects into one new object graph with a rebuilt page tree; splits
emit one document per page the same way; both write a freshly
computed cross-reference table.

## Scope — what the engine does and does not handle

Supported: simple PDFs with a flat page tree (a Catalog whose Pages
node lists Page objects directly — the shape common generators
produce, and the shape pdfport's own merge/split write), uncompressed
or FlateDecode streams, literal and hex strings in content and in the
Info dictionary, and per-page MediaBox sizes (inherited from the
Pages node when a page omits its own).

Not supported: encrypted files, object streams and compressed
cross-reference streams (PDF 1.5+ compact files), nested page trees,
embedded-font encodings that need a ToUnicode map to read, and
form/annotation fidelity on merge or split. Files outside the subset
fail with a plain error saying what was not found — pdfport never
returns invented text or metadata.

## Install

```bash
npx @reneturcios/pdfport get-pdf-info ./report.pdf
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/pdfport
```

The container defaults to the MCP server (see below). Pass CLI
arguments to use it as a CLI instead.

## CLI

```bash
# Print the document's text
pdfport extract-text ./report.pdf

# Print the Info-dictionary metadata (plus page count) as JSON
pdfport get-metadata ./report.pdf

# Print page count, page sizes, file size and PDF version as JSON
pdfport get-pdf-info ./report.pdf

# Merge inputs, in order, into one output file
pdfport merge ./combined.pdf ./a.pdf ./b.pdf ./c.pdf

# Split into <name>-page-1.pdf, <name>-page-2.pdf, ... in a directory
pdfport split ./report.pdf ./report-pages

# Start the MCP server
pdfport mcp

pdfport --version
```

Exit codes: `0` on success, `1` when a file is missing or a document
cannot be processed (the error says which), `2` for usage errors.

## MCP server

One bin serves both faces. The `mcp` subcommand starts a stdio MCP
server:

```bash
npx -y @reneturcios/pdfport mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "pdfport": {
      "command": "npx",
      "args": ["-y", "@reneturcios/pdfport", "mcp"]
    }
  }
}
```

### Tools

| Tool | Input | What it returns |
| --- | --- | --- |
| `extract_text` | `file_path` (string, required) | The file's text: every page's shown text, pages joined with a newline. |
| `get_metadata` | `file_path` (string, required) | The Info dictionary's title, author, subject, keywords, creator, producer and dates (only the fields the document carries), plus the page count. |
| `get_pdf_info` | `file_path` (string, required) | Page count, each page's MediaBox size in points, the file size in bytes, and the PDF version from the header. |
| `merge_pdfs` | `input_files` (array of strings, required), `output_file` (string, required) | Writes the merged document and reports the output path and total page count. The first input's metadata is kept. |
| `split_pdf` | `file_path` (string, required), `output_dir` (string, required) | Writes one single-page file per page into the directory and reports the created file paths and page count. |

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, no network
npm run dev     # run the CLI from source via tsx
```

The test suite builds small PDFs from raw strings — plain and
FlateDecode content streams — and drives the default engine
end-to-end: extraction (including TJ arrays and literal-string
escapes), metadata, info, merge and split are all asserted against
the real implementation, then the file facade is exercised against
real files in a temporary directory.

## License

MIT — see `LICENSE`.
