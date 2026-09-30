import { resolve } from "node:path";

import { createAgent } from "@/lib/agent";
import { parseError } from "@/lib/error";
import type { Workspace } from "@/lib/workspace";

import { discoverSkills } from "./discover-skills";
import type { ThreadMessage } from "./index";

export interface AgentResult {
  errorMessage?: string;
  success: boolean;
}

export const runAgent = async (
  workspace: Workspace,
  threadMessages: ThreadMessage[],
  threadId: string,
  prNumber: number,
  repoFullName: string,
  signal?: AbortSignal
): Promise<AgentResult> => {
  try {
    const skills = await discoverSkills([
      resolve(process.cwd(), ".agents/skills"),
    ]);

    const agent = createAgent(
      workspace,
      threadId,
      prNumber,
      repoFullName,
      skills
    );

    await agent.generate({
      abortSignal: signal,
      messages: threadMessages.map((msg) => ({
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
