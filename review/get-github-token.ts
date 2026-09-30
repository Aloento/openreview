import { parseError } from "@/lib/error";
import { getInstallationOctokit } from "@/lib/github";

export const getGitHubToken = async (): Promise<string> => {
  const octokit = await getInstallationOctokit().catch((error: unknown) => {
    throw new Error(
      `[getGitHubToken] Failed to get GitHub client: ${parseError(error)}`
    );
  });

  const auth = await (
    octokit.auth({ type: "installation" }) as Promise<{ token: string }>
  ).catch((error: unknown) => {
    throw new Error(`Failed to get GitHub token: ${parseError(error)}`);
  });

  return auth.token;
};
