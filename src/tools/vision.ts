import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolSpec } from "../types.js";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export function createVisionTools(): ToolSpec[] {
  return [analyzeImageTool];
}

const analyzeImageTool: ToolSpec = {
  name: "analyze_image",
  description: "Read a local image file and return it as a base64 data URI. ONLY use this if you are a vision-capable model. If you are a text-only model, this will only return a giant string of characters that you cannot see.",
  jsonSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the local image file (png, jpeg, webp, etc.)"
      }
    },
    required: ["path"],
    additionalProperties: false
  },
  readOnly: true,
  async execute(rawArgs, context) {
    const args = expectObject(rawArgs);
    const target = await context.paths.ensureReadable(requiredString(args.path, "path"));
    
    try {
      const stats = await stat(target);
      if (stats.size > MAX_IMAGE_SIZE_BYTES) {
        return {
          summary: `Image too large: ${target}`,
          content: `The image is ${stats.size} bytes, which exceeds the maximum allowed size of ${MAX_IMAGE_SIZE_BYTES} bytes.`,
          isError: true,
          referencedFiles: [target]
        };
      }

      const ext = path.extname(target).toLowerCase();
      let mimeType = "image/jpeg";
      if (ext === ".png") mimeType = "image/png";
      else if (ext === ".webp") mimeType = "image/webp";
      else if (ext === ".gif") mimeType = "image/gif";

      const buffer = await readFile(target);
      const base64 = buffer.toString("base64");
      const dataUri = `data:${mimeType};base64,${base64}`;

      return {
        summary: `Read image ${target} (${Math.round(stats.size / 1024)} KB)`,
        content: `![Image](${dataUri})\n\nNOTE: If you are a text-only model, you cannot analyze the image contents from this base64 string. Do not guess what the image is. Ask the user to describe it instead.`,
        isError: false,
        referencedFiles: [target]
      };
    } catch (error) {
      return {
        summary: `Failed to read image ${target}`,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
        referencedFiles: [target]
      };
    }
  }
};

function expectObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Tool arguments must be a JSON object.");
}

function requiredString(value: unknown, key: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing string argument: ${key}`);
}
