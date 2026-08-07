import { z } from "zod";

import {
  fulfillmentPreviewSchema,
  investigationResultSchema,
  reviewCaseSchema,
} from "../domain/types.js";
import { SYNTHETIC_ORDER_ID } from "../infrastructure/synthetic-commerce.js";

const orderIdInputGuidance = `Order ID must start with ORD- and contain only uppercase letters, numbers, or hyphens. Omit orderId or use ${SYNTHETIC_ORDER_ID} for the hosted scenario.`;

export const orderIdSchema = z
  .string({ error: orderIdInputGuidance })
  .regex(/^ORD-[A-Z0-9-]{1,32}$/, orderIdInputGuidance)
  .max(36, orderIdInputGuidance);

const hostedOrderIdInputSchema = orderIdSchema
  .default(SYNTHETIC_ORDER_ID)
  .describe(
    `Hosted scenario order ID. Omit this field or use ${SYNTHETIC_ORDER_ID}.`,
  );

const evidenceVersionInputGuidance =
  "evidenceVersion must be the exact 64-character value returned by investigate_fulfillment_hold for the same order. Run that tool again and copy the returned value unchanged.";

export const evidenceVersionSchema = z
  .string({ error: evidenceVersionInputGuidance })
  .regex(/^[a-f0-9]{64}$/, evidenceVersionInputGuidance);

const evidenceVersionInputSchema = evidenceVersionSchema.describe(
  "Use the exact evidenceVersion returned by investigate_fulfillment_hold for the same order.",
);

const unsupportedInputGuidance =
  "Remove unsupported arguments and retry using only the fields shown in this tool's input schema.";

export const investigateInputSchema = z.strictObject(
  {
    orderId: hostedOrderIdInputSchema,
  },
  unsupportedInputGuidance,
);

export const previewInputSchema = z.strictObject(
  {
    orderId: hostedOrderIdInputSchema,
    evidenceVersion: evidenceVersionInputSchema,
  },
  unsupportedInputGuidance,
);

export const createEscalationInputSchema = previewInputSchema;

const reviewCaseIdInputGuidance =
  "reviewCaseId must be the exact UUID returned by create_human_review_escalation. Run that tool first and copy the returned value unchanged.";

export const getEscalationInputSchema = z.strictObject(
  {
    reviewCaseId: z
      .uuid(reviewCaseIdInputGuidance)
      .describe(
        "Use the exact reviewCaseId returned by create_human_review_escalation.",
      ),
  },
  unsupportedInputGuidance,
);

export const investigateOutputSchema = investigationResultSchema;
export const previewOutputSchema = fulfillmentPreviewSchema;

export const createEscalationOutputSchema = z
  .object({
    reviewCaseId: z.uuid(),
    created: z.boolean(),
    orderId: orderIdSchema,
    evidenceVersion: evidenceVersionSchema,
    status: z.literal("PENDING_HUMAN_REVIEW"),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const getEscalationOutputSchema = reviewCaseSchema;
