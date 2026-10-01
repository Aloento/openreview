import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { env } from "@/lib/env";
import { parseError } from "@/lib/error";

export interface Workspace {
  dir: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Directories that are never worth reading: dependencies, build output and
 * version control metadata.
 */
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const MAX_LISTED_FILES = 2_000;
/**
 * Reading a large file costs far more than it helps: every character stays in
 * the context for the rest of the run, and a slow context makes every following
 * step slow too.
 */
const MAX_READ_BYTES = 40_000;
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_SCANNED_FILES = 5_000;

let rootDir: string | null = null;

const getRootDir = async (): Promise<string> => {
  if (!rootDir) {
    rootDir = resolve(env.WORKSPACE_ROOT);
    await mkdir(rootDir, { mode: 0o700, recursive: true });
  }

  return rootDir;
};

/**
 * Runs a command without a shell. Only ever used for the checkout below: the
 * agent has no way to run anything.
 */
const runCommand = (
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<CommandResult> =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      // Own process group, so a timeout kills everything the command started.
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killTree = (): void => {
      if (child.pid === undefined) {
        return;
      }

      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(killTree, options.timeoutMs ?? env.RUN_TIMEOUT_MS);

    options.signal?.addEventListener("abort", killTree, { once: true });

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", killTree);
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
      options.signal?.removeEventListener("abort", killTree);
      rejectPromise(error);
    });

    child.on("close", (exitCode, signal) => {
      finish({ exitCode: exitCode ?? (signal ? 124 : 0), stderr, stdout });
    });
  });

/**
 * Checks out the pull request branch so its files can be read. Nothing from the
 * checkout is ever executed: hooks are not part of a clone and are disabled
 * anyway, and this is the only subprocess the service ever starts.
 */
export const createWorkspace = async (
  repoFullName: string,
  token: string,
  branch: string,
  signal?: AbortSignal
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
        "--config",
        "core.hooksPath=/dev/null",
        remote,
        ".",
      ],
      { cwd: dir, signal, timeoutMs: env.RUN_TIMEOUT_MS }
    );

    if (clone.exitCode !== 0) {
      throw new Error(
        `git clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`
      );
    }
  } catch (error) {
    await removeWorkspace(dir);

    throw new Error(`Failed to check out the branch: ${parseError(error)}`, {
      cause: error,
    });
  }

  return { dir, signal };
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
  const root = resolve(dir);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);

  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error(`Path escapes the repository: ${path}`);
  }

  return target;
};

export const readWorkspaceFile = async (
  workspace: Workspace,
  path: string
): Promise<{ content: string; truncated: boolean }> => {
  const target = resolveWorkspacePath(workspace.dir, path);
  const info = await stat(target).catch(() => null);

  if (!info) {
    throw new Error(`File not found: ${path}`);
  }

  if (!info.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }

  const content = await readFile(target, "utf8");
  const truncated = content.length > MAX_READ_BYTES;

  return {
    content: truncated
      ? `${content.slice(0, MAX_READ_BYTES)}\n[truncated]`
      : content,
    truncated,
  };
};

interface WalkState {
  files: number;
}

const walk = async (
  dir: string,
  onFile: (path: string) => void | Promise<void>,
  state: WalkState
): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (state.files >= MAX_LISTED_FILES) {
      return;
    }

    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      await walk(full, onFile, state);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.files += 1;
    await onFile(full);
  }
};

export const listWorkspaceFiles = async (
  workspace: Workspace
): Promise<{ files: string[]; truncated: boolean }> => {
  const state: WalkState = { files: 0 };
  const files: string[] = [];

  await walk(
    workspace.dir,
    (path) => {
      files.push(relative(workspace.dir, path));
    },
    state
  );

  return { files: files.sort(), truncated: state.files >= MAX_LISTED_FILES };
};

export interface GrepMatch {
  line: number;
  path: string;
  text: string;
}

/**
 * Plain-text search over the checkout, done in process: the agent has no shell,
 * so this is how it looks for a symbol.
 */
export const grepWorkspace = async (
  workspace: Workspace,
  pattern: string,
  pathPrefix?: string
): Promise<{ matches: GrepMatch[]; scannedFiles: number; truncated: boolean }> => {
  const regex = new RegExp(pattern, "i");
  const base = pathPrefix
    ? resolveWorkspacePath(workspace.dir, pathPrefix)
    : workspace.dir;

  const state: WalkState = { files: 0 };
  const matches: GrepMatch[] = [];
  let scanned = 0;
  let truncated = false;

  await walk(
    base,
    async (path) => {
      if (truncated || scanned >= MAX_GREP_SCANNED_FILES) {
        truncated = true;
        return;
      }

      const info = await stat(path).catch(() => null);

      if (!info || info.size > MAX_GREP_FILE_BYTES) {
        return;
      }

      scanned += 1;

      const content = await readFile(path, "utf8").catch(() => null);

      // Binary content would waste the whole budget on one file.
      if (content === null || content.includes("\u0000")) {
        return;
      }

      const lines = content.split("\n");

      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) {
          continue;
        }

        matches.push({
          line: index + 1,
          path: relative(workspace.dir, path),
          text: line.trim().slice(0, 200),
        });

        if (matches.length >= MAX_GREP_MATCHES) {
          truncated = true;
          return;
        }
      }
    },
    state
  );

  return { matches, scannedFiles: scanned, truncated };
};
