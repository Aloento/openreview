import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseError } from "@/lib/error";
import type { Workspace } from "@/lib/workspace";
import { runBash } from "@/lib/workspace";

const LOCKFILE_COMMANDS = [
  { args: "install --frozen-lockfile", cmd: "bun", lockfile: "bun.lock" },
  { args: "install --frozen-lockfile", cmd: "pnpm", lockfile: "pnpm-lock.yaml" },
  { args: "install --frozen-lockfile", cmd: "yarn", lockfile: "yarn.lock" },
];

const detectInstallCommand = (
  workspace: Workspace
): { args: string; cmd: string } => {
  for (const { args, cmd, lockfile } of LOCKFILE_COMMANDS) {
    if (existsSync(join(workspace.dir, lockfile))) {
      return { args, cmd };
    }
  }

  return { args: "install", cmd: "npm" };
};

const hasProject = (workspace: Workspace): boolean =>
  existsSync(join(workspace.dir, "package.json"));

const ensurePackageManager = async (
  workspace: Workspace,
  cmd: string
): Promise<void> => {
  if (cmd === "npm") {
    return;
  }

  const result = await runBash(workspace, `command -v ${cmd}`);

  if (result.exitCode !== 0) {
    await runBash(workspace, `npm install -g ${cmd}`);
  }
};

export const installDependencies = async (
  workspace: Workspace
): Promise<void> => {
  if (!hasProject(workspace)) {
    return;
  }

  const { args, cmd } = detectInstallCommand(workspace);

  try {
    await ensurePackageManager(workspace, cmd);

    const result = await runBash(workspace, `${cmd} ${args}`);

    if (result.exitCode !== 0) {
      throw new Error(
        `${cmd} ${args} failed: ${result.stderr.trim() || result.stdout.trim()}`
      );
    }
  } catch (error) {
    throw new Error(
      `Failed to install project dependencies: ${parseError(error)}`,
      { cause: error }
    );
  }
};
