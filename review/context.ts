/**
 * Collects what the agent produced during one review. The text written with the
 * reply tool becomes the body of the single review the pipeline submits, and a
 * change request made with the requestChanges tool decides its verdict.
 */
export interface ReviewContext {
  requestChanges?: string;
  replies: string[];
}

export const createReviewContext = (): ReviewContext => ({ replies: [] });

export const buildReviewBody = (context: ReviewContext): string => {
  const parts = [...context.replies];

  if (context.requestChanges) {
    parts.push(`**Requesting changes:** ${context.requestChanges}`);
  }

  return parts.join("\n\n---\n\n").trim();
};
