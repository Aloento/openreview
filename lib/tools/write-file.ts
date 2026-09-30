import { tool } from "ai";
import { z } from "zod";

import type { Workspace } from "@/lib/workspace";
import { writeWorkspaceFile } from "@/lib/workspace";

export const createWriteFileTool = (workspace: Workspace) =>
  tool({
    description:
      "Write content to a file in the workspace. Creates parent directories if needed.",
    execute: ({ content, path }) =>
      writeWorkspaceFile(workspace, path, content),
    inputSchema: z.object({
      content: z.string().describe("The content to write to the file"),
      path: z.string().describe("The path where the file should be written"),
    }),
  });
