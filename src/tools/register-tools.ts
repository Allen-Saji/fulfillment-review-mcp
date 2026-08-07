import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";

import { calculateFulfillmentOptions } from "../domain/options.js";
import {
  assertEvidenceVersion,
  buildReviewCaseDraft,
} from "../domain/review-case.js";
import {
  investigateFulfillmentHold,
  type CommerceSource,
} from "../domain/evidence.js";
import { normalizeError } from "../errors.js";
import type { ReviewCaseStore } from "../infrastructure/review-case-store.js";
import type { Logger } from "../logger.js";
import {
  createEscalationInputSchema,
  createEscalationOutputSchema,
  getEscalationInputSchema,
  getEscalationOutputSchema,
  investigateInputSchema,
  investigateOutputSchema,
  previewInputSchema,
  previewOutputSchema,
} from "./schemas.js";

export const TOOL_NAMES = [
  "investigate_fulfillment_hold",
  "preview_fulfillment_options",
  "create_human_review_escalation",
  "get_human_review_escalation",
] as const;

export interface ToolDependencies {
  commerceSource: CommerceSource;
  reviewCaseStore: ReviewCaseStore;
  logger: Logger;
}

function errorResult(
  error: unknown,
  toolName: (typeof TOOL_NAMES)[number],
  logger: Logger,
  startedAt: number,
): CallToolResult {
  const normalized = normalizeError(error);
  const fields = {
    tool: toolName,
    errorCode: normalized.code,
    durationMs: Math.round(performance.now() - startedAt),
  };
  if (
    normalized.code === "INTERNAL_ERROR" ||
    normalized.code === "STORAGE_UNAVAILABLE"
  ) {
    logger.error("tool_call_failed", fields);
  } else {
    logger.warn("tool_call_rejected", fields);
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${normalized.code}: ${normalized.message}`,
      },
    ],
  };
}

function logSuccess(
  toolName: (typeof TOOL_NAMES)[number],
  logger: Logger,
  startedAt: number,
): void {
  logger.info("tool_call_succeeded", {
    tool: toolName,
    durationMs: Math.round(performance.now() - startedAt),
  });
}

export function registerFulfillmentTools(
  server: McpServer,
  dependencies: ToolDependencies,
): void {
  server.registerTool(
    "investigate_fulfillment_hold",
    {
      title: "Investigate fulfillment hold",
      description:
        "Read the order, reservation, warehouse inventory, and hold evidence without changing commerce state. Call this before previewing options.",
      inputSchema: investigateInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ orderId }) => {
      const startedAt = performance.now();
      try {
        const result = investigateOutputSchema.parse(
          investigateFulfillmentHold(dependencies.commerceSource, orderId),
        );
        logSuccess(
          "investigate_fulfillment_hold",
          dependencies.logger,
          startedAt,
        );
        return {
          content: [
            {
              type: "text",
              text: `${result.orderId} is on a partial-fulfillment hold. ${result.holdEvidence.summary} Evidence version: ${result.evidenceVersion}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(
          error,
          "investigate_fulfillment_hold",
          dependencies.logger,
          startedAt,
        );
      }
    },
  );

  server.registerTool(
    "preview_fulfillment_options",
    {
      title: "Preview fulfillment options",
      description:
        "Return source-supported fulfillment options with both delivery-date and shipping-cost effects. Does not rank, recommend, select, or execute an option.",
      inputSchema: previewInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ orderId, evidenceVersion }) => {
      const startedAt = performance.now();
      try {
        const investigation = investigateFulfillmentHold(
          dependencies.commerceSource,
          orderId,
        );
        assertEvidenceVersion(evidenceVersion, investigation.evidenceVersion);
        const result = previewOutputSchema.parse(
          calculateFulfillmentOptions(investigation),
        );
        logSuccess(
          "preview_fulfillment_options",
          dependencies.logger,
          startedAt,
        );
        return {
          content: [
            {
              type: "text",
              text: `${String(result.availableOptions.length)} source-supported option(s) are available. Each includes delivery-date and shipping-cost effects. A human reviewer must make the decision.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(
          error,
          "preview_fulfillment_options",
          dependencies.logger,
          startedAt,
        );
      }
    },
  );

  server.registerTool(
    "create_human_review_escalation",
    {
      title: "Create human-review escalation",
      description:
        "Create or return one immutable review case for an order and evidence version. This is the only write; it does not change inventory, reservations, routing, or shipments.",
      inputSchema: createEscalationInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ orderId, evidenceVersion }) => {
      const startedAt = performance.now();
      try {
        const investigation = investigateFulfillmentHold(
          dependencies.commerceSource,
          orderId,
        );
        assertEvidenceVersion(evidenceVersion, investigation.evidenceVersion);
        const preview = calculateFulfillmentOptions(investigation);
        const { reviewCase, created } =
          await dependencies.reviewCaseStore.createOrGet(
            buildReviewCaseDraft(investigation, preview),
          );
        const result = createEscalationOutputSchema.parse({
          reviewCaseId: reviewCase.id,
          created,
          orderId: reviewCase.orderId,
          evidenceVersion: reviewCase.evidenceVersion,
          status: reviewCase.status,
          createdAt: reviewCase.createdAt,
        });
        logSuccess(
          "create_human_review_escalation",
          dependencies.logger,
          startedAt,
        );
        return {
          content: [
            {
              type: "text",
              text: `${created ? "Created" : "Returned existing"} review case ${reviewCase.id}. Status: ${reviewCase.status}.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(
          error,
          "create_human_review_escalation",
          dependencies.logger,
          startedAt,
        );
      }
    },
  );

  server.registerTool(
    "get_human_review_escalation",
    {
      title: "Get human-review escalation",
      description:
        "Read back the exact immutable review case, including its evidence snapshot, options, and tradeoffs.",
      inputSchema: getEscalationInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reviewCaseId }) => {
      const startedAt = performance.now();
      try {
        const result = getEscalationOutputSchema.parse(
          await dependencies.reviewCaseStore.get(reviewCaseId),
        );
        logSuccess(
          "get_human_review_escalation",
          dependencies.logger,
          startedAt,
        );
        return {
          content: [
            {
              type: "text",
              text: `Review case ${result.id} is ${result.status} and contains ${String(result.preview.availableOptions.length)} option(s) for human review.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return errorResult(
          error,
          "get_human_review_escalation",
          dependencies.logger,
          startedAt,
        );
      }
    },
  );
}
