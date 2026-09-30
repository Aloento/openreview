import { env } from "@/lib/env";
import { parseError } from "@/lib/error";
import {
  createWorkspace,
  removeWorkspace,
} from "@/lib/workspace";

import { addPRComment } from "./add-pr-comment";
import { approvePullRequest } from "./approve-pr";
import { checkPushAccess } from "./check-push-access";
import { commitAndPush } from "./commit-and-push";
import { configureGit } from "./configure-git";
import { getGitHubToken } from "./get-github-token";
import { hasUncommittedChanges } from "./has-uncommitted-changes";
import { installDependencies } from "./install-dependencies";
import { runAgent } from "./run-agent";

export interface ThreadMessage {
  content: string;
  role: "assistant" | "user";
}

export interface ReviewParams {
  baseBranch: string;
  messages: ThreadMessage[];
  prBranch: string;
  prNumber: number;
  repoFullName: string;
  threadId: string;
  trigger: "auto" | "mention";
}

const FOOTER = `\n\n---\n*Powered by [OpenReview](https://github.com/vercel-labs/openreview)*`;

export const AUTO_REVIEW_INSTRUCTION = `Review the changes in this pull request and report what you find. Group findings by severity: critical, warning, suggestion.

If you find a critical problem that must be fixed before this change can be merged, submit a change request with \`gh pr review --request-changes --body "..."\` explaining why. Warnings and suggestions are reported in your reply only.

Work from the diff and the files in the workspace. Do not install toolchains and do not run repository-wide builds or tests.

Always post your findings with the reply tool. Do not approve the pull request.`;

const runReview = async (params: ReviewParams): Promise<void> => {
  const {
    baseBranch: _baseBranch,
    messages,
    prBranch,
    prNumber,
    repoFullName,
    threadId,
  } = params;

  const pushAccess = await checkPushAccess(repoFullName, prBranch);

  if (!pushAccess.canPush) {
    await addPRComment(
      threadId,
      `## Skipped

Unable to access this branch: ${pushAccess.reason}

Please ensure the OpenReview app has access to this repository and branch.${FOOTER}`
    );

    throw new Error(pushAccess.reason ?? "Push access denied");
  }

  const token = await getGitHubToken();

  // One signal bounds the whole run: the agent stops and every command it
  // started is killed, including anything those commands spawned.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("review timed out")),
    env.RUN_TIMEOUT_MS
  );

  const workspace = await createWorkspace(
    repoFullName,
    token,
    prBranch,
    controller.signal
  ).catch(async (error: unknown) => {
    clearTimeout(timeout);
    throw error;
  });

  try {
    await installDependencies(workspace);
    await configureGit(workspace, repoFullName, token);

    const agentResult = await runAgent(
      workspace,
      messages,
      threadId,
      prNumber,
      repoFullName,
      controller.signal
    );

    if (!agentResult.success) {
      throw new Error(agentResult.errorMessage ?? "Agent failed to run");
    }

    const changed = await hasUncommittedChanges(workspace);

    if (changed) {
      await commitAndPush(workspace, "openreview: apply changes", prBranch);
    }

    if (env.AUTO_APPROVE) {
      const approval = await approvePullRequest(repoFullName, prNumber);
      console.log(
        `[review] auto approve for ${repoFullName}#${prNumber}: ${approval.approved ? "approved" : "skipped"} (${approval.reason})`
      );
    }
  } catch (error) {
    try {
      await addPRComment(
        threadId,
        `## Error

An error occurred while processing your request:

\`\`\`
${parseError(error)}
\`\`\`${FOOTER}`
      );
    } catch {
      // Ignore comment failure
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    await removeWorkspace(workspace.dir);
  }
};

let queue: Promise<void> = Promise.resolve();
let queued = 0;

/**
 * Reviews are serialised: one workspace and one agent run at a time keeps the
 * host within its CPU, memory and API rate limits.
 */
export const enqueueReview = (params: ReviewParams): Promise<void> => {
  queued += 1;
  console.log(
    `[review] queued ${params.repoFullName}#${params.prNumber} (${params.trigger}), ${queued} pending`
  );

  const run = queue.then(async () => {
    queued -= 1;
    const startedAt = Date.now();

    try {
      await runReview(params);
      console.log(
        `[review] finished ${params.repoFullName}#${params.prNumber} in ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
    } catch (error) {
      console.error(
        `[review] failed ${params.repoFullName}#${params.prNumber}: ${parseError(error)}`
      );
    }
  });

  queue = run;

  return run;
};
