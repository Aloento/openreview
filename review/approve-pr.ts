import { getAppInfo, getInstallationOctokit } from "@/lib/github";

export interface ApprovalResult {
  approved: boolean;
  reason: string;
}

/**
 * Approves the pull request when the review agent did not request changes.
 *
 * Only reviews submitted by this app against the current head commit count, so
 * a change request raised for an older revision no longer blocks approval.
 */
export const approvePullRequest = async (
  repoFullName: string,
  prNumber: number
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

  const head = pull.head.sha;

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    per_page: 100,
    pull_number: prNumber,
    repo,
  });

  const botReviews = reviews.filter(
    (review) => review.user?.login === botLogin && review.commit_id === head
  );

  const requestedChanges = botReviews.filter(
    (review) => review.state === "CHANGES_REQUESTED"
  );

  if (requestedChanges.length > 0) {
    return { approved: false, reason: "Review requested changes" };
  }

  const alreadyApproved = botReviews.some(
    (review) => review.state === "APPROVED"
  );

  if (alreadyApproved) {
    return { approved: false, reason: `Already approved ${head.slice(0, 7)}` };
  }

  // No body: the review is an approval, the findings are posted separately.
  await octokit.rest.pulls.createReview({
    event: "APPROVE",
    owner,
    pull_number: prNumber,
    repo,
  });

  return { approved: true, reason: `Approved ${head.slice(0, 7)}` };
};
