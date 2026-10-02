import { resolve } from "node:path";

import { ToolChoiceViolationError } from "ai";
import type { ModelMessage } from "ai";

import { createAgent } from "@/lib/agent";
import { parseError } from "@/lib/error";
import type { PullRequestRef } from "@/lib/tools/pull-request";
import type { Workspace } from "@/lib/workspace";
import type { ReviewContext } from "@/review/context";

import { discoverSkills } from "./discover-skills";
import type { ThreadMessage } from "./index";

export interface AgentResult {
  errorMessage?: string;
  success: boolean;
}

/**
 * The gateway does not always honour `tool_choice: required`: it can answer
 * with plain text instead of the submitReview call, which the SDK surfaces as
 * a ToolChoiceViolationError. The error carries the model's content, so the
 * review text can still be recovered and published instead of failing the run.
 */
const recoverReviewText = (error: unknown): string | undefined => {
  if (!ToolChoiceViolationError.isInstance(error)) {
    return undefined;
  }

  const text = error.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
};

export const runAgent = async (
  workspace: Workspace,
  context: ReviewContext,
  pullRequest: PullRequestRef,
  messages: ThreadMessage[],
  signal?: AbortSignal
): Promise<AgentResult> => {
  try {
    const skills = await discoverSkills([
      resolve(process.cwd(), ".agents/skills"),
    ]);

    const agent = createAgent(workspace, context, pullRequest, skills);

    const input: ModelMessage[] = messages.map((msg) => ({
      content: msg.content,
      role: msg.role,
    }));

    const result = await agent.generate({ abortSignal: signal, messages: input });

    if (context.body) {
      return { success: true };
    }

    // The turn ended without the review being submitted. Give the model one
    // more turn with only submitReview available, so nothing it says elsewhere
    // can be mistaken for the review.
    console.log("[agent] no review submitted yet, asking for it");

    const history: ModelMessage[] = [
      ...input,
      ...result.steps.flatMap(
        (step) => step.response.messages as ModelMessage[]
      ),
    ];

    const verdictAgent = createAgent(
      workspace,
      context,
      pullRequest,
      skills,
      true
    );

    await verdictAgent.generate({
      abortSignal: signal,
      messages: [
        ...history,
        {
          content:
            "You have not submitted the review. Do it now with the submitReview tool: put the complete report in the body (findings grouped by severity, file and line references, concrete fixes) and set the verdict to request_changes if the change must not be merged, otherwise approve.",
          role: "user",
        },
      ],
    });

    return { success: true };
  } catch (error) {
    const recovered = recoverReviewText(error);

    if (recovered !== undefined) {
      // The model answered with text instead of the submitReview call. Publish
      // it as the review body; without a verdict the pipeline treats it as a
      // comment rather than an approval.
      context.body = recovered;
      console.log("[agent] recovered review text from a tool-choice violation");
      return { success: true };
    }

    return {
      errorMessage: parseError(error),
      success: false,
    };
  }
};
