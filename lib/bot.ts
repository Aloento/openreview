import type { GitHubRawMessage } from "@chat-adapter/github";
import { createGitHubAdapter } from "@chat-adapter/github";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, emoji } from "chat";
import type { Message, Thread } from "chat";

import { env } from "@/lib/env";
import { getAppInfo, getInstallationOctokit } from "@/lib/github";
import { AUTO_REVIEW_INSTRUCTION, enqueueReview } from "@/review";
import type { ThreadMessage } from "@/review";

interface ThreadState {
  baseBranch: string;
  prBranch: string;
  prNumber: number;
  repoFullName: string;
}

interface PullRequestEventPayload {
  action: string;
  installation?: { id: number };
  pull_request: {
    base: { ref: string };
    draft?: boolean;
    head: { ref: string };
    number: number;
    user?: { login: string } | null;
  };
  repository: { full_name: string };
  sender?: { login: string };
}

const REVIEW_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

const collectMessages = async (
  thread: Thread<unknown, unknown>
): Promise<ThreadMessage[]> => {
  const messages: ThreadMessage[] = [];

  for await (const msg of thread.allMessages) {
    messages.push({
      content: msg.text,
      role: msg.author.isMe ? "assistant" : "user",
    });
  }

  return messages;
};

let botInstance: Chat | null = null;

const handleMention = async (thread: Thread, message: Message) => {
  await thread.adapter.addReaction(thread.id, message.id, emoji.eyes);

  const messages = await collectMessages(thread);
  const raw = message.raw as GitHubRawMessage;

  const repoFullName = raw.repository.full_name;
  const { prNumber } = raw;

  const octokit = await getInstallationOctokit();
  const [owner, repo] = repoFullName.split("/");

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    pull_number: prNumber,
    repo,
  });

  await thread.setState({
    baseBranch: pr.base.ref,
    prBranch: pr.head.ref,
    prNumber,
    repoFullName,
  } satisfies ThreadState);

  await enqueueReview({
    baseBranch: pr.base.ref,
    messages,
    prBranch: pr.head.ref,
    prNumber,
    repoFullName,
    threadId: thread.id,
    trigger: "mention",
  });
};

export const getBot = (): Promise<Chat> => initBot();

const initBot = async (): Promise<Chat> => {
  if (botInstance) {
    return botInstance;
  }

  if (
    !env.GITHUB_APP_ID ||
    !env.GITHUB_APP_INSTALLATION_ID ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.GITHUB_APP_WEBHOOK_SECRET
  ) {
    throw new Error("Missing required GitHub App environment variables");
  }

  const appInfo = await getAppInfo();

  botInstance = new Chat({
    adapters: {
      github: createGitHubAdapter({
        appId: env.GITHUB_APP_ID,
        botUserId: appInfo.botUserId,
        installationId: env.GITHUB_APP_INSTALLATION_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"),
        userName: appInfo.slug,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
      }),
    },
    logger: env.LOG_LEVEL,
    state: createMemoryState(),
    userName: appInfo.slug,
  });

  botInstance.onNewMention(handleMention);

  botInstance.onSubscribedMessage(async (thread, message) => {
    if (!message.isMention) {
      return;
    }

    await handleMention(thread, message);
  });

  return botInstance;
};

/**
 * Reviews pull requests automatically when they are opened or updated.
 *
 * The GitHub adapter only listens for comments, so `pull_request` deliveries
 * are handled here. Events sent by the app itself are ignored to keep the
 * commit the agent pushed from starting another review.
 */
export const handlePullRequestEvent = async (
  payload: PullRequestEventPayload
): Promise<void> => {
  const { action, installation, pull_request: pull, repository, sender } = payload;

  if (!REVIEW_ACTIONS.has(action)) {
    return;
  }

  if (installation?.id && installation.id !== env.GITHUB_APP_INSTALLATION_ID) {
    return;
  }

  const { slug } = await getAppInfo();
  const botLogin = `${slug}[bot]`;

  if (sender?.login === botLogin || pull.user?.login === botLogin) {
    return;
  }

  if (pull.draft && action !== "ready_for_review") {
    return;
  }

  const repoFullName = repository.full_name;

  await enqueueReview({
    baseBranch: pull.base.ref,
    messages: [{ content: AUTO_REVIEW_INSTRUCTION, role: "user" }],
    prBranch: pull.head.ref,
    prNumber: pull.number,
    repoFullName,
    threadId: `github:${repoFullName}:${pull.number}`,
    trigger: "auto",
  });
};
