import { z } from "zod";

const schema = z.object({
  AUTO_APPROVE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  BASH_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.coerce.number().int().positive(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_WEBHOOK_SECRET: z.string().min(1),
  HOST: z.string().min(1).default("127.0.0.1"),
  LLM_API_KEY: z.string().min(1),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().min(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_AGENT_STEPS: z.coerce.number().int().positive().default(20),
  PORT: z.coerce.number().int().positive().default(8090),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  WORKSPACE_ROOT: z.string().min(1).default("workspaces"),
});

export type Env = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env: Env = parsed.data;
