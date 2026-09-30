import { parseError } from "@/lib/error";
import type { Workspace } from "@/lib/workspace";
import { runCommand } from "@/lib/workspace";

export const commitAndPush = async (
  workspace: Workspace,
  message: string,
  branchName?: string
): Promise<void> => {
  const options = { cwd: workspace.dir, env: workspace.env };

  try {
    await runCommand("git", ["add", "-A"], options);

    const commit = await runCommand(
      "git",
      ["commit", "--no-verify", "-m", message],
      options
    );

    if (commit.exitCode !== 0) {
      throw new Error(
        `Commit failed with exit code ${commit.exitCode}: ${(
          commit.stderr || commit.stdout
        ).trim()}`
      );
    }

    const args = branchName ? ["push", "origin", branchName] : ["push"];
    const push = await runCommand("git", args, options);

    if (push.exitCode !== 0) {
      throw new Error(
        `Git push failed with exit code ${push.exitCode}: ${(
          push.stderr || push.stdout
        ).trim()}`
      );
    }
  } catch (error) {
    throw new Error(`[commitAndPush] ${parseError(error)}`, { cause: error });
  }
};
