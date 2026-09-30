import { tool } from "ai";
import { z } from "zod";

import { env } from "@/lib/env";
import type { Workspace } from "@/lib/workspace";
import { runBash } from "@/lib/workspace";

export const createBashTool = (workspace: Workspace) =>
  tool({
    description: [
      "Execute bash commands in the workspace.",
      "",
      "WORKING DIRECTORY: the checked out repository root",
      "All commands execute from this directory. Use relative paths from here.",
      "",
      "Common operations:",
      "  ls -la              # List files with details",
      "  find . -name '*.ts' # Find files by pattern",
      "  grep -r 'pattern' . # Search file contents",
      "  cat <file>          # View file contents",
    ].join("\n"),
    execute: async ({ command }) => {
      const startedAt = Date.now();

      console.log(`[agent] bash: ${command.slice(0, 200)}`);

      const result = await runBash(workspace, command, {
        timeoutMs: env.BASH_TIMEOUT_MS,
      });

      console.log(
        `[agent] bash exit ${result.exitCode} in ${Math.round((Date.now() - startedAt) / 1000)}s`
      );

      return {
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
    inputSchema: z.object({
      command: z.string().describe("The bash command to execute"),
    }),
  });
