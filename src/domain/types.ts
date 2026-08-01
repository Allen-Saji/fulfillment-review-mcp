import { z } from "zod";

const idSchema = z.string().min(1).max(64);
const skuSchema = z.string().regex(/^SKU-[A-Z0-9-]{1,32}$/);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const moneySchema = z
  .object({
    currency: z.literal("INR"),
    amountMinor: z.number().int().nonnegative(),
  })
  .strict();

export const moneyDeltaSchema = z
  .object({
    currency: z.literal("INR"),
    amountMinor: z.number().int(),
  })
  .strict();

export const quantitySchema = z
  .object({
    sku: skuSchema,
    quantity: z.number().int().positive(),
  })
  .strict();

export const inventoryQuantitySchema = z
  .object({
    sku: skuSchema,
    quantity: z.number().int().nonnegative(),
  })
  .strict();

export const orderSchema = z
  .object({
    id: idSchema,
    status: z.enum(["PARTIAL_FULFILLMENT_HOLD", "READY_TO_FULFILL"]),
    currency: z.literal("INR"),
    promisedDeliveryDate: isoDateSchema,
    assignedWarehouseId: idSchema,
    currentShippingCost: moneySchema,
    lines: z
      .array(
        z
          .object({
            sku: skuSchema,
            name: z.string().min(1).max(120),
            quantity: z.number().int().positive(),
            unitPrice: moneySchema,
          })
          .strict(),
      )
      .min(1),
    sourceUpdatedAt: isoDateTimeSchema,
  })
  .strict();

export const reservationSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    version: z.string().min(1).max(32),
    state: z.enum(["PARTIALLY_RESERVED", "RESERVED"]),
    warehouseId: idSchema,
    lines: z
      .array(
        z
          .object({
            sku: skuSchema,
            quantity: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
    sourceUpdatedAt: isoDateTimeSchema,
  })
  .strict();

export const holdRecordSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    code: z.literal("INSUFFICIENT_ASSIGNED_WAREHOUSE_STOCK"),
    state: z.literal("OPEN"),
    sourceUpdatedAt: isoDateTimeSchema,
  })
  .strict();

export const warehouseInventorySchema = z
  .object({
    warehouseId: idSchema,
    warehouseName: z.string().min(1).max(120),
    available: z.array(inventoryQuantitySchema).min(1),
    sourceUpdatedAt: isoDateTimeSchema,
  })
  .strict();

export const shippingQuoteSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    warehouseId: idSchema,
    purpose: z.enum(["FULL_ORDER", "SPLIT_LEG"]),
    items: z.array(quantitySchema).min(1),
    estimatedDeliveryDate: isoDateSchema,
    cost: moneySchema,
    sourceUpdatedAt: isoDateTimeSchema,
  })
  .strict();

export const splitShipmentSupportSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    supported: z.boolean(),
    quoteIds: z.tuple([idSchema, idSchema]),
    sourceUpdatedAt: isoDateTimeSchema,
  })
  .strict();

export const sourceSnapshotSchema = z
  .object({
    capturedAt: isoDateTimeSchema,
    order: orderSchema,
    reservation: reservationSchema,
    hold: holdRecordSchema,
    warehouses: z.array(warehouseInventorySchema).min(1),
    shippingQuotes: z.array(shippingQuoteSchema),
    splitShipmentSupport: z.array(splitShipmentSupportSchema),
  })
  .strict();

export const missingLineSchema = z
  .object({
    sku: skuSchema,
    orderedQuantity: z.number().int().positive(),
    reservedQuantity: z.number().int().nonnegative(),
    missingQuantity: z.number().int().positive(),
  })
  .strict();

export const holdEvidenceSchema = z
  .object({
    holdId: idSchema,
    code: z.literal("INSUFFICIENT_ASSIGNED_WAREHOUSE_STOCK"),
    assignedWarehouseId: idSchema,
    missingLines: z.array(missingLineSchema).min(1),
    summary: z.string().min(1).max(500),
  })
  .strict();

