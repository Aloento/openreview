import { tool } from "ai";
import { z } from "zod";

import type { Workspace } from "@/lib/workspace";
import { readWorkspaceFile } from "@/lib/workspace";

export const createReadFileTool = (workspace: Workspace) =>
  tool({
    description: "Read the contents of a file from the workspace.",
    execute: ({ path }) => readWorkspaceFile(workspace, path),
    inputSchema: z.object({
      path: z.string().describe("The path to the file to read"),
    }),
  });
