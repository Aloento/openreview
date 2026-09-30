import { parseError } from "@/lib/error";
import type { Workspace } from "@/lib/workspace";
import { runCommand } from "@/lib/workspace";

export const hasUncommittedChanges = async (
  workspace: Workspace
): Promise<boolean> => {
  const result = await runCommand("git", ["status", "--porcelain"], {
    cwd: workspace.dir,
    env: workspace.env,
    signal: workspace.signal,
  }).catch((error: unknown) => {
    throw new Error(
      `[hasUncommittedChanges] Failed to check git status: ${parseError(error)}`
    );
  });

  return Boolean(result.stdout.trim());
};
