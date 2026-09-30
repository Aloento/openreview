import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { parseError } from "@/lib/error";
import type { Workspace } from "@/lib/workspace";
import { runCommand } from "@/lib/workspace";

const runGit = async (
  workspace: Workspace,
  args: string[]
): Promise<void> => {
  const result = await runCommand("git", args, {
    cwd: workspace.dir,
    env: workspace.env,
    signal: workspace.signal,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
};

export const configureGit = async (
  workspace: Workspace,
  repoFullName: string,
  token: string
): Promise<void> => {
  const authenticatedUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;

  try {
    await runGit(workspace, ["remote", "set-url", "origin", authenticatedUrl]);
    // Never execute hooks that live in the pull request under review.
    await runGit(workspace, ["config", "--local", "core.hooksPath", "/dev/null"]);
    await runGit(workspace, ["config", "user.name", "openreview[bot]"]);
    await runGit(workspace, [
      "config",
      "user.email",
      "openreview[bot]@users.noreply.github.com",
    ]);
    // Keep installed dependencies out of `git add -A` even when the repository
    // itself does not ignore them.
    await appendFile(
      join(workspace.dir, ".git", "info", "exclude"),
      "node_modules/\n",
      "utf8"
    );
  } catch (error) {
    throw new Error(`Failed to configure git: ${parseError(error)}`, {
      cause: error,
    });
  }
};
