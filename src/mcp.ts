/**
 * pdfport MCP server. Tools: extract_text, get_metadata, get_pdf_info,
 * merge_pdfs, split_pdf.
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects two keys that are
 * not in this toolset's public spec ("$schema" and
 * "additionalProperties"), which breaks exact tool-list/schema parity
 * with the spec. This file therefore serves tools/list with the
 * spec's exact input schemas, while zod still validates every
 * tools/call argument set.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PdfPort, VERSION } from "./pdf.js";

const FilePathArgs = z.object({
  file_path: z.string(),
});

const MergeArgs = z.object({
  input_files: z.array(z.string()),
  output_file: z.string(),
});

const SplitArgs = z.object({
  file_path: z.string(),
  output_dir: z.string(),
});

const FILE_PATH_SCHEMA = {
  type: "object" as const,
  properties: {
    file_path: { type: "string" },
  },
  required: ["file_path"],
};

const TOOLS = [
  {
    name: "extract_text",
    description: "Extract text from a local PDF file",
    inputSchema: FILE_PATH_SCHEMA,
  },
  {
    name: "get_metadata",
    description: "Read a PDF file's document metadata (title, author, dates, page count)",
    inputSchema: FILE_PATH_SCHEMA,
  },
  {
    name: "get_pdf_info",
    description: "Get summary information about a PDF file: page count, page sizes, file size, PDF version",
    inputSchema: FILE_PATH_SCHEMA,
  },
  {
    name: "merge_pdfs",
    description: "Merge multiple PDF files into one output file",
    inputSchema: {
      type: "object" as const,
      properties: {
        input_files: { type: "array", items: { type: "string" } },
        output_file: { type: "string" },
      },
      required: ["input_files", "output_file"],
    },
  },
  {
    name: "split_pdf",
    description: "Split a PDF file into one file per page in an output directory",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        output_dir: { type: "string" },
      },
      required: ["file_path", "output_dir"],
    },
  },
];

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const port = new PdfPort();

const server = new Server(
  { name: "pdfport", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "extract_text": {
        const parsed = FilePathArgs.parse(args ?? {});
        return textResult(await port.extractText(parsed.file_path));
      }
      case "get_metadata": {
        const parsed = FilePathArgs.parse(args ?? {});
        return textResult(await port.getMetadata(parsed.file_path));
      }
      case "get_pdf_info": {
        const parsed = FilePathArgs.parse(args ?? {});
        return textResult(await port.getPdfInfo(parsed.file_path));
      }
      case "merge_pdfs": {
        const parsed = MergeArgs.parse(args ?? {});
        return textResult(await port.mergePdfs(parsed.input_files, parsed.output_file));
      }
      case "split_pdf": {
        const parsed = SplitArgs.parse(args ?? {});
        const result = await port.splitPdf(parsed.file_path, parsed.output_dir);
        return textResult({
          file_path: parsed.file_path,
          output_dir: parsed.output_dir,
          output_files: result.outputFiles,
          page_count: result.pageCount,
        });
      }
    }
  } catch (err) {
    return errorResult(err);
  }
  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
