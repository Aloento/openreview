import { resolve } from "node:path";

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

    await agent.generate({
      abortSignal: signal,
      messages: messages.map((msg) => ({
        content: msg.content,
        role: msg.role,
      })),
    });

    return { success: true };
  } catch (error) {
    return {
      errorMessage: parseError(error),
      success: false,
    };
  }
};