export const investigationResultSchema = z
  .object({
    orderId: idSchema,
    status: z.literal("PARTIAL_FULFILLMENT_HOLD"),
    evidenceVersion: z.string().regex(/^[a-f0-9]{64}$/),
    sourceSnapshot: sourceSnapshotSchema,
    holdEvidence: holdEvidenceSchema,
  })
  .strict();

export const fulfillmentLegSchema = z
  .object({
    quoteId: idSchema,
    warehouseId: idSchema,
    items: z.array(quantitySchema).min(1),
    estimatedDeliveryDate: isoDateSchema,
    shippingCost: moneySchema,
  })
  .strict();

export const fulfillmentOptionSchema = z
  .object({
    optionId: z.string().regex(/^OPT-[A-F0-9]{12}$/),
    kind: z.enum(["single_warehouse", "split_shipment"]),
    legs: z.array(fulfillmentLegSchema).min(1).max(2),
    estimatedFinalDeliveryDate: isoDateSchema,
    deliveryDateEffect: z
      .object({
        daysFromPromisedDate: z.number().int(),
        description: z.string().min(1).max(200),
      })
      .strict(),
    totalShippingCost: moneySchema,
    shippingCostEffect: z
      .object({
        difference: moneyDeltaSchema,
        description: z.string().min(1).max(200),
      })
      .strict(),
    tradeoffs: z.array(z.string().min(1).max(240)).length(2),
    sourceReferences: z.array(idSchema).min(2),
  })
  .strict();

export const unavailableCandidateSchema = z
  .object({
    candidateId: idSchema,
    reason: z.enum([
      "INSUFFICIENT_INVENTORY",
      "INCOMPLETE_ORDER_COVERAGE",
      "MISSING_QUOTE",
      "SPLIT_NOT_SUPPORTED",
      "INVALID_SPLIT_CONFIGURATION",
    ]),
    detail: z.string().min(1).max(240),
  })
  .strict();

export const fulfillmentPreviewSchema = z
  .object({
    orderId: idSchema,
    evidenceVersion: z.string().regex(/^[a-f0-9]{64}$/),
    currentPlanBaseline: z
      .object({
        promisedDeliveryDate: isoDateSchema,
        shippingCost: moneySchema,
      })
      .strict(),
    availableOptions: z.array(fulfillmentOptionSchema),
    unavailableCandidateReasons: z.array(unavailableCandidateSchema),
    decisionOwner: z.literal("human_reviewer"),
  })
  .strict();

export const reviewCaseSchema = z
  .object({
    id: z.uuid(),
    workflowVersion: z.literal("1"),
    status: z.literal("PENDING_HUMAN_REVIEW"),
    orderId: idSchema,
    evidenceVersion: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: isoDateTimeSchema,
    investigation: investigationResultSchema,
    preview: fulfillmentPreviewSchema,
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;
export type Quantity = z.infer<typeof quantitySchema>;
export type Order = z.infer<typeof orderSchema>;
export type Reservation = z.infer<typeof reservationSchema>;
export type HoldRecord = z.infer<typeof holdRecordSchema>;
export type WarehouseInventory = z.infer<typeof warehouseInventorySchema>;
export type ShippingQuote = z.infer<typeof shippingQuoteSchema>;
export type SplitShipmentSupport = z.infer<typeof splitShipmentSupportSchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type InvestigationResult = z.infer<typeof investigationResultSchema>;
export type FulfillmentLeg = z.infer<typeof fulfillmentLegSchema>;
export type FulfillmentOption = z.infer<typeof fulfillmentOptionSchema>;
export type UnavailableCandidate = z.infer<typeof unavailableCandidateSchema>;
export type FulfillmentPreview = z.infer<typeof fulfillmentPreviewSchema>;
export type ReviewCase = z.infer<typeof reviewCaseSchema>;
export type ReviewCaseDraft = Omit<ReviewCase, "id" | "createdAt">;
