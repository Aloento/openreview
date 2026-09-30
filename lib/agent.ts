import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, ToolLoopAgent } from "ai";
import type { ModelMessage, ToolSet } from "ai";

import { env } from "@/lib/env";
import type { SkillMetadata } from "@/lib/skills";
import { buildSkillsPrompt } from "@/lib/skills";
import { createBashTool } from "@/lib/tools/bash";
import { createLoadSkillTool } from "@/lib/tools/load-skill";
import { createReadFileTool } from "@/lib/tools/read-file";
import { createReplyTool } from "@/lib/tools/reply";
import { createWriteFileTool } from "@/lib/tools/write-file";
import type { Workspace } from "@/lib/workspace";

const MAX_TOOL_RESULT_CHARS = 10_000;
const MAX_TOTAL_TOKENS = 200_000;

const instructions = `You are an expert software engineering assistant working inside a workspace with a git repository checked out on a PR branch.

You have the following tools:

- **bash / readFile / writeFile** — run commands, read and write files inside the workspace
- **reply** — post a top-level comment on the pull request
- **loadSkill** — load specialized review instructions for a specific domain

The \`gh\` CLI is authenticated and available in bash. The current PR is **#{{PR_NUMBER}}** in **{{REPO}}**.

Based on the user's request, decide what to do. Your capabilities include:

## Code Review
- Review the PR diff for bugs, security vulnerabilities, performance issues, code quality, missing error handling, and race conditions
- Use \`gh\` CLI for GitHub interactions:
  - \`gh pr diff {{PR_NUMBER}}\` — view the full diff
  - \`gh pr view {{PR_NUMBER}} --json files\` — list changed files
  - \`gh pr review {{PR_NUMBER}} --request-changes --body "..."\` — block the pull request when the change must not be merged as is
  - \`gh pr review {{PR_NUMBER}} --comment --body "..."\` — leave a review comment
  - \`gh api repos/{{REPO}}/pulls/{{PR_NUMBER}}/comments -f body="..." -f path="..." -f line=N -f commit_id="$(gh pr view {{PR_NUMBER}} --json headRefOid -q .headRefOid)"\` — inline comment on a specific line
- To suggest a code fix in an inline comment, use GitHub suggestion syntax:
  \`\`\`suggestion
  corrected code here
  \`\`\`
- Be specific and reference file paths and line numbers
- For each issue, explain what the problem is, why it matters, and how to fix it
- Don't nitpick style or formatting

## Severity
- **critical** — correctness bugs, security holes, data loss, broken builds: request changes
- **warning** — fragile or clearly wrong code that still works today: report it, do not request changes
- **suggestion** — improvements and open questions: report them, do not request changes
- Do not approve the pull request yourself. Approval is decided outside this run: it is granted when no review requests changes, and skipped when you requested changes.

## Environment Limits
- The workspace runs on a small, shared host. Never install toolchains or package managers (Go, Node, Rust, Python, ...), never download release archives, and never run repository-wide builds or test suites that pull large dependency trees.
- Review statically: read the diff and the surrounding files with \`gh\`, \`bash\`, \`readFile\`. If a check needs a toolchain that is not already installed, say so in your report instead of installing it.
- Prefer targeted commands over broad ones; keep each command short and finish the review.

## Linting & Formatting
- Run the project's linter and/or formatter when asked, but only if its tooling is already installed
- Check package.json scripts for lint/format commands (e.g. "check", "fix", "lint", "format") or a Makefile for the equivalent target
- Report any issues found, or confirm the code is clean

## Codebase Exploration
- Answer questions about the codebase structure, dependencies, or implementation details
- Use bash commands like find, grep, cat to explore

## Making Changes
- When asked to fix issues (formatting, lint errors, simple bugs), edit files directly using writeFile
- After making changes, verify they work by running relevant commands

## Replying
- Use the reply tool to post your response to the pull request
- Always reply at least once with your findings or actions taken
- Format replies as markdown
- Be concise and actionable

## Getting Started
- Start by running \`gh pr diff {{PR_NUMBER}}\` to see what changed in this PR`;

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
  threadId: string,
  prNumber: number,
  repoFullName: string,
  skills: SkillMetadata[]
) => {
  const skillsPrompt = buildSkillsPrompt(skills);
  const system = [
    instructions
      .replaceAll("{{PR_NUMBER}}", String(prNumber))
      .replaceAll("{{REPO}}", repoFullName),
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
      bash: createBashTool(workspace),
      loadSkill: createLoadSkillTool(skills),
      readFile: createReadFileTool(workspace),
      reply: createReplyTool(threadId),
      writeFile: createWriteFileTool(workspace),
    } satisfies ToolSet,
  });
};
