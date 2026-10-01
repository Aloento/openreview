import { resolve } from "node:path";

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
    return {
      errorMessage: parseError(error),
      success: false,
    };
  }
};
