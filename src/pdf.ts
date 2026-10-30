/**
 * pdfport core: a small, genuine PDF engine in pure TypeScript, plus a
 * file-based facade (PdfPort) behind an injectable PdfEngine.
 *
 * Supported subset — stated plainly, because honesty about scope is
 * the point of this rebuild: simple PDFs whose object graph is a
 * Catalog pointing at a flat Pages node whose Kids are Page objects
 * (the shape produced by common generators and by this module's own
 * merge/split output). Objects are found by scanning the raw bytes
 * for "N G obj ... endobj" blocks; the xref table is read for nothing
 * and rebuilt from scratch on output. Content streams may be plain
 * or FlateDecode-compressed (inflated with node:zlib). Text is
 * recovered from the Tj, TJ, ' and " show operators, with
 * literal-string escapes (including octal) and hex strings decoded.
 * Encrypted files, object streams, compressed xref streams, nested
 * page trees, Type0/CID fonts and ToUnicode remapping are out of
 * scope — see the README's scope note.
 */
import { inflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PdfEngine, PdfInfo, PdfMetadata, PageSize, SplitResult } from "./types.js";

export const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Byte handling: PDFs are treated as latin1 text (one byte = one char),
// so string offsets are byte offsets and stream bytes survive intact.
// ---------------------------------------------------------------------------

interface PdfObject {
  num: number;
  /** Full inner body: dictionary plus "stream ... endstream" when present. */
  body: string;
  /** The dictionary portion (everything before "stream", or the whole body). */
  dict: string;
  /** Raw stream bytes when the object carries a stream, else null. */
  stream: Buffer | null;
}

interface ParsedPdf {
  text: string;
  version: string;
  objects: Map<number, PdfObject>;
  catalogNum: number;
  pagesNum: number;
  pageNums: number[];
  infoNum?: number;
}

function parseObjects(text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj(?![0-9])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const bodyStart = re.lastIndex;
    const end = text.indexOf("endobj", bodyStart);
    if (end === -1) continue;
    const body = text.slice(bodyStart, end).replace(/^\s+/, "").replace(/\s+$/, "");
    let dict = body;
    let stream: Buffer | null = null;
    const streamAt = body.indexOf("stream");
    if (streamAt !== -1) {
      dict = body.slice(0, streamAt);
      let dataStart = streamAt + "stream".length;
      if (body.startsWith("\r\n", dataStart)) dataStart += 2;
      else if (body[dataStart] === "\n" || body[dataStart] === "\r") dataStart += 1;
      const lengthMatch = /\/Length\s+(\d+)/.exec(dict);
      if (lengthMatch) {
        const len = Number(lengthMatch[1]);
        stream = Buffer.from(body.slice(dataStart, dataStart + len), "latin1");
      } else {
        const streamEnd = body.lastIndexOf("endstream");
        let raw = body.slice(dataStart, streamEnd);
        if (raw.endsWith("\r\n")) raw = raw.slice(0, -2);
        else if (raw.endsWith("\n") || raw.endsWith("\r")) raw = raw.slice(0, -1);
        stream = Buffer.from(raw, "latin1");
      }
    }
    objects.set(num, { num, body, dict, stream });
  }
  return objects;
}

function refTarget(dict: string, key: string): number | undefined {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return match ? Number(match[1]) : undefined;
}

function trailerInfoNum(text: string): number | undefined {
  const re = /\/Info\s+(\d+)\s+\d+\s+R/g;
  let found: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found = Number(m[1]);
  return found;
}

