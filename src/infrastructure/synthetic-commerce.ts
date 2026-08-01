import { sourceSnapshotSchema, type SourceSnapshot } from "../domain/types.js";
import type { CommerceSource } from "../domain/evidence.js";

export const SYNTHETIC_ORDER_ID = "ORD-1042";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

export function createSyntheticSnapshot(): SourceSnapshot {
  return sourceSnapshotSchema.parse({
    capturedAt: "2026-08-01T09:30:00.000Z",
    order: {
      id: SYNTHETIC_ORDER_ID,
      status: "PARTIAL_FULFILLMENT_HOLD",
      currency: "INR",
      promisedDeliveryDate: "2026-08-04",
      assignedWarehouseId: "WH-BLR-01",
      currentShippingCost: { currency: "INR", amountMinor: 12_000 },
      lines: [
        {
          sku: "SKU-AURORA-LAMP",
          name: "Aurora desk lamp",
          quantity: 2,
          unitPrice: { currency: "INR", amountMinor: 249_900 },
        },
        {
          sku: "SKU-WALNUT-STAND",
          name: "Walnut monitor stand",
          quantity: 1,
          unitPrice: { currency: "INR", amountMinor: 319_900 },
        },
      ],
      sourceUpdatedAt: "2026-08-01T09:20:00.000Z",
    },
    reservation: {
      id: "RES-1042",
      orderId: SYNTHETIC_ORDER_ID,
      version: "7",
      state: "PARTIALLY_RESERVED",
      warehouseId: "WH-BLR-01",
      lines: [
        { sku: "SKU-AURORA-LAMP", quantity: 2 },
        { sku: "SKU-WALNUT-STAND", quantity: 0 },
      ],
      sourceUpdatedAt: "2026-08-01T09:22:00.000Z",
    },
    hold: {
      id: "HOLD-1042",
      orderId: SYNTHETIC_ORDER_ID,
      code: "INSUFFICIENT_ASSIGNED_WAREHOUSE_STOCK",
      state: "OPEN",
      sourceUpdatedAt: "2026-08-01T09:23:00.000Z",
    },
    warehouses: [
      {
        warehouseId: "WH-BLR-01",
        warehouseName: "Bengaluru Central",
        available: [
          { sku: "SKU-AURORA-LAMP", quantity: 4 },
          { sku: "SKU-WALNUT-STAND", quantity: 0 },
        ],
        sourceUpdatedAt: "2026-08-01T09:25:00.000Z",
      },
      {
        warehouseId: "WH-HYD-01",
        warehouseName: "Hyderabad East",
        available: [
          { sku: "SKU-AURORA-LAMP", quantity: 1 },
          { sku: "SKU-WALNUT-STAND", quantity: 3 },
        ],
        sourceUpdatedAt: "2026-08-01T09:25:30.000Z",
      },
      {
        warehouseId: "WH-MUM-01",
        warehouseName: "Mumbai West",
        available: [
          { sku: "SKU-AURORA-LAMP", quantity: 5 },
          { sku: "SKU-WALNUT-STAND", quantity: 2 },
        ],
        sourceUpdatedAt: "2026-08-01T09:26:00.000Z",
      },
    ],
    shippingQuotes: [
      {
        id: "QUOTE-MUM-FULL",
        orderId: SYNTHETIC_ORDER_ID,
        warehouseId: "WH-MUM-01",
        purpose: "FULL_ORDER",
        items: [
          { sku: "SKU-AURORA-LAMP", quantity: 2 },
          { sku: "SKU-WALNUT-STAND", quantity: 1 },
        ],
        estimatedDeliveryDate: "2026-08-05",
        cost: { currency: "INR", amountMinor: 22_000 },
        sourceUpdatedAt: "2026-08-01T09:27:00.000Z",
      },
      {
        id: "QUOTE-BLR-LAMPS",
        orderId: SYNTHETIC_ORDER_ID,
        warehouseId: "WH-BLR-01",
        purpose: "SPLIT_LEG",
        items: [{ sku: "SKU-AURORA-LAMP", quantity: 2 }],
        estimatedDeliveryDate: "2026-08-03",
        cost: { currency: "INR", amountMinor: 14_500 },
        sourceUpdatedAt: "2026-08-01T09:27:30.000Z",
      },
      {
        id: "QUOTE-HYD-STAND",
        orderId: SYNTHETIC_ORDER_ID,
        warehouseId: "WH-HYD-01",
        purpose: "SPLIT_LEG",
        items: [{ sku: "SKU-WALNUT-STAND", quantity: 1 }],
        estimatedDeliveryDate: "2026-08-04",
        cost: { currency: "INR", amountMinor: 9_000 },
        sourceUpdatedAt: "2026-08-01T09:28:00.000Z",
      },
    ],
    splitShipmentSupport: [
      {
        id: "SPLIT-SUPPORT-1042",
        orderId: SYNTHETIC_ORDER_ID,
        supported: true,
        quoteIds: ["QUOTE-BLR-LAMPS", "QUOTE-HYD-STAND"],
        sourceUpdatedAt: "2026-08-01T09:29:00.000Z",
      },
    ],
  });
}

export function createSyntheticCommerceSource(
  snapshots: SourceSnapshot[] = [createSyntheticSnapshot()],
): CommerceSource {
  const byOrderId = new Map(
    snapshots.map((snapshot) => {
      const validated = sourceSnapshotSchema.parse(snapshot);
      return [validated.order.id, deepFreeze(validated)] as const;
    }),
  );

  return {
    getSnapshot(orderId) {
      const snapshot = byOrderId.get(orderId);
      return snapshot === undefined
        ? undefined
        : sourceSnapshotSchema.parse(structuredClone(snapshot));
    },
  };
}
