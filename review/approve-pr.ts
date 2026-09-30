import { getAppInfo, getInstallationOctokit } from "@/lib/github";

export interface ApprovalResult {
  approved: boolean;
  reason: string;
}

/**
 * Approves the pull request when the review agent did not request changes.
 *
 * The decision is per run, not per commit: GitHub moves the commit a review
 * points at forward when the branch gets new commits, so an earlier change
 * request cannot be recognised by comparing commits. A change request raised
 * during this run blocks the approval, and a previous approval is not repeated.
 */
export const approvePullRequest = async (
  repoFullName: string,
  prNumber: number,
  runStartedAt: Date
): Promise<ApprovalResult> => {
  const [owner, repo] = repoFullName.split("/");
  const octokit = await getInstallationOctokit();
  const { slug } = await getAppInfo();
  const botLogin = `${slug}[bot]`;

  const { data: pull } = await octokit.rest.pulls.get({
    owner,
    pull_number: prNumber,
    repo,
  });

  if (pull.state !== "open") {
    return { approved: false, reason: `Pull request is ${pull.state}` };
  }

  if (pull.draft) {
    return { approved: false, reason: "Pull request is a draft" };
  }

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    per_page: 100,
    pull_number: prNumber,
    repo,
  });

  const botReviews = reviews.filter(
    (review) => review.user?.login === botLogin
  );

  const requestedChanges = botReviews.some(
    (review) =>
      review.state === "CHANGES_REQUESTED" &&
      review.submitted_at !== undefined &&
      new Date(review.submitted_at) >= runStartedAt
  );

  if (requestedChanges) {
    return { approved: false, reason: "Review requested changes" };
  }

  if (botReviews.at(-1)?.state === "APPROVED") {
    return { approved: false, reason: "Already approved" };
  }

  // No body: the review is an approval, the findings are posted separately.
  await octokit.rest.pulls.createReview({
    event: "APPROVE",
    owner,
    pull_number: pull.number,
    repo,
  });

  return { approved: true, reason: `Approved ${pull.head.sha.slice(0, 7)}` };
};
