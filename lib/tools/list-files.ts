import { tool } from "ai";
import { z } from "zod";

import type { Workspace } from "@/lib/workspace";
import { listWorkspaceFiles } from "@/lib/workspace";

export const createListFilesTool = (workspace: Workspace) =>
  tool({
    description:
      "List files in the repository at the reviewed revision. Dependencies, build output and .git are excluded. Use it to understand the layout before reading files.",
    execute: () => listWorkspaceFiles(workspace),
    inputSchema: z.object({}),
  });
