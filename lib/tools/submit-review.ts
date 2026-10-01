import { tool } from "ai";
import { z } from "zod";

import type { ReviewContext } from "@/review/context";

/**
 * The only way the agent can publish anything. Its body becomes the review on
 * the pull request, so an approval always carries the findings and a change
 * request always explains itself; nothing is posted separately.
 */
export const createSubmitReviewTool = (context: ReviewContext) =>
  tool({
    description:
      "Submit the review for this pull request. This is the only output: the body is published as the review, so write the complete report there (findings grouped by severity, file and line references, concrete fixes). Call it exactly once, when you are done reviewing. Use verdict 'request_changes' when the change must not be merged (correctness bugs, security holes, data loss, broken builds), 'approve' when it is fine.",
    execute: ({ body, verdict }) => {
      context.body = body;
      context.verdict = verdict;

      return {
        note:
          verdict === "approve"
            ? "Recorded. The review is submitted as an approval carrying this text."
            : "Recorded. The review is submitted as a change request carrying this text.",
        success: true,
      };
    },
    inputSchema: z.object({
      body: z
        .string()
        .describe(
          "The complete review, in markdown: summary, findings by severity, and fixes"
        ),
      verdict: z
        .enum(["approve", "request_changes"])
        .describe("Whether the pull request may be merged as it is"),
    }),
  });
