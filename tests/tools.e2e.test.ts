import { describe, expect, it } from "vitest";

import type { CommerceSource } from "../src/domain/evidence.js";
import { AppError, normalizeError } from "../src/errors.js";
import {
  createEscalationOutputSchema,
  getEscalationOutputSchema,
  investigateOutputSchema,
  previewOutputSchema,
} from "../src/tools/schemas.js";
import { TOOL_NAMES } from "../src/tools/register-tools.js";
import {
  createSyntheticCommerceSource,
  SYNTHETIC_ORDER_ID,
} from "../src/infrastructure/synthetic-commerce.js";
import { startTestApplication } from "./helpers.js";

function textContent(result: {
  content: { type: string; text?: string }[];
}): string {
  return result.content
    .flatMap((entry) => (entry.type === "text" ? [entry.text ?? ""] : []))
    .join("\n");
}

describe("MCP fulfillment workflow", () => {
  it("exposes exactly the four approved tools and annotations", async () => {
    const running = await startTestApplication();
    try {
      const result = await running.client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual(
        [...TOOL_NAMES].sort(),
      );
      const createTool = result.tools.find(
        (tool) => tool.name === "create_human_review_escalation",
      );
      expect(createTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      for (const tool of result.tools.filter(
        (candidate) => candidate.name !== "create_human_review_escalation",
      )) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    } finally {
      await running.close();
    }
  });

  it("completes the four-tool workflow and preserves idempotency", async () => {
    const commerceSource = createSyntheticCommerceSource();
    const commerceStateBefore = commerceSource.getSnapshot(SYNTHETIC_ORDER_ID);
    const running = await startTestApplication({ commerceSource });
    try {
      const investigationCall = await running.client.callTool({
        name: "investigate_fulfillment_hold",
        arguments: { orderId: SYNTHETIC_ORDER_ID },
      });
      const investigation = investigateOutputSchema.parse(
        investigationCall.structuredContent,
      );

      const previewCall = await running.client.callTool({
        name: "preview_fulfillment_options",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: investigation.evidenceVersion,
        },
      });
      const preview = previewOutputSchema.parse(previewCall.structuredContent);
      expect(preview.availableOptions).toHaveLength(2);

      const firstCreateCall = await running.client.callTool({
        name: "create_human_review_escalation",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: investigation.evidenceVersion,
        },
      });
      const firstCreate = createEscalationOutputSchema.parse(
        firstCreateCall.structuredContent,
      );
      expect(firstCreate.created).toBe(true);

      const secondCreateCall = await running.client.callTool({
        name: "create_human_review_escalation",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: investigation.evidenceVersion,
        },
      });
      const secondCreate = createEscalationOutputSchema.parse(
        secondCreateCall.structuredContent,
      );
      expect(secondCreate).toMatchObject({
        reviewCaseId: firstCreate.reviewCaseId,
        created: false,
      });

      const getCall = await running.client.callTool({
        name: "get_human_review_escalation",
        arguments: { reviewCaseId: firstCreate.reviewCaseId },
      });
      const reviewCase = getEscalationOutputSchema.parse(
        getCall.structuredContent,
      );
      expect(reviewCase.investigation).toEqual(investigation);
      expect(reviewCase.preview).toEqual(preview);
      expect(textContent(getCall)).toContain("PENDING_HUMAN_REVIEW");
      expect(commerceSource.getSnapshot(SYNTHETIC_ORDER_ID)).toEqual(
        commerceStateBefore,
      );
    } finally {
      await running.close();
    }
  });

  it("returns recoverable tool errors for stale evidence and missing records", async () => {
    const running = await startTestApplication();
    try {
      const stalePreview = await running.client.callTool({
        name: "preview_fulfillment_options",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: "a".repeat(64),
        },
      });
      expect(stalePreview.isError).toBe(true);
      expect(textContent(stalePreview)).toContain("EVIDENCE_VERSION_MISMATCH");

      const staleCreate = await running.client.callTool({
        name: "create_human_review_escalation",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: "a".repeat(64),
        },
      });
      expect(staleCreate.isError).toBe(true);
      expect(textContent(staleCreate)).toContain("EVIDENCE_VERSION_MISMATCH");

      const missingOrder = await running.client.callTool({
        name: "investigate_fulfillment_hold",
        arguments: { orderId: "ORD-404" },
      });
      expect(missingOrder.isError).toBe(true);
      expect(textContent(missingOrder)).toContain("ORDER_NOT_FOUND");

      const missingCase = await running.client.callTool({
        name: "get_human_review_escalation",
        arguments: {
          reviewCaseId: "22222222-2222-4222-8222-222222222222",
        },
      });
      expect(missingCase.isError).toBe(true);
      expect(textContent(missingCase)).toContain("REVIEW_CASE_NOT_FOUND");
      expect(textContent(missingCase)).not.toContain("/home/");
    } finally {
      await running.close();
    }
  });

  it("does not allow arbitrary escalation evidence or selection fields", async () => {
    const running = await startTestApplication();
    try {
      const result = await running.client.callTool({
        name: "create_human_review_escalation",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: "a".repeat(64),
          selectedOption: "attacker-choice",
        },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("Unrecognized key");
    } finally {
      await running.close();
    }
  });

  it("sanitizes unexpected source failures", async () => {
    const throwingSource: CommerceSource = {
      getSnapshot() {
        throw new Error("sensitive internal path /private/data");
      },
    };
    const running = await startTestApplication({
      commerceSource: throwingSource,
    });
    try {
      const result = await running.client.callTool({
        name: "investigate_fulfillment_hold",
        arguments: { orderId: SYNTHETIC_ORDER_ID },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("INTERNAL_ERROR");
      expect(textContent(result)).not.toContain("/private/data");
      expect(running.logs).toContain("error:tool_call_failed");
    } finally {
      await running.close();
    }
  });

  it("maps closed escalation storage to a safe tool error", async () => {
    const running = await startTestApplication();
    try {
      const investigationCall = await running.client.callTool({
        name: "investigate_fulfillment_hold",
        arguments: { orderId: SYNTHETIC_ORDER_ID },
      });
      const investigation = investigateOutputSchema.parse(
        investigationCall.structuredContent,
      );
      running.store.close();
      const result = await running.client.callTool({
        name: "create_human_review_escalation",
        arguments: {
          orderId: SYNTHETIC_ORDER_ID,
          evidenceVersion: investigation.evidenceVersion,
        },
      });
      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain("STORAGE_UNAVAILABLE");
    } finally {
      await running.close();
    }
  });
});

describe("error normalization", () => {
  it("preserves application errors", () => {
    const original = new AppError("INVALID_REQUEST", "invalid");
    expect(normalizeError(original)).toBe(original);
  });

  it("sanitizes Error and non-Error values", () => {
    expect(normalizeError(new Error("secret")).code).toBe("INTERNAL_ERROR");
    expect(normalizeError("secret").code).toBe("INTERNAL_ERROR");
  });
});
