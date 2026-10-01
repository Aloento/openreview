import { tool } from "ai";
import type { Octokit } from "octokit";
import { z } from "zod";

const MAX_PATCH_CHARS = 3_000;
const MAX_TOTAL_PATCH_CHARS = 60_000;

export interface PullRequestRef {
  octokit: Octokit;
  owner: string;
  prNumber: number;
  repo: string;
}

/**
 * Pull request metadata and the changed files, with their diffs. This replaces
 * the `gh pr view` / `gh pr diff` commands the agent used to run.
 */
export const createPullRequestTool = (ref: PullRequestRef) =>
  tool({
    description:
      "Fetch this pull request: title, description, branch, and every changed file with its patch. This is the primary source of truth for the review.",
    execute: async () => {
      const [pull, files] = await Promise.all([
        ref.octokit.rest.pulls.get({
          owner: ref.owner,
          pull_number: ref.prNumber,
          repo: ref.repo,
        }),
        ref.octokit.paginate(ref.octokit.rest.pulls.listFiles, {
          owner: ref.owner,
          per_page: 100,
          pull_number: ref.prNumber,
          repo: ref.repo,
        }),
      ]);

      let budget = MAX_TOTAL_PATCH_CHARS;

      const changedFiles = files.map((file) => {
        const patch = file.patch ?? "";
        let included = "";

        if (patch.length <= MAX_PATCH_CHARS && patch.length <= budget) {
          included = patch;
        } else if (budget > 0) {
          included = `${patch.slice(0, Math.min(MAX_PATCH_CHARS, budget))}\n[patch truncated]`;
        }

        budget -= included.length;

        return {
          additions: file.additions,
          changes: file.changes,
          deletions: file.deletions,
          filename: file.filename,
          patch: included || "[patch omitted: read the file instead]",
          previous_filename: file.previous_filename,
          status: file.status,
        };
      });

      return {
        base: pull.data.base.ref,
        body: pull.data.body?.slice(0, 8_000) ?? "",
        changedFiles,
        draft: pull.data.draft,
        head: pull.data.head.ref,
        headSha: pull.data.head.sha,
        state: pull.data.state,
        stats: {
          additions: pull.data.additions,
          changedFiles: pull.data.changed_files,
          deletions: pull.data.deletions,
        },
        title: pull.data.title,
      };
    },
    inputSchema: z.object({}),
  });

/**
 * CI status for the reviewed revision. The agent cannot run the project's
 * tooling, so this is how it learns what the checks said.
 */
export const createChecksTool = (ref: PullRequestRef) =>
  tool({
    description:
      "List the CI checks and their conclusions for this pull request's head commit.",
    execute: async () => {
      const { data: pull } = await ref.octokit.rest.pulls.get({
        owner: ref.owner,
        pull_number: ref.prNumber,
        repo: ref.repo,
      });

      const { data } = await ref.octokit.rest.checks.listForRef({
        owner: ref.owner,
        ref: pull.head.sha,
        repo: ref.repo,
      });

      const runs = data.check_runs.slice(0, 50).map((run) => ({
        conclusion: run.conclusion,
        name: run.name,
        status: run.status,
        summary: run.output?.summary?.slice(0, 500),
      }));

      const { data: statuses } = await ref.octokit.rest.repos.getCombinedStatusForRef(
        {
          owner: ref.owner,
          ref: pull.head.sha,
          repo: ref.repo,
        }
      );

      return {
        commitStatuses: statuses.statuses.map((status) => ({
          context: status.context,
          description: status.description,
          state: status.state,
        })),
        overallState: statuses.state,
        runs,
      };
    },
    inputSchema: z.object({}),
  });
