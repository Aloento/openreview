import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { env } from "@/lib/env";
import { parseError } from "@/lib/error";

export interface Workspace {
  dir: string;
  /**
   * Environment exposed to every command run inside the workspace. Holds the
   * installation token so `git` and `gh` are authenticated without writing
   * credentials to disk.
   */
  env: Record<string, string>;
  id: string;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

let rootDir: string | null = null;

const getRootDir = async (): Promise<string> => {
  if (!rootDir) {
    rootDir = resolve(env.WORKSPACE_ROOT);
    await mkdir(rootDir, { mode: 0o700, recursive: true });
  }

  return rootDir;
};

/**
 * Runs a command without a shell and resolves with its exit code and output.
 * Never rejects on a non-zero exit code so callers can decide how to react.
 */
export const runCommand = (
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<CommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? env.BASH_TIMEOUT_MS);

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on("close", (exitCode, signal) => {
      finish({
        exitCode: exitCode ?? (signal ? 124 : 0),
        stderr,
        stdout,
      });
    });
  });

export const runBash = (
  workspace: Workspace,
  command: string,
  options: Omit<RunOptions, "cwd" | "env"> = {}
): Promise<CommandResult> =>
  runCommand("bash", ["-c", command], {
    ...options,
    cwd: workspace.dir,
    env: workspace.env,
  });

/**
 * Clones the PR branch into a private temporary directory. The authenticated
 * remote is kept in the workspace so the agent can push commits back.
 */
export const createWorkspace = async (
  repoFullName: string,
  token: string,
  branch: string
): Promise<Workspace> => {
  const root = await getRootDir();
  const dir = await mkdtemp(join(root, "run-"));

  const remote = `https://x-access-token:${token}@github.com/${repoFullName}.git`;

  try {
    const clone = await runCommand(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--single-branch",
        "--branch",
        branch,
        remote,
        ".",
      ],
      { cwd: dir, timeoutMs: env.RUN_TIMEOUT_MS }
    );

    if (clone.exitCode !== 0) {
      throw new Error(
        `git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`
      );
    }
  } catch (error) {
    await removeWorkspace(dir);

    throw new Error(`Failed to create workspace: ${parseError(error)}`, {
      cause: error,
    });
  }

  return { dir, env: { GH_TOKEN: token, GITHUB_TOKEN: token }, id: dir };
};

export const removeWorkspace = async (dir: string): Promise<void> => {
  const root = await getRootDir();
  const target = resolve(dir);

  // Guard against a stray value removing something outside the workspace root.
  if (!target.startsWith(`${root}/`) && target !== root) {
    return;
  }

  await rm(target, { force: true, recursive: true }).catch(() => undefined);
};

export const removeStaleWorkspaces = async (): Promise<void> => {
  const root = await getRootDir();
  const entries = await readdir(root).catch(() => [] as string[]);

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith("run-"))
      .map((entry) => removeWorkspace(join(root, entry)))
  );
};

const resolveWorkspacePath = (dir: string, path: string): string => {
  const target = isAbsolute(path) ? resolve(path) : resolve(dir, path);

  if (target !== dir && !target.startsWith(`${resolve(dir)}/`)) {
    throw new Error(`Path escapes the workspace: ${path}`);
  }

  return target;
};

export const readWorkspaceFile = async (
  workspace: Workspace,
  path: string
): Promise<{ content: string }> => {
  const target = resolveWorkspacePath(workspace.dir, path);

  try {
    return { content: await readFile(target, "utf8") };
  } catch {
    throw new Error(`File not found: ${path}`);
  }
};

export const writeWorkspaceFile = async (
  workspace: Workspace,
  path: string,
  content: string
): Promise<{ success: boolean }> => {
  const target = resolveWorkspacePath(workspace.dir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");

  return { success: true };
};
