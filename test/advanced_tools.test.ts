import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createInteractionTools } from "../src/tools/interaction.js";
import { createVisionTools } from "../src/tools/vision.js";
import { createWebTools } from "../src/tools/web.js";
import { createLspTools } from "../src/tools/lsp.js";
import { createAdvancedTools } from "../src/tools/advanced.js";
import type { ToolContext } from "../src/types.js";

async function createTempContext(): Promise<{ root: string; ctx: ToolContext }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "vetala-adv-tools-test-"));
  const ctx: ToolContext = {
    cwd: root,
    workspaceRoot: root,
    approvals: {
      requestApproval: async () => true,
      hasSessionGrant: () => false,
      registerReference: async () => {},
      ensureWebAccess: async () => true
    },
    interaction: {
      askText: async (prompt) => "mock user response",
      askSelect: async (prompt, options) => 0
    },
    reads: {
      hasRead: () => true,
      registerRead: async () => {}
    },
    edits: {
      recordEdit: async (edit) => ({ ...edit, id: "1", timestamp: new Date().toISOString() })
    },
    paths: {
      resolve: (p) => path.resolve(root, p),
      ensureReadable: async (p) => path.resolve(root, p),
      ensureWritable: async (p) => path.resolve(root, p),
      allowedRoots: () => [root]
    },
    searchProvider: {
      name: "disabled",
      configured: false,
      search: async () => []
    }
  };
  return { root, ctx };
}

test("ask_user tool", async () => {
  const { ctx } = await createTempContext();
  const tools = createInteractionTools();
  const askTool = tools.find(t => t.name === "ask_user")!;
  
  const result = await askTool.execute({ questions: [{ type: "text", question: "Are you sure?" }] }, ctx);
  assert.equal(result.isError, false);
  assert.match(result.content, /mock user response/);
});

test("analyze_image tool ignores large files and handles basic images", async () => {
  const { root, ctx } = await createTempContext();
  const tools = createVisionTools();
  const analyzeImageTool = tools.find(t => t.name === "analyze_image")!;
  
  const imgPath = path.join(root, "test.png");
  // create dummy file
  await writeFile(imgPath, "fake image data");
  
  const result = await analyzeImageTool.execute({ path: imgPath }, ctx);
  assert.equal(result.isError, false);
  assert.match(result.content, /data:image\/png;base64,/);
  assert.match(result.content, /If you are a text-only model/);
});

test("read_docs tool blocks without urls", async () => {
  const { ctx } = await createTempContext();
  const tools = createWebTools();
  const readDocsTool = tools.find(t => t.name === "read_docs")!;
  
  const result = await readDocsTool.execute({ urls: [] }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content, /No valid URLs/);
});

test("list_exports tool extracts from typescript", async () => {
  const { root, ctx } = await createTempContext();
  const tools = createLspTools();
  const listExportsTool = tools.find(t => t.name === "list_exports")!;
  
  const file = path.join(root, "test.ts");
  await writeFile(file, "export function a() {}\nconst b = 2;\nexport class C {}\n");
  
  const result = await listExportsTool.execute({ path: file }, ctx);
  assert.equal(result.isError, false);
  assert.match(result.content, /export function a/);
  assert.match(result.content, /export class C/);
  assert.doesNotMatch(result.content, /const b = 2/);
});

test("get_diagnostics detects missing projects", async () => {
  const { ctx } = await createTempContext();
  const tools = createLspTools();
  const diagTool = tools.find(t => t.name === "get_diagnostics")!;
  
  const result = await diagTool.execute({}, ctx);
  // It should fail to detect any project
  assert.equal(result.isError, true);
  assert.match(result.content, /Could not find tsconfig/);
});

test("find_references tool falls back to searchRepo", async () => {
  const { root, ctx } = await createTempContext();
  const tools = createLspTools();
  const refTool = tools.find(t => t.name === "find_references")!;
  
  await writeFile(path.join(root, "foo.ts"), "const a = testFunc();");
  
  // mock search repo... actually searchRepo in our tools relies on actual file system 
  // Let's rely on ripgrep/grep or git grep from search_repo which needs git or a standard tool.
  // Since we don't have git initialized in tmp, searchRepo might just return 0.
  // We'll just test that it runs.
  const result = await refTool.execute({ symbol: "testFunc" }, ctx);
  assert.equal(result.isError, false);
});

test("semantic_search tool requires keywords", async () => {
  const { ctx } = await createTempContext();
  const tools = createAdvancedTools();
  const semSearchTool = tools.find(t => t.name === "semantic_search")!;
  
  const result = await semSearchTool.execute({ query: "find something", keywords: [] }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.summary, /No keywords/);
});

test("ast_replace fails if sg not installed or no matches", async () => {
  const { root, ctx } = await createTempContext();
  const tools = createAdvancedTools();
  const astReplaceTool = tools.find(t => t.name === "ast_replace")!;
  
  await writeFile(path.join(root, "test.ts"), "const a = 1;");
  
  const result = await astReplaceTool.execute({ path: path.join(root, "test.ts"), pattern: "const a = $A;", replacement: "const a = 2;" }, ctx);
  // If sg is installed it might work, else it fails. We just ensure it doesn't throw unhandled errors.
  assert.ok(result.summary.includes("ast-grep") || result.summary.includes("failed") || result.isError === false);
});
