import { env } from "@/lib/env";
import { parseError } from "@/lib/error";
import type { Workspace } from "@/lib/workspace";
import { createWorkspace, removeWorkspace } from "@/lib/workspace";

import { addPRComment } from "./add-pr-comment";
import { checkPushAccess } from "./check-push-access";
import { commitAndPush } from "./commit-and-push";
import { configureGit } from "./configure-git";
import { buildReviewBody, createReviewContext } from "./context";
import { getGitHubToken } from "./get-github-token";
import { hasUncommittedChanges } from "./has-uncommitted-changes";
import { installDependencies } from "./install-dependencies";
import { runAgent } from "./run-agent";
import { submitReview } from "./submit-review";
import type { ReviewDecision } from "./submit-review";

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

export const AUTO_REVIEW_INSTRUCTION = `Review the changes in this pull request and write your findings with the reply tool. Group them by severity: critical, warning, suggestion.

If a critical problem must be fixed before this change can be merged, also call requestChanges with the reason. Warnings and suggestions only go in the review.

Work from the diff and the files in the workspace. Do not install toolchains and do not run repository-wide builds or tests.`;

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

Please ensure the OpenReview app has access to this repository and branch.`
    );

    throw new Error(pushAccess.reason ?? "Push access denied");
  }

  const token = await getGitHubToken();

  // Only verdicts produced after this point belong to this run.
  const runStartedAt = new Date();
  const context = createReviewContext();

  // One signal bounds the whole run: the agent stops and every command it
  // started is killed, including anything those commands spawned.
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("review timed out")),
    env.RUN_TIMEOUT_MS
  );

  let workspace: Workspace | null = null;

  try {
    workspace = await createWorkspace(
      repoFullName,
      token,
      prBranch,
      controller.signal
    );

    await installDependencies(workspace);
    await configureGit(workspace, repoFullName, token);

    const agentResult = await runAgent(
      workspace,
      context,
      messages,
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

    const body = buildReviewBody(context);
    const decision: ReviewDecision = context.requestChanges
      ? "request_changes"
      : env.AUTO_APPROVE
        ? "approve"
        : "comment";

    const result = await submitReview(
      repoFullName,
      prNumber,
      decision,
      body,
      runStartedAt
    );

    console.log(
      `[review] ${result.submitted ? "submitted" : "skipped"} review for ${repoFullName}#${prNumber}: ${result.reason}`
    );

    // The review is the only output channel, so findings that could not be
    // submitted as one are posted as a comment instead of being dropped.
    if (!(result.submitted || body.length === 0)) {
      await addPRComment(threadId, body);
    }
  } catch (error) {
    try {
      await addPRComment(
        threadId,
        `## Error

An error occurred while processing your request:

\`\`\`
${parseError(error)}
\`\`\``
      );
    } catch {
      // Ignore comment failure
    }

    throw error;
  } finally {
    clearTimeout(timeout);

    if (workspace) {
      await removeWorkspace(workspace.dir);
    }
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
