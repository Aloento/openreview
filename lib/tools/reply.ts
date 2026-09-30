import { tool } from "ai";
import { z } from "zod";

import type { ReviewContext } from "@/review/context";

export const createReplyTool = (context: ReviewContext) =>
  tool({
    description:
      "Write your review for the pull request. The text is published as a single review, so write it as the review you would leave: findings, severity and concrete fixes. Call it at least once.",
    execute: ({ body }) => {
      context.replies.push(body);

      return {
        note: "Recorded. It is submitted as the review when the run ends.",
        success: true,
      };
    },
    inputSchema: z.object({
      body: z.string().describe("The markdown-formatted review body"),
    }),
  });
