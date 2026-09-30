import { tool } from "ai";
import { z } from "zod";

import { addPRComment } from "@/review/add-pr-comment";

export const createReplyTool = (threadId: string) =>
  tool({
    description:
      "Post a comment on the pull request. Use this to share your findings, ask questions, or report results.",
    execute: async ({ body }) => {
      await addPRComment(threadId, body);

      return { success: true };
    },
    inputSchema: z.object({
      body: z.string().describe("The markdown-formatted comment body to post"),
    }),
  });
