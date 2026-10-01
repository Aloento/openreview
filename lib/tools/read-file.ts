import { tool } from "ai";
import { z } from "zod";

import type { Workspace } from "@/lib/workspace";
import { readWorkspaceFile } from "@/lib/workspace";

export const createReadFileTool = (workspace: Workspace) =>
  tool({
    description:
      "Read a file from the repository at the reviewed revision. Paths are relative to the repository root.",
    execute: ({ path }) => readWorkspaceFile(workspace, path),
    inputSchema: z.object({
      path: z.string().describe("Path of the file to read, e.g. src/app.ts"),
    }),
  });
