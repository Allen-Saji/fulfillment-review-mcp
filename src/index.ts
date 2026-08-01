import { loadConfig } from "./config.js";
import { createHttpApplication } from "./http.js";
import { openReviewCaseStore } from "./infrastructure/sqlite-review-case-store.js";
import { createSyntheticCommerceSource } from "./infrastructure/synthetic-commerce.js";
import { createLogger } from "./logger.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const reviewCaseStore = openReviewCaseStore(config.databasePath);
const application = createHttpApplication({
  config,
  commerceSource: createSyntheticCommerceSource(),
  reviewCaseStore,
  logger,
});

application.server.once("error", (error) => {
  logger.error("server_start_failed", {
    errorName: error.name,
  });
  reviewCaseStore.close();
  process.exitCode = 1;
});

application.server.listen(config.port, config.host, () => {
  logger.info("server_started", {
    host: config.host,
    port: config.port,
  });
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("server_stopping", { signal });
  try {
    await application.close();
    logger.info("server_stopped");
    process.exitCode = 0;
  } catch (error) {
    logger.error("server_stop_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
