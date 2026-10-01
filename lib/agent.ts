import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, ToolLoopAgent } from "ai";
import type { ModelMessage, ToolSet } from "ai";

import { env } from "@/lib/env";
import type { SkillMetadata } from "@/lib/skills";
import { buildSkillsPrompt } from "@/lib/skills";
import { createGrepTool } from "@/lib/tools/grep";
import { createListFilesTool } from "@/lib/tools/list-files";
import { createLoadSkillTool } from "@/lib/tools/load-skill";
import {
  createChecksTool,
  createPullRequestTool,
} from "@/lib/tools/pull-request";
import type { PullRequestRef } from "@/lib/tools/pull-request";
import { createReadFileTool } from "@/lib/tools/read-file";
import { createReplyTool } from "@/lib/tools/reply";
import { createRequestChangesTool } from "@/lib/tools/request-changes";
import type { Workspace } from "@/lib/workspace";
import type { ReviewContext } from "@/review/context";

const MAX_TOOL_RESULT_CHARS = 10_000;
const MAX_TOTAL_TOKENS = 200_000;

const instructions = `You are an expert software engineer reviewing a pull request. The current pull request is **#{{PR_NUMBER}}** in **{{REPO}}**.

You are read-only. The repository is checked out at the reviewed revision, but you have no shell, no package manager and no build tooling: you cannot execute the project's code, install dependencies or run its tests. Review by reading.

You have the following tools:

- **getPullRequest** — title, description and every changed file with its patch
- **getChecks** — CI check results for the head commit
- **listFiles**, **readFile**, **grep** — read the checkout: layout, file contents, and regex search
- **reply** — write your review
- **requestChanges** — block the pull request
- **loadSkill** — load specialized review instructions for a specific domain

## Code Review
- Review the diff for bugs, security vulnerabilities, performance issues, code quality, missing error handling, and race conditions
- Start with \`getPullRequest\`, then read the files around the change with \`readFile\` and \`grep\` to understand how the affected code is used
- Be specific and reference file paths and line numbers
- For each issue, explain what the problem is, why it matters, and how to fix it
- Don't nitpick style or formatting

## What you cannot check
- You cannot run the linter, the tests or a build. Read the CI results with \`getChecks\` instead, and if a change cannot be judged without executing it, say so in the review rather than guessing.

## Severity
- **critical** — correctness bugs, security holes, data loss, broken builds: call \`requestChanges\`
- **warning** — fragile or clearly wrong code that still works today: report it in your review
- **suggestion** — improvements and open questions: report them in your review

## Replying
- Use the reply tool to write your review. It is published as one review on the pull request, so write it as a single self-contained report: findings, severity and concrete fixes.
- Call it at least once. Several calls are concatenated into the same review.
- When the change must not be merged, call requestChanges with the reason. The review is then submitted as a change request instead of a comment.
- Be concise and actionable.`;

export const createModel = () =>
  createOpenAICompatible({
    apiKey: env.LLM_API_KEY,
    baseURL: env.LLM_BASE_URL,
    name: "litellm",
  }).chatModel(env.LLM_MODEL);

const trimToolResults = (messages: ModelMessage[]): ModelMessage[] =>
  messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }

    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result") {
          return part;
        }

        const text = JSON.stringify(part.output);

        if (text.length <= MAX_TOOL_RESULT_CHARS) {
          return part;
        }

        return {
          ...part,
          output: {
            type: "text" as const,
            value: `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n... (truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars)`,
          },
        };
      }),
    };
  });

export const createAgent = (
  workspace: Workspace,
  context: ReviewContext,
  pullRequest: PullRequestRef,
  skills: SkillMetadata[]
) => {
  const { owner, prNumber, repo } = pullRequest;
  const skillsPrompt = buildSkillsPrompt(skills);
  const system = [
    instructions
      .replaceAll("{{PR_NUMBER}}", String(prNumber))
      .replaceAll("{{REPO}}", `${owner}/${repo}`),
    skillsPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  return new ToolLoopAgent({
    instructions: system,
    model: createModel(),
    onStepFinish: (step) => {
      console.log(
        `[agent] step: ${step.usage.inputTokens ?? 0} in / ${step.usage.outputTokens ?? 0} out`
      );
    },
    prepareStep: ({ messages }) => ({
      messages: trimToolResults(messages as ModelMessage[]),
    }),
    stopWhen: [
      stepCountIs(env.MAX_AGENT_STEPS),
      ({ steps }) => {
        let totalTokens = 0;

        for (const step of steps) {
          totalTokens +=
            (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0);
        }

        return totalTokens > MAX_TOTAL_TOKENS;
      },
    ],
    tools: {
      getChecks: createChecksTool(pullRequest),
      getPullRequest: createPullRequestTool(pullRequest),
      grep: createGrepTool(workspace),
      listFiles: createListFilesTool(workspace),
      loadSkill: createLoadSkillTool(skills),
      readFile: createReadFileTool(workspace),
      reply: createReplyTool(context),
      requestChanges: createRequestChangesTool(context),
    } satisfies ToolSet,
  });
};
