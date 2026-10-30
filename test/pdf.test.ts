import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PdfPort, SimplePdfEngine } from "../src/pdf.js";

// ---------------------------------------------------------------------------
// Test PDF builder: assembles small, honest PDFs as raw strings with a
// correct xref table. Objects: 1 Catalog, 2 Pages, 3 Font, then a
// Page + Contents pair per page, then an optional Info object.
// ---------------------------------------------------------------------------

interface TestPage {
  lines?: string[];
  tjArray?: string[];
  mediaBox?: [number, number, number, number];
  flate?: boolean;
}

function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(pages: TestPage[], info?: Record<string, string>): Buffer {
  const bodies = new Map<number, string>();
  bodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  bodies.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let next = 4;
  const pageNums: number[] = [];
  for (const page of pages) {
    const pageNum = next++;
    const contentNum = next++;
    pageNums.push(pageNum);
    let content: string;
    if (page.tjArray) {
      const parts = page.tjArray.map((t) => `(${escapePdfText(t)})`).join(" 120 ");
      content = `BT /F1 24 Tf 72 720 Td [${parts}] TJ ET`;
    } else {
      const lines = page.lines ?? [""];
      const ops = lines
        .map((line, idx) => (idx === 0 ? `(${escapePdfText(line)}) Tj` : `0 -28 Td (${escapePdfText(line)}) Tj`))
        .join(" ");
      content = `BT /F1 24 Tf 72 720 Td ${ops} ET`;
    }
    const contentBytes = page.flate
      ? deflateSync(Buffer.from(content, "latin1"))
      : Buffer.from(content, "latin1");
    const mb = page.mediaBox ?? [0, 0, 612, 792];
    bodies.set(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [${mb.join(" ")}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    bodies.set(
      contentNum,
      `<< /Length ${contentBytes.length}${page.flate ? " /Filter /FlateDecode" : ""} >>\n` +
        `stream\n${contentBytes.toString("latin1")}\nendstream`,
    );
  }
  bodies.set(
    2,
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`,
  );
  let infoNum: number | undefined;
  if (info) {
    infoNum = next++;
    const entries = Object.entries(info)
      .map(([k, v]) => `/${k} (${escapePdfText(v)})`)
      .join(" ");
    bodies.set(infoNum, `<< ${entries} >>`);
  }
  let out = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  const nums = [...bodies.keys()].sort((a, b) => a - b);
  for (const n of nums) {
    offsets.set(n, out.length);
    out += `${n} 0 obj\n${bodies.get(n)}\nendobj\n`;
  }
  const maxNum = nums[nums.length - 1];
  const xrefAt = out.length;
  out += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n += 1) {
    const off = offsets.get(n);
    out += off === undefined
      ? "0000000000 65535 f \n"
      : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  out +=
    `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R${infoNum !== undefined ? ` /Info ${infoNum} 0 R` : ""} >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ALPHA_INFO = {
  Title: "Alpha Doc",
  Author: "Ada Lovelace",
  Creator: "pdfport tests",
  CreationDate: "D:20261026090000Z",
  ModDate: "D:20261026100000Z",
};

function alphaPdf(): Buffer {
  return buildPdf(
    [
      { lines: ["Alpha page one"], mediaBox: [0, 0, 612, 792] },
      { lines: ["Alpha page two"], mediaBox: [0, 0, 300, 400] },
    ],
    ALPHA_INFO,
  );
}

function betaPdf(): Buffer {
  return buildPdf([{ lines: ["Beta only page"], flate: true }], { Title: "Beta Doc" });
}

// ---------------------------------------------------------------------------
// Default engine, end-to-end on generated documents
// ---------------------------------------------------------------------------

describe("SimplePdfEngine.extractText", () => {
  const engine = new SimplePdfEngine();

  it("extracts each page's text, pages joined with a newline", () => {
    assert.equal(engine.extractText(alphaPdf()), "Alpha page one\nAlpha page two");
  });

  it("decodes FlateDecode content streams", () => {
    assert.equal(engine.extractText(betaPdf()), "Beta only page");
  });

  it("concatenates TJ array parts, ignoring kerning numbers", () => {
    const doc = buildPdf([{ tjArray: ["Hel", "lo World"] }]);
    assert.equal(engine.extractText(doc), "Hello World");
  });

  it("decodes literal-string escapes for parentheses and backslash", () => {
    const doc = buildPdf([{ lines: ["Cost (est) \\ 50%"] }]);
    assert.equal(engine.extractText(doc), "Cost (est) \\ 50%");
  });

  it("extracts every shown string on a multi-line page", () => {
    const doc = buildPdf([{ lines: ["First line", "Second line"] }]);
    const text = engine.extractText(doc);
    assert.ok(text.includes("First line"), text);
    assert.ok(text.includes("Second line"), text);
  });

  it("rejects bytes that are not a PDF", () => {
    assert.throws(() => engine.extractText(Buffer.from("just some text")), /Not a PDF file/);
  });
});

describe("SimplePdfEngine.getMetadata", () => {
  const engine = new SimplePdfEngine();

  it("reads the Info dictionary and the page count", () => {
    const meta = engine.getMetadata(alphaPdf());
    assert.equal(meta.title, "Alpha Doc");
    assert.equal(meta.author, "Ada Lovelace");
    assert.equal(meta.creator, "pdfport tests");
    assert.equal(meta.creationDate, "D:20261026090000Z");
    assert.equal(meta.modDate, "D:20261026100000Z");
    assert.equal(meta.pageCount, 2);
  });

  it("omits fields the document does not carry", () => {
    const meta = engine.getMetadata(buildPdf([{ lines: ["Bare"] }]));
    assert.equal(meta.pageCount, 1);
    assert.equal(meta.title, undefined);
    assert.equal(meta.author, undefined);
  });
});

describe("SimplePdfEngine.getPdfInfo", () => {
  const engine = new SimplePdfEngine();

  it("reports page count, per-page sizes, file size and version", () => {
    const doc = alphaPdf();
    const info = engine.getPdfInfo(doc);
    assert.equal(info.pageCount, 2);
    assert.deepEqual(info.pageSizes, [
      { width: 612, height: 792 },
      { width: 300, height: 400 },
    ]);
    assert.equal(info.fileSize, doc.length);
    assert.equal(info.pdfVersion, "1.4");
  });
});

describe("SimplePdfEngine.merge", () => {
  const engine = new SimplePdfEngine();

  it("combines pages in order and keeps the first document's metadata", () => {
    const merged = engine.merge([alphaPdf(), betaPdf()]);
    assert.equal(engine.getPdfInfo(merged).pageCount, 3);
    assert.equal(
      engine.extractText(merged),
      "Alpha page one\nAlpha page two\nBeta only page",
    );
    assert.equal(engine.getMetadata(merged).title, "Alpha Doc");
    assert.deepEqual(engine.getPdfInfo(merged).pageSizes[1], { width: 300, height: 400 });
  });

  it("rejects an empty input list", () => {
    assert.throws(() => engine.merge([]), /at least one input/);
  });
});

describe("SimplePdfEngine.split", () => {
  const engine = new SimplePdfEngine();

  it("emits one single-page document per page, each extracting its own text", () => {
    const parts = engine.split(alphaPdf());
    assert.equal(parts.length, 2);
    assert.equal(engine.getPdfInfo(parts[0]).pageCount, 1);
    assert.equal(engine.extractText(parts[0]), "Alpha page one");
    assert.deepEqual(engine.getPdfInfo(parts[0]).pageSizes, [{ width: 612, height: 792 }]);
    assert.equal(engine.getPdfInfo(parts[1]).pageCount, 1);
    assert.equal(engine.extractText(parts[1]), "Alpha page two");
    assert.deepEqual(engine.getPdfInfo(parts[1]).pageSizes, [{ width: 300, height: 400 }]);
    assert.equal(engine.getMetadata(parts[1]).title, "Alpha Doc");
  });

  it("splits a merged document back into its pages", () => {
    const merged = engine.merge([alphaPdf(), betaPdf()]);
    const parts = engine.split(merged);
    assert.equal(parts.length, 3);
    assert.equal(engine.extractText(parts[2]), "Beta only page");
  });
});

// ---------------------------------------------------------------------------
// File facade against real files in a temp directory
// ---------------------------------------------------------------------------

describe("PdfPort facade", () => {
  it("reads text, metadata and info from a file on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pdfport-test-"));
    const file = path.join(dir, "alpha.pdf");
    await writeFile(file, alphaPdf());
    const port = new PdfPort();
    const extracted = await port.extractText(file);
    assert.equal(extracted.file_path, file);
    assert.equal(extracted.text, "Alpha page one\nAlpha page two");
    const meta = await port.getMetadata(file);
    assert.equal(meta.title, "Alpha Doc");
    assert.equal(meta.pageCount, 2);
    const info = await port.getPdfInfo(file);
    assert.equal(info.pageCount, 2);
    assert.equal(info.pdfVersion, "1.4");
  });

  it("mergePdfs writes an output file that re-reads correctly", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pdfport-test-"));
    const a = path.join(dir, "a.pdf");
    const b = path.join(dir, "b.pdf");
    const outFile = path.join(dir, "merged.pdf");
    await writeFile(a, alphaPdf());
    await writeFile(b, betaPdf());
    const port = new PdfPort();
    const result = await port.mergePdfs([a, b], outFile);
    assert.equal(result.output_file, outFile);
    assert.equal(result.page_count, 3);
    const reread = await port.extractText(outFile);
    assert.equal(reread.text, "Alpha page one\nAlpha page two\nBeta only page");
  });

  it("splitPdf writes one named file per page, each re-readable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pdfport-test-"));
    const file = path.join(dir, "alpha.pdf");
    const outDir = path.join(dir, "pages");
    await writeFile(file, alphaPdf());
    const port = new PdfPort();
    const result = await port.splitPdf(file, outDir);
    assert.equal(result.pageCount, 2);
    assert.deepEqual(
      result.outputFiles.map((f) => path.basename(f)),
      ["alpha-page-1.pdf", "alpha-page-2.pdf"],
    );
    const page2 = await readFile(result.outputFiles[1]);
    assert.equal(new SimplePdfEngine().extractText(page2), "Alpha page two");
  });

  it("reports a missing file with a clear error", async () => {
    const port = new PdfPort();
    await assert.rejects(() => port.extractText("/nonexistent/nope.pdf"), /PDF file not found/);
    await assert.rejects(() => port.mergePdfs([], "/tmp/out.pdf"), /at least one input/);
  });
});
