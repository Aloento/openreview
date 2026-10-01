/**
 * The single review a run may produce. The agent writes it with the
 * submitReview tool, and the pipeline submits it as one review on the pull
 * request: an approval or a change request, either way carrying the findings.
 * There is no other output channel.
 */
export interface ReviewContext {
  body?: string;
  verdict?: "approve" | "request_changes";
}

export const createReviewContext = (): ReviewContext => ({});

export const buildReviewBody = (context: ReviewContext): string =>
  context.body?.trim() ?? "";
