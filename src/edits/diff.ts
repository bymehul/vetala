interface DiffOp {
  type: "equal" | "add" | "remove";
  line: string;
}

const DEFAULT_CONTEXT_LINES = 2;
const MAX_PREVIEW_LINES = 64;
const MAX_LINE_PRODUCT = 120_000;

export function buildDiffPreview(
  filePath: string,
  beforeContent: string | null,
  afterContent: string | null,
  contextLines = DEFAULT_CONTEXT_LINES
): string {
  const beforeLines = splitLines(beforeContent);
  const afterLines = splitLines(afterContent);

  if (beforeContent === afterContent) {
    return `No visible changes for ${filePath}.`;
  }

  const ops = beforeLines.length * afterLines.length > MAX_LINE_PRODUCT
    ? fallbackOps(beforeLines, afterLines)
    : lcsDiff(beforeLines, afterLines);
  const stats = summarizeOps(ops);
  const hunks = renderPreviewHunks(ops, contextLines, MAX_PREVIEW_LINES);

  return [
    `--- ${beforeContent === null ? "/dev/null" : filePath}`,
    `+++ ${afterContent === null ? "/dev/null" : filePath}`,
    `changes: +${stats.added} -${stats.removed}`,
    ...hunks
  ].join("\n");
}

function splitLines(content: string | null): string[] {
  if (content === null || content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
}

function summarizeOps(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const op of ops) {
    if (op.type === "add") {
      added += 1;
    } else if (op.type === "remove") {
      removed += 1;
    }
  }

  return { added, removed };
}

function renderPreviewHunks(ops: DiffOp[], contextLines: number, maxLines: number): string[] {
  const hunks: string[] = [];
  const ranges = collectHunkRanges(ops, contextLines);
  let renderedLines = 0;

  for (const range of ranges) {
    if (hunks.length > 0) {
      hunks.push("...");
      renderedLines += 1;
    }

    for (let index = range.start; index <= range.end; index += 1) {
      const op = ops[index];

      if (!op) {
        continue;
      }

      hunks.push(prefixLine(op));
      renderedLines += 1;

      if (renderedLines >= maxLines) {
        hunks.push("... (diff preview truncated)");
        return hunks;
      }
    }
  }

  return hunks.length > 0 ? hunks : ["... (unable to render diff preview)"];
}

function collectHunkRanges(ops: DiffOp[], contextLines: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index]?.type === "equal") {
      continue;
    }

    const nextRange = {
      start: Math.max(0, index - contextLines),
      end: Math.min(ops.length - 1, index + contextLines)
    };
    const previous = ranges.at(-1);

    if (previous && nextRange.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, nextRange.end);
      continue;
    }

    ranges.push(nextRange);
  }

  return ranges;
}

function prefixLine(op: DiffOp): string {
  switch (op.type) {
    case "add":
      return `+ ${op.line}`;
    case "remove":
      return `- ${op.line}`;
    case "equal":
      return `  ${op.line}`;
  }
}

function fallbackOps(beforeLines: string[], afterLines: string[]): DiffOp[] {
  const prefix = commonPrefixLength(beforeLines, afterLines);
  const suffix = commonSuffixLength(beforeLines, afterLines, prefix);
  const ops: DiffOp[] = [];

  for (const line of beforeLines.slice(0, prefix)) {
    ops.push({ type: "equal", line });
  }

  for (const line of beforeLines.slice(prefix, beforeLines.length - suffix)) {
    ops.push({ type: "remove", line });
  }

  for (const line of afterLines.slice(prefix, afterLines.length - suffix)) {
    ops.push({ type: "add", line });
  }

  for (const line of beforeLines.slice(beforeLines.length - suffix)) {
    ops.push({ type: "equal", line });
  }

  return ops;
}

function commonPrefixLength(left: string[], right: string[]): number {
  let index = 0;

  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }

  return index;
}

function commonSuffixLength(left: string[], right: string[], prefix: number): number {
  let index = 0;

  while (
    left.length - index - 1 >= prefix &&
    right.length - index - 1 >= prefix &&
    left[left.length - index - 1] === right[right.length - index - 1]
  ) {
    index += 1;
  }

  return index;
}

function lcsDiff(beforeLines: string[], afterLines: string[]): DiffOp[] {
  const matrix = buildLcsMatrix(beforeLines, afterLines);
  const ops: DiffOp[] = [];
  let leftIndex = beforeLines.length;
  let rightIndex = afterLines.length;

  while (leftIndex > 0 && rightIndex > 0) {
    if (beforeLines[leftIndex - 1] === afterLines[rightIndex - 1]) {
      ops.push({ type: "equal", line: beforeLines[leftIndex - 1] ?? "" });
      leftIndex -= 1;
      rightIndex -= 1;
      continue;
    }

    if ((matrix[leftIndex - 1]?.[rightIndex] ?? 0) >= (matrix[leftIndex]?.[rightIndex - 1] ?? 0)) {
      ops.push({ type: "remove", line: beforeLines[leftIndex - 1] ?? "" });
      leftIndex -= 1;
    } else {
      ops.push({ type: "add", line: afterLines[rightIndex - 1] ?? "" });
      rightIndex -= 1;
    }
  }

  while (leftIndex > 0) {
    ops.push({ type: "remove", line: beforeLines[leftIndex - 1] ?? "" });
    leftIndex -= 1;
  }

  while (rightIndex > 0) {
    ops.push({ type: "add", line: afterLines[rightIndex - 1] ?? "" });
    rightIndex -= 1;
  }

  return ops.reverse();
}

function buildLcsMatrix(beforeLines: string[], afterLines: string[]): number[][] {
  const matrix = Array.from({ length: beforeLines.length + 1 }, () => Array<number>(afterLines.length + 1).fill(0));

  for (let leftIndex = 1; leftIndex <= beforeLines.length; leftIndex += 1) {
    const row = matrix[leftIndex];

    if (!row) {
      continue;
    }

    for (let rightIndex = 1; rightIndex <= afterLines.length; rightIndex += 1) {
      row[rightIndex] = beforeLines[leftIndex - 1] === afterLines[rightIndex - 1]
        ? (matrix[leftIndex - 1]?.[rightIndex - 1] ?? 0) + 1
        : Math.max(matrix[leftIndex - 1]?.[rightIndex] ?? 0, matrix[leftIndex]?.[rightIndex - 1] ?? 0);
    }
  }

  return matrix;
}