export function parsePdf(data: Buffer): ParsedPdf {
  const text = data.toString("latin1");
  const header = /%PDF-(\d+\.\d+)/.exec(text.slice(0, 1024));
  if (!header) {
    throw new Error("Not a PDF file: missing %PDF- header");
  }
  const objects = parseObjects(text);
  if (objects.size === 0) {
    throw new Error("Not a PDF file: no indirect objects found");
  }
  let catalogNum: number | undefined;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Catalog(?![A-Za-z])/.test(obj.dict)) {
      catalogNum = obj.num;
      break;
    }
  }
  if (catalogNum === undefined) {
    throw new Error("Invalid PDF: no /Type /Catalog object found");
  }
  const catalog = objects.get(catalogNum)!;
  const pagesNum = refTarget(catalog.dict, "Pages");
  if (pagesNum === undefined || !objects.has(pagesNum)) {
    throw new Error("Invalid PDF: catalog has no usable /Pages reference");
  }
  const pages = objects.get(pagesNum)!;
  const kidsMatch = /\/Kids\s*\[([^\]]*)\]/.exec(pages.dict);
  const pageNums: number[] = [];
  if (kidsMatch) {
    const refRe = /(\d+)\s+\d+\s+R/g;
    let rm: RegExpExecArray | null;
    while ((rm = refRe.exec(kidsMatch[1])) !== null) pageNums.push(Number(rm[1]));
  }
  let infoNum = trailerInfoNum(text);
  if (infoNum === undefined || !objects.has(infoNum)) {
    infoNum = undefined;
    for (const obj of objects.values()) {
      if (/\/Title\s*[(<]/.test(obj.dict)) {
        infoNum = obj.num;
        break;
      }
    }
  }
  const parsed: ParsedPdf = {
    text,
    version: header[1],
    objects,
    catalogNum,
    pagesNum,
    pageNums,
  };
  if (infoNum !== undefined) parsed.infoNum = infoNum;
  return parsed;
}

function pageCount(parsed: ParsedPdf): number {
  const pages = parsed.objects.get(parsed.pagesNum)!;
  const count = /\/Count\s+(\d+)/.exec(pages.dict);
  if (count) return Number(count[1]);
  return parsed.pageNums.length;
}

function mediaBoxOf(dict: string): PageSize | undefined {
  const m = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(dict);
  if (!m) return undefined;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

// ---------------------------------------------------------------------------
// PDF literal / hex strings
// ---------------------------------------------------------------------------

/** Parse a literal string starting at text[start] === "(". Returns value + index after ")". */
export function parseLiteralString(text: string, start: number): { value: string; next: number } {
  let out = "";
  let depth = 1;
  let i = start + 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "\\") {
      const nxt = text[i + 1] ?? "";
      if (nxt === "n") { out += "\n"; i += 2; continue; }
      if (nxt === "r") { out += "\r"; i += 2; continue; }
      if (nxt === "t") { out += "\t"; i += 2; continue; }
      if (nxt === "b") { out += "\b"; i += 2; continue; }
      if (nxt === "f") { out += "\f"; i += 2; continue; }
      if (nxt === "(" || nxt === ")" || nxt === "\\") { out += nxt; i += 2; continue; }
      if (nxt === "\n") { i += 2; continue; }
      if (nxt === "\r") { i += text[i + 2] === "\n" ? 3 : 2; continue; }
      if (nxt >= "0" && nxt <= "7") {
        let oct = "";
        let j = i + 1;
        while (j < text.length && oct.length < 3 && text[j] >= "0" && text[j] <= "7") {
          oct += text[j];
          j += 1;
        }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j;
        continue;
      }
      out += nxt;
      i += 2;
      continue;
    }
    if (ch === "(") { depth += 1; out += ch; i += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth > 0) out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { value: out, next: i };
}

function parseHexString(text: string, start: number): { value: string; next: number } {
  const end = text.indexOf(">", start + 1);
  const stop = end === -1 ? text.length : end;
  let hex = text.slice(start + 1, stop).replace(/\s+/g, "");
  if (hex.length % 2 === 1) hex += "0";
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return { value: out, next: end === -1 ? text.length : end + 1 };
}

// ---------------------------------------------------------------------------
// Content-stream text extraction
// ---------------------------------------------------------------------------

/**
 * Recover shown text from one decoded content stream. The scanner
 * tracks the most recent string operand and the most recent array
 * operand; Tj / ' / " emit the string, TJ emits the array's strings
 * concatenated (the numeric kerning adjustments carry no text).
 * Positioning operators are ignored, so text is grouped by show
 * operation, not by visual line.
 */
