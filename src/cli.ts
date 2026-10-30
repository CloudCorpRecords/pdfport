#!/usr/bin/env node
/**
 * pdfport CLI.
 *
 *   pdfport mcp
 *   pdfport extract-text <file>
 *   pdfport get-metadata <file>
 *   pdfport get-pdf-info <file>
 *   pdfport merge <output-file> <input-file...>
 *   pdfport split <file> <output-dir>
 *   pdfport --version
 *
 * Exit codes: 0 success, 1 file/PDF error, 2 usage error.
 */
import { PdfPort, VERSION } from "./pdf.js";

function usage(): never {
  console.error(`Usage:
  pdfport mcp
  pdfport extract-text <file>
  pdfport get-metadata <file>
  pdfport get-pdf-info <file>
  pdfport merge <output-file> <input-file...>
  pdfport split <file> <output-dir>
  pdfport --version`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd) usage();
  const port = new PdfPort();
  try {
    if (cmd === "extract-text") {
      const [file] = rest;
      if (!file) usage();
      const result = await port.extractText(file);
      console.log(result.text);
    } else if (cmd === "get-metadata") {
      const [file] = rest;
      if (!file) usage();
      console.log(JSON.stringify(await port.getMetadata(file), null, 2));
    } else if (cmd === "get-pdf-info") {
      const [file] = rest;
      if (!file) usage();
      console.log(JSON.stringify(await port.getPdfInfo(file), null, 2));
    } else if (cmd === "merge") {
      const [outputFile, ...inputs] = rest;
      if (!outputFile || inputs.length === 0) usage();
      console.log(JSON.stringify(await port.mergePdfs(inputs, outputFile), null, 2));
    } else if (cmd === "split") {
      const [file, outputDir] = rest;
      if (!file || !outputDir) usage();
      const result = await port.splitPdf(file, outputDir);
      console.log(
        JSON.stringify(
          { file_path: file, output_dir: outputDir, output_files: result.outputFiles, page_count: result.pageCount },
          null,
          2,
        ),
      );
    } else {
      usage();
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
