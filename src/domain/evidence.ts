import { createHash } from "node:crypto";

import { AppError } from "../errors.js";
import { canonicalJson } from "./canonical-json.js";
import {
  investigationResultSchema,
  type InvestigationResult,
  type SourceSnapshot,
} from "./types.js";

export interface CommerceSource {
  getSnapshot(orderId: string): SourceSnapshot | undefined;
}

function reservedQuantity(snapshot: SourceSnapshot, sku: string): number {
  return (
    snapshot.reservation.lines.find((line) => line.sku === sku)?.quantity ?? 0
  );
}

export function evidenceVersion(snapshot: SourceSnapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function investigateFulfillmentHold(
  source: CommerceSource,
  orderId: string,
): InvestigationResult {
  const snapshot = source.getSnapshot(orderId);
  if (snapshot === undefined) {
    throw new AppError(
      "ORDER_NOT_FOUND",
      `Order ${orderId} was not found in the commerce source.`,
    );
  }

  if (snapshot.order.status !== "PARTIAL_FULFILLMENT_HOLD") {
    throw new AppError(
      "ORDER_NOT_ON_HOLD",
      `Order ${orderId} is not on a partial-fulfillment hold.`,
    );
  }

  const missingLines = snapshot.order.lines.flatMap((line) => {
    const reserved = reservedQuantity(snapshot, line.sku);
    const missing = line.quantity - reserved;
    return missing > 0
      ? [
          {
            sku: line.sku,
            orderedQuantity: line.quantity,
            reservedQuantity: reserved,
            missingQuantity: missing,
          },
        ]
      : [];
  });

  if (missingLines.length === 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "The hold source is inconsistent with the reservation quantities.",
    );
  }

  const missingSummary = missingLines
    .map((line) => `${String(line.missingQuantity)} unit(s) of ${line.sku}`)
    .join(", ");

  return investigationResultSchema.parse({
    orderId: snapshot.order.id,
    status: snapshot.order.status,
    evidenceVersion: evidenceVersion(snapshot),
    sourceSnapshot: snapshot,
    holdEvidence: {
      holdId: snapshot.hold.id,
      code: snapshot.hold.code,
      assignedWarehouseId: snapshot.order.assignedWarehouseId,
      missingLines,
      summary: `The assigned warehouse is missing ${missingSummary}.`,
    },
  });
}
