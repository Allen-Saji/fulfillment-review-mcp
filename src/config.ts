import { z } from "zod";

const commaSeparatedHosts = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().min(1)).min(1));

const configSchema = z
  .object({
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_PATH: z.string().min(1).default("./data/review-cases.sqlite"),
    ALLOWED_HOSTS: commaSeparatedHosts.default(["localhost", "127.0.0.1"]),
    ALLOWED_ORIGIN_HOSTS: commaSeparatedHosts.default([
      "localhost",
      "127.0.0.1",
    ]),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .loose();

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  allowedHosts: string[];
  allowedOriginHosts: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.parse(environment);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    allowedHosts: parsed.ALLOWED_HOSTS,
    allowedOriginHosts: parsed.ALLOWED_ORIGIN_HOSTS,
    logLevel: parsed.LOG_LEVEL,
  };
}
