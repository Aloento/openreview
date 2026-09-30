import { tool } from "ai";
import { z } from "zod";

import type { ReviewContext } from "@/review/context";

export const createRequestChangesTool = (context: ReviewContext) =>
  tool({
    description:
      "Block the pull request: the change must not be merged until the problems you describe are fixed. Use this only for critical findings (correctness, security, data loss, broken builds). The review is submitted as a change request.",
    execute: ({ reason }) => {
      context.requestChanges = reason;

      return {
        note: "Recorded. The review is submitted as a change request.",
        success: true,
      };
    },
    inputSchema: z.object({
      reason: z
        .string()
        .describe("Why the change must not be merged, in one or two sentences"),
    }),
  });
