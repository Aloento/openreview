import { env } from "@/lib/env";
import { parseError } from "@/lib/error";
import { getInstallationOctokit } from "@/lib/github";
import type { Workspace } from "@/lib/workspace";
import { createWorkspace, removeWorkspace } from "@/lib/workspace";

import { addPRComment } from "./add-pr-comment";
import { buildReviewBody, createReviewContext } from "./context";
import { getGitHubToken } from "./get-github-token";
import { runAgent } from "./run-agent";
import { submitReview } from "./submit-review";
import type { ReviewDecision } from "./submit-review";

export interface ThreadMessage {
  content: string;
  role: "assistant" | "user";
}

export interface ReviewParams {
  baseBranch: string;
  headSha: string;
  messages: ThreadMessage[];
  prBranch: string;
  prNumber: number;
  repoFullName: string;
  threadId: string;
  trigger: "auto" | "mention";
}

export const AUTO_REVIEW_INSTRUCTION = `Review the changes in this pull request and submit your review with the submitReview tool.

Read the code; this environment cannot run builds or tests. Report findings by severity and set the verdict: request_changes for anything that must be fixed before merging, approve otherwise.`;

const runReview = async (params: ReviewParams): Promise<void> => {
  const {
    baseBranch: _baseBranch,
    messages,
    prBranch,
    prNumber,
    repoFullName,
    threadId,
  } = params;

  const token = await getGitHubToken();
  const octokit = await getInstallationOctokit();
  const [owner, repo] = repoFullName.split("/");

  // Only verdicts produced after this point belong to this run.
  const runStartedAt = new Date();
  const context = createReviewContext();

  // One signal bounds the whole run: the checkout and the agent both stop.
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

    const agentResult = await runAgent(
      workspace,
      context,
      { octokit, owner, prNumber, repo },
      messages,
      controller.signal
    );

    if (!agentResult.success) {
      throw new Error(agentResult.errorMessage ?? "Agent failed to run");
    }

    const body = buildReviewBody(context);

    // A review with no text means the agent reported nothing, which is not a
    // reason to approve.
    if (body.length === 0) {
      console.log(
        `[review] skipped review for ${repoFullName}#${prNumber}: the agent produced no findings`
      );
      return;
    }

    const decision: ReviewDecision = context.verdict === "request_changes"
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

    // The review is the only output channel, so a review that could not be
    // submitted as a verdict is still published as a review body rather than a
    // separate comment — unless it is already on the pull request.
    if (!(result.submitted || result.duplicate || decision === "comment")) {
      const retry = await submitReview(
        repoFullName,
        prNumber,
        "comment",
        body,
        runStartedAt
      );

      console.log(
        `[review] ${retry.submitted ? "submitted" : "dropped"} the findings for ${repoFullName}#${prNumber}: ${retry.reason}`
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
const scheduled = new Map<string, string>();

/**
 * Reviews are serialised: one checkout and one agent run at a time keeps the
 * host within its CPU, memory and API rate limits.
 *
 * The same revision is only reviewed once: a comment that mentions the bot also
 * raises a `pull_request` event, and a review that is already queued for that
 * commit wins. A different commit still gets its own review.
 */
export const enqueueReview = (params: ReviewParams): Promise<void> => {
  const key = `${params.repoFullName}#${params.prNumber}`;

  if (scheduled.get(key) === params.headSha) {
    console.log(
      `[review] dropping the ${params.trigger} trigger for ${key} @ ${params.headSha.slice(0, 7)}: that revision is already queued`
    );

    return Promise.resolve();
  }

  scheduled.set(key, params.headSha);
  queued += 1;
  console.log(
    `[review] queued ${key} @ ${params.headSha.slice(0, 7)} (${params.trigger}), ${queued} pending`
  );

  const run = queue.then(async () => {
    queued -= 1;
    const startedAt = Date.now();

    try {
      await runReview(params);
      console.log(
        `[review] finished ${key} in ${Math.round((Date.now() - startedAt) / 1000)}s`
      );
    } catch (error) {
      console.error(`[review] failed ${key}: ${parseError(error)}`);
    } finally {
      if (scheduled.get(key) === params.headSha) {
        scheduled.delete(key);
      }
    }
  });

  queue = run;

  return run;
};
