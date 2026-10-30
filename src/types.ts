/**
 * pdfport types.
 *
 * The MCP and CLI layers talk to PDF documents only through the
 * PdfEngine interface, so the layers can be exercised with a stub
 * engine. The default engine is the pure-TypeScript implementation in
 * pdf.ts, and the test suite drives it end-to-end on generated PDFs.
 */

/** One page's dimensions in PDF points, from its MediaBox. */
export interface PageSize {
  width: number;
  height: number;
}

/**
 * Document metadata read from the PDF Info dictionary. Fields the
 * document does not carry are omitted, never invented.
 */
export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  /** Raw Info-dictionary date string, e.g. "D:20261026090000Z". */
  creationDate?: string;
  /** Raw Info-dictionary date string. */
  modDate?: string;
  /** Page count from the document's Pages tree. */
  pageCount: number;
}

/** Summary information about one PDF file. */
export interface PdfInfo {
  pageCount: number;
  pageSizes: PageSize[];
  /** Size of the file on disk, in bytes. */
  fileSize: number;
  /** Version from the "%PDF-x.y" header, e.g. "1.4". */
  pdfVersion: string;
}

/** Result of a split: the files that were written and the page count. */
export interface SplitResult {
  outputFiles: string[];
  pageCount: number;
}

/**
 * The PDF operations pdfport performs, over in-memory document bytes.
 * File reading and writing live in the PdfPort facade (pdf.ts), which
 * keeps the engine itself pure and trivially testable.
 */
export interface PdfEngine {
  /** Extract the text of every page, pages joined with a newline. */
  extractText(data: Buffer): string;
  /** Read the Info dictionary plus the page count. */
  getMetadata(data: Buffer): PdfMetadata;
  /** Page count, per-page sizes, file size and PDF version. */
  getPdfInfo(data: Buffer): PdfInfo;
  /** Merge documents into one new document's bytes. */
  merge(datas: Buffer[]): Buffer;
  /** Produce one new single-page document per page of the input. */
  split(data: Buffer): Buffer[];
}