export function extractTextFromContent(content: string): string {
  let out = "";
  let pendingString: string | null = null;
  let pendingArray: string | null = null;
  let i = 0;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0";
  const isDelimiter = (c: string) =>
    isWs(c) || c === "(" || c === ")" || c === "<" || c === ">" || c === "[" || c === "]" ||
    c === "{" || c === "}" || c === "/" || c === "%";
  while (i < content.length) {
    const ch = content[i];
    if (isWs(ch)) { i += 1; continue; }
    if (ch === "%") {
      while (i < content.length && content[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "(") {
      const parsed = parseLiteralString(content, i);
      pendingString = parsed.value;
      pendingArray = null;
      i = parsed.next;
      continue;
    }
    if (ch === "<") {
      if (content[i + 1] === "<") { i += 2; continue; }
      const parsed = parseHexString(content, i);
      pendingString = parsed.value;
      pendingArray = null;
      i = parsed.next;
      continue;
    }
    if (ch === ">") { i += content[i + 1] === ">" ? 2 : 1; continue; }
    if (ch === "[") {
      let joined = "";
      i += 1;
      while (i < content.length && content[i] !== "]") {
        const c = content[i];
        if (c === "(") {
          const parsed = parseLiteralString(content, i);
          joined += parsed.value;
          i = parsed.next;
          continue;
        }
        if (c === "<" && content[i + 1] !== "<") {
          const parsed = parseHexString(content, i);
          joined += parsed.value;
          i = parsed.next;
          continue;
        }
        i += 1;
      }
      i += 1; // consume "]"
      pendingArray = joined;
      pendingString = null;
      continue;
    }
    if (ch === "]" || ch === "{" || ch === "}") { i += 1; continue; }
    if (ch === "/") {
      i += 1;
      while (i < content.length && !isDelimiter(content[i])) i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (pendingString !== null) {
        out += pendingString;
        pendingString = null;
      }
      i += 1;
      continue;
    }
    // A regular token: number or operator word.
    let j = i;
    while (j < content.length && !isDelimiter(content[j])) j += 1;
    const word = content.slice(i, j);
    i = j;
    if (word === "Tj") {
      if (pendingString !== null) {
        out += pendingString;
        pendingString = null;
      }
    } else if (word === "TJ") {
      if (pendingArray !== null) {
        out += pendingArray;
        pendingArray = null;
      }
    }
  }
  return out;
}

function decodeStream(obj: PdfObject): Buffer | null {
  if (!obj.stream) return null;
  if (/\/FlateDecode(?![A-Za-z])/.test(obj.dict)) {
    try {
      return inflateSync(obj.stream);
    } catch (err) {
      throw new Error(
        `Failed to inflate a FlateDecode stream in object ${obj.num}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return obj.stream;
}

function pageText(parsed: ParsedPdf, pageNum: number): string {
  const page = parsed.objects.get(pageNum);
  if (!page) return "";
  const contents = refTarget(page.dict, "Contents");
  const refs: number[] = [];
  if (contents !== undefined) {
    refs.push(contents);
  } else {
    const arr = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    if (arr) {
      const refRe = /(\d+)\s+\d+\s+R/g;
      let rm: RegExpExecArray | null;
      while ((rm = refRe.exec(arr[1])) !== null) refs.push(Number(rm[1]));
    }
  }
  let out = "";
  for (const ref of refs) {
    const obj = parsed.objects.get(ref);
    if (!obj) continue;
    const decoded = decodeStream(obj);
    if (decoded) out += extractTextFromContent(decoded.toString("latin1"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Document writer: renumbered objects + a freshly computed xref table.
// Bodies are latin1 strings, so character offsets are byte offsets.
// ---------------------------------------------------------------------------

function remapRefs(dictText: string, map: Map<number, number>): string {
  return dictText.replace(/(\d+)\s+(\d+)\s+R/g, (whole, num: string) => {
    const mapped = map.get(Number(num));
    return mapped === undefined ? whole : `${mapped} 0 R`;
  });
}

/**
 * Rebuild one object's body under a renumbering map. References are
 * rewritten in the dictionary portion only; stream bytes are copied
 * verbatim (they hold content, not object references).
 */
function remapBody(body: string, map: Map<number, number>): string {
  const streamAt = body.indexOf("stream");
  if (streamAt === -1) return remapRefs(body, map);
  return remapRefs(body.slice(0, streamAt), map) + body.slice(streamAt);
}

function buildDocument(
  bodies: Map<number, string>,
  rootNum: number,
  infoNum: number | undefined,
  version: string,
): Buffer {
  const header = `%PDF-${version}\n`;
  const nums = [...bodies.keys()].sort((a, b) => a - b);
  const maxNum = nums.length > 0 ? nums[nums.length - 1] : 0;
  const offsets = new Map<number, number>();
  let out = header;
  for (const num of nums) {
    offsets.set(num, out.length);
    out += `${num} 0 obj\n${bodies.get(num)}\nendobj\n`;
  }
  const xrefAt = out.length;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n += 1) {
    const off = offsets.get(n);
    xref += off === undefined
      ? "0000000000 65535 f \n"
      : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  const infoPart = infoNum !== undefined ? ` /Info ${infoNum} 0 R` : "";
  out += xref +
    `trailer\n<< /Size ${maxNum + 1} /Root ${rootNum} 0 R${infoPart} >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/**
 * Copy a parsed document's objects (minus its Catalog and Pages root)
 * under fresh numbers 3, 4, 5..., returning the remapped bodies, the
 * old->new map (with Catalog -> 1 and Pages root -> 2 prefilled), and
 * the mapped Info number when the source had one.
 */
function copyObjects(
  parsed: ParsedPdf,
  onlyPages: number[] | null,
): { bodies: Map<number, string>; map: Map<number, number>; infoNum?: number } {
  const map = new Map<number, number>();
  map.set(parsed.catalogNum, 1);
  map.set(parsed.pagesNum, 2);
  let next = 3;
  const sorted = [...parsed.objects.keys()].sort((a, b) => a - b);
  for (const num of sorted) {
    if (num === parsed.catalogNum || num === parsed.pagesNum) continue;
    map.set(num, next);
    next += 1;
  }
  const bodies = new Map<number, string>();
  for (const num of sorted) {
    if (num === parsed.catalogNum || num === parsed.pagesNum) continue;
    const obj = parsed.objects.get(num)!;
    bodies.set(map.get(num)!, remapBody(obj.body, map));
  }
  void onlyPages;
  const result: { bodies: Map<number, string>; map: Map<number, number>; infoNum?: number } = { bodies, map };
  if (parsed.infoNum !== undefined && map.has(parsed.infoNum)) {
    result.infoNum = map.get(parsed.infoNum);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

type MetadataTextKey = Exclude<keyof PdfMetadata, "pageCount">;

const INFO_KEYS: Array<[string, MetadataTextKey]> = [
  ["Title", "title"],
  ["Author", "author"],
  ["Subject", "subject"],
  ["Keywords", "keywords"],
  ["Creator", "creator"],
  ["Producer", "producer"],
  ["CreationDate", "creationDate"],
  ["ModDate", "modDate"],
];

export class SimplePdfEngine implements PdfEngine {
  extractText(data: Buffer): string {
    const parsed = parsePdf(data);
    return parsed.pageNums.map((num) => pageText(parsed, num)).join("\n");
  }

  getMetadata(data: Buffer): PdfMetadata {
    const parsed = parsePdf(data);
    const metadata: PdfMetadata = { pageCount: pageCount(parsed) };
    if (parsed.infoNum !== undefined) {
      const info = parsed.objects.get(parsed.infoNum);
      if (info) {
        for (const [pdfKey, outKey] of INFO_KEYS) {
          const at = info.dict.indexOf(`/${pdfKey}`);
          if (at === -1) continue;
          let i = at + pdfKey.length + 1;
          while (i < info.dict.length && /\s/.test(info.dict[i])) i += 1;
          if (info.dict[i] === "(") {
            metadata[outKey] = parseLiteralString(info.dict, i).value;
          } else if (info.dict[i] === "<" && info.dict[i + 1] !== "<") {
            metadata[outKey] = parseHexString(info.dict, i).value;
          }
        }
      }
    }
    return metadata;
  }

  getPdfInfo(data: Buffer): PdfInfo {
    const parsed = parsePdf(data);
    const pagesRoot = parsed.objects.get(parsed.pagesNum)!;
    const inherited = mediaBoxOf(pagesRoot.dict);
    const pageSizes = parsed.pageNums.map((num) => {
      const page = parsed.objects.get(num);
      const own = page ? mediaBoxOf(page.dict) : undefined;
      return own ?? inherited ?? { width: 612, height: 792 };
    });
    return {
      pageCount: pageCount(parsed),
      pageSizes,
      fileSize: data.length,
      pdfVersion: parsed.version,
    };
  }

  merge(datas: Buffer[]): Buffer {
    if (datas.length === 0) {
      throw new Error("merge_pdfs requires at least one input file");
    }
    const parsedDocs = datas.map((d) => parsePdf(d));
    const bodies = new Map<number, string>();
    const allPageRefs: number[] = [];
    let next = 3;
    let infoNum: number | undefined;
    for (const parsed of parsedDocs) {
      const map = new Map<number, number>();
      map.set(parsed.catalogNum, 1);
      map.set(parsed.pagesNum, 2);
      const sorted = [...parsed.objects.keys()].sort((a, b) => a - b);
      for (const num of sorted) {
        if (num === parsed.catalogNum || num === parsed.pagesNum) continue;
        map.set(num, next);
        next += 1;
      }
      for (const num of sorted) {
        if (num === parsed.catalogNum || num === parsed.pagesNum) continue;
        const obj = parsed.objects.get(num)!;
        bodies.set(map.get(num)!, remapBody(obj.body, map));
      }
      for (const pageNum of parsed.pageNums) {
        const mapped = map.get(pageNum);
        if (mapped !== undefined) allPageRefs.push(mapped);
      }
      if (infoNum === undefined && parsed.infoNum !== undefined && map.has(parsed.infoNum)) {
        infoNum = map.get(parsed.infoNum);
      }
    }
    const kids = allPageRefs.map((n) => `${n} 0 R`).join(" ");
    bodies.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${allPageRefs.length} >>`);
    bodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
    return buildDocument(bodies, 1, infoNum, parsedDocs[0].version);
  }

  split(data: Buffer): Buffer[] {
    const parsed = parsePdf(data);
    if (parsed.pageNums.length === 0) {
      throw new Error("Invalid PDF: the Pages tree lists no pages to split");
    }
    return parsed.pageNums.map((pageNum) => {
      const { bodies, map, infoNum } = copyObjects(parsed, null);
      const mappedPage = map.get(pageNum)!;
      bodies.set(2, `<< /Type /Pages /Kids [${mappedPage} 0 R] /Count 1 >>`);
      bodies.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
      return buildDocument(bodies, 1, infoNum, parsed.version);
    });
  }
}

// ---------------------------------------------------------------------------
// File facade
// ---------------------------------------------------------------------------

async function readPdfFile(filePath: string): Promise<Buffer> {
  try {
    return await readFile(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`PDF file not found: ${filePath}`);
    }
    throw err;
  }
}

export class PdfPort {
  constructor(private readonly engine: PdfEngine = new SimplePdfEngine()) {}

  async extractText(filePath: string): Promise<{ file_path: string; text: string }> {
    const data = await readPdfFile(filePath);
    return { file_path: filePath, text: this.engine.extractText(data) };
  }

  async getMetadata(filePath: string): Promise<PdfMetadata & { file_path: string }> {
    const data = await readPdfFile(filePath);
    return { file_path: filePath, ...this.engine.getMetadata(data) };
  }

  async getPdfInfo(filePath: string): Promise<PdfInfo & { file_path: string }> {
    const data = await readPdfFile(filePath);
    return { file_path: filePath, ...this.engine.getPdfInfo(data) };
  }

  async mergePdfs(
    inputFiles: string[],
    outputFile: string,
  ): Promise<{ output_file: string; page_count: number }> {
    if (!Array.isArray(inputFiles) || inputFiles.length === 0) {
      throw new Error("merge_pdfs requires at least one input file");
    }
    const datas: Buffer[] = [];
    for (const file of inputFiles) {
      datas.push(await readPdfFile(file));
    }
    const merged = this.engine.merge(datas);
    const dir = path.dirname(path.resolve(outputFile));
    await mkdir(dir, { recursive: true });
    await writeFile(outputFile, merged);
    return { output_file: outputFile, page_count: this.engine.getPdfInfo(merged).pageCount };
  }

  async splitPdf(filePath: string, outputDir: string): Promise<SplitResult> {
    const data = await readPdfFile(filePath);
    const parts = this.engine.split(data);
    await mkdir(outputDir, { recursive: true });
    const base = path.basename(filePath).replace(/\.pdf$/i, "");
    const outputFiles: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const outPath = path.join(outputDir, `${base}-page-${i + 1}.pdf`);
      await writeFile(outPath, parts[i]);
      outputFiles.push(outPath);
    }
    return { outputFiles, pageCount: parts.length };
  }
}
