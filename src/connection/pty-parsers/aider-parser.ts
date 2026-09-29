import {
  createAgentMessageEvent,
  createStderrEvent,
  createToolCallEvent,
  createToolCallUpdateEvent,
  PtyOutputParser,
  PtyParserContext,
  PtyParserResult,
  PtyStream,
} from "../pty-parser.js";

export interface AiderEditBlock {
  readonly format: "whole" | "diff" | "diff-fenced" | "udiff";
  readonly path: string;
  readonly oldText?: string;
  readonly newText: string;
}

interface CodeSegment {
  readonly language: string;
  readonly content: string;
}

export class AiderPtyParser implements PtyOutputParser {
  readonly id = "aider";
  private buffer = "";
  private emittedEditKeys = new Set<string>();
  private nextToolCallIndex = 1;

  onData(context: PtyParserContext, stream: PtyStream, chunk: string): PtyParserResult {
    if (stream === "stderr") {
      return { events: [createStderrEvent(chunk)] };
    }

    this.buffer += chunk;
    const events = [createAgentMessageEvent(context, chunk)];

    for (const edit of parseAiderEditBlocks(this.buffer)) {
      const key = createEditKey(edit);
      if (this.emittedEditKeys.has(key)) {
        continue;
      }
      this.emittedEditKeys.add(key);

      const toolCallId = `aider-edit-${this.nextToolCallIndex++}`;
      events.push(
        createToolCallEvent(context, toolCallId, `Aider edited ${edit.path}`, {
          parser: this.id,
          path: edit.path,
          format: edit.format,
        }),
        createToolCallUpdateEvent(context, toolCallId, "completed", {
          parser: this.id,
          path: edit.path,
          format: edit.format,
          oldText: edit.oldText ?? null,
          newText: edit.newText,
        })
      );
    }

    return { events };
  }

  onExit(_context: PtyParserContext, exitCode: number, signal?: number): PtyParserResult {
    return {
      done: true,
      result: {
        stopReason: exitCode === 0 ? "end_turn" : "error",
        exitCode,
        signal,
        error: exitCode === 0 ? undefined : `Aider PTY exited with code ${exitCode}`,
      },
    };
  }

  onCancel(_context: PtyParserContext): PtyParserResult {
    return {
      done: true,
      result: { stopReason: "cancelled" },
    };
  }
}

export function parseAiderEditBlocks(output: string): AiderEditBlock[] {
  const editBlocks: AiderEditBlock[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const path = lines[index].trim();
    if (!isPotentialFilePath(path)) {
      continue;
    }

    const nextLine = lines[index + 1]?.trimStart();
    if (!nextLine?.startsWith("```")) {
      continue;
    }

    const codeBlock = readCodeBlock(lines, index + 1);
    if (!codeBlock) {
      continue;
    }

    const editBlock = buildEditBlockFromPathAndCode(path, codeBlock.content);
    if (editBlock) {
      editBlocks.push(editBlock);
    }

    index = codeBlock.endLine;
  }

  for (const block of readFencedCodeBlocks(output)) {
    const normalizedLanguage = block.language.toLowerCase();
    if (normalizedLanguage === "diff" || normalizedLanguage === "udiff") {
      const editBlock = parseUnifiedDiff(block.content);
      if (editBlock) {
        editBlocks.push(editBlock);
      }
      continue;
    }

    const contentLines = block.content.split(/\r?\n/);
    const firstLine = contentLines[0]?.trim();
    if (firstLine && isPotentialFilePath(firstLine) && block.content.includes("<<<<<<< SEARCH")) {
      const editBlock = buildEditBlockFromPathAndCode(firstLine, contentLines.slice(1).join("\n"));
      if (editBlock) {
        editBlocks.push({ ...editBlock, format: "diff-fenced" });
      }
    }
  }

  return dedupeEditBlocks(editBlocks);
}

function readCodeBlock(
  lines: string[],
  fenceLineIndex: number
): { content: string; endLine: number } | null {
  const contentLines: string[] = [];

  for (let index = fenceLineIndex + 1; index < lines.length; index++) {
    if (lines[index].trimStart().startsWith("```")) {
      return {
        content: contentLines.join("\n"),
        endLine: index,
      };
    }

    contentLines.push(lines[index]);
  }

  return null;
}

function readFencedCodeBlocks(output: string): CodeSegment[] {
  const blocks: CodeSegment[] = [];
  const fencePattern = /^[ \t]*```([^\r\n]*)\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(output)) !== null) {
    blocks.push({
      language: match[1].trim(),
      content: match[2].replace(/\r?\n$/, ""),
    });
  }

  return blocks;
}

function buildEditBlockFromPathAndCode(path: string, content: string): AiderEditBlock | null {
  if (content.includes("<<<<<<< SEARCH")) {
    return parseSearchReplaceDiff(path, content);
  }

  return {
    format: "whole",
    path,
    newText: content,
  };
}

function parseSearchReplaceDiff(path: string, content: string): AiderEditBlock | null {
  const block = extractFirstSearchReplaceBlock(content);
  if (!block) {
    return null;
  }

  return {
    format: "diff",
    path,
    oldText: block.search,
    newText: block.replace,
  };
}

function extractFirstSearchReplaceBlock(
  content: string
): { search: string; replace: string } | null {
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== "<<<<<<< SEARCH") {
      continue;
    }

    const searchLines: string[] = [];
    const replaceLines: string[] = [];
    index += 1;

    while (index < lines.length && lines[index].trim() !== "=======") {
      searchLines.push(lines[index]);
      index += 1;
    }

    if (index >= lines.length) {
      return null;
    }
    index += 1;

    while (index < lines.length && lines[index].trim() !== ">>>>>>> REPLACE") {
      replaceLines.push(lines[index]);
      index += 1;
    }

    if (index >= lines.length) {
      return null;
    }

    return {
      search: searchLines.join("\n"),
      replace: replaceLines.join("\n"),
    };
  }

  return null;
}

function parseUnifiedDiff(content: string): AiderEditBlock | null {
  const lines = content.split(/\r?\n/);
  let path = "";
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      path = normalizeDiffPath(line.slice(4).trim());
      continue;
    }

    if (line.startsWith("+++ ")) {
      const nextPath = normalizeDiffPath(line.slice(4).trim());
      if (nextPath) {
        path = nextPath;
      }
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1));
    }
  }

  if (!path) {
    return null;
  }

  return {
    format: "udiff",
    path,
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
  };
}

function normalizeDiffPath(path: string): string {
  return path.replace(/^a\//, "").replace(/^b\//, "");
}

function isPotentialFilePath(value: string): boolean {
  if (!value || /\s/.test(value)) {
    return false;
  }

  if (
    value.includes("```") ||
    value.includes("<<<") ||
    value.includes(">>>") ||
    value.includes("===") ||
    value.startsWith("-") ||
    value.startsWith("+")
  ) {
    return false;
  }

  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(".") ||
    /^[a-zA-Z0-9_.-]+$/.test(value)
  );
}

function createEditKey(edit: AiderEditBlock): string {
  return [edit.format, edit.path, edit.oldText ?? "", edit.newText].join("\0");
}

function dedupeEditBlocks(editBlocks: AiderEditBlock[]): AiderEditBlock[] {
  const seen = new Set<string>();
  const result: AiderEditBlock[] = [];

  for (const edit of editBlocks) {
    const key = createEditKey(edit);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(edit);
  }

  return result;
}
