import { z } from "zod";

import {
  fulfillmentPreviewSchema,
  investigationResultSchema,
  reviewCaseSchema,
} from "../domain/types.js";

export const orderIdSchema = z
  .string()
  .regex(/^ORD-[A-Z0-9-]{1,32}$/)
  .max(36);

export const evidenceVersionSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const investigateInputSchema = z
  .object({
    orderId: orderIdSchema,
  })
  .strict();

export const previewInputSchema = z
  .object({
    orderId: orderIdSchema,
    evidenceVersion: evidenceVersionSchema,
  })
  .strict();

export const createEscalationInputSchema = previewInputSchema;

export const getEscalationInputSchema = z
  .object({
    reviewCaseId: z.uuid(),
  })
  .strict();

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
