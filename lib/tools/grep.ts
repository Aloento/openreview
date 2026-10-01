import { tool } from "ai";
import { z } from "zod";

import type { Workspace } from "@/lib/workspace";
import { grepWorkspace } from "@/lib/workspace";

export const createGrepTool = (workspace: Workspace) =>
  tool({
    description:
      "Search the repository at the reviewed revision for a regular expression, case-insensitive. Returns the matching lines with file and line number. Use it to find callers, definitions and other context around the change.",
    execute: ({ pattern, path }) =>
      grepWorkspace(workspace, pattern, path).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
        matches: [],
        scannedFiles: 0,
        truncated: false,
      })),
    inputSchema: z.object({
      path: z
        .string()
        .optional()
        .describe("Optional directory to limit the search to"),
      pattern: z.string().describe("Regular expression to search for"),
    }),
  });
