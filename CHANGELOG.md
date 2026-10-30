# Changelog

## 0.1.0 (2026-10-26)

- Initial release.
- CLI: `pdfport extract-text`, `get-metadata` and `get-pdf-info`
  report on one file; `pdfport merge <output> <inputs...>` merges
  files in order; `pdfport split <file> <output-dir>` writes one
  file per page; `pdfport mcp` starts the stdio MCP server.
- MCP server with five tools: `extract_text`, `get_metadata`,
  `get_pdf_info`, `merge_pdfs`, `split_pdf`.
- Pure TypeScript PDF engine with no PDF library dependency:
  indirect-object scanning, Catalog/Pages traversal, plain and
  FlateDecode content-stream decoding, text recovery from Tj/TJ/'/"
  operators with literal-string escapes and hex strings, Info
  dictionary metadata, and merge/split by object renumbering with a
  rebuilt cross-reference table.
- Supported subset is deliberately narrow — flat page trees,
  uncompressed or FlateDecode streams, no encryption or object
  streams — and documented in the README.
