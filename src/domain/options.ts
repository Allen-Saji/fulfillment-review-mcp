import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import {
  fulfillmentPreviewSchema,
  type FulfillmentLeg,
  type FulfillmentOption,
  type FulfillmentPreview,
  type InvestigationResult,
  type Order,
  type Quantity,
  type ShippingQuote,
  type SourceSnapshot,
  type UnavailableCandidate,
} from "./types.js";

function quantityMap(items: Quantity[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.quantity);
  }
  return quantities;
}

function coversOrder(items: Quantity[], order: Order): boolean {
  const quantities = quantityMap(items);
  return (
    quantities.size === order.lines.length &&
    order.lines.every((line) => quantities.get(line.sku) === line.quantity)
  );
}

function hasInventory(snapshot: SourceSnapshot, quote: ShippingQuote): boolean {
  const warehouse = snapshot.warehouses.find(
    (candidate) => candidate.warehouseId === quote.warehouseId,
  );
  if (warehouse === undefined) {
    return false;
  }
  const available = quantityMap(warehouse.available);
  return quote.items.every(
    (item) => (available.get(item.sku) ?? 0) >= item.quantity,
  );
}

function dateDifference(later: string, earlier: string): number {
  const millisecondsPerDay = 86_400_000;
  const laterTime = Date.parse(`${later}T00:00:00Z`);
  const earlierTime = Date.parse(`${earlier}T00:00:00Z`);
  return Math.round((laterTime - earlierTime) / millisecondsPerDay);
}

function dayDescription(days: number): string {
  if (days === 0) {
    return "Arrives on the promised delivery date.";
  }
  const unit = Math.abs(days) === 1 ? "day" : "days";
  return days > 0
    ? `Arrives ${String(days)} ${unit} after the promised delivery date.`
    : `Arrives ${String(Math.abs(days))} ${unit} before the promised delivery date.`;
}

function costDescription(amountMinor: number): string {
  const rupees = Math.abs(amountMinor) / 100;
  if (amountMinor === 0) {
    return "Matches the current planned shipping cost.";
  }
  return amountMinor > 0
    ? `Costs INR ${rupees.toFixed(2)} more than the current plan.`
    : `Costs INR ${rupees.toFixed(2)} less than the current plan.`;
}

function optionId(
  kind: FulfillmentOption["kind"],
  legs: FulfillmentLeg[],
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ kind, legs }))
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `OPT-${digest}`;
}

function buildOption(
  kind: FulfillmentOption["kind"],
  legs: [FulfillmentLeg, ...FulfillmentLeg[]],
  order: Order,
  sourceReferences: string[],
): FulfillmentOption {
  let estimatedFinalDeliveryDate = legs[0].estimatedDeliveryDate;
  for (const leg of legs.slice(1)) {
    if (leg.estimatedDeliveryDate > estimatedFinalDeliveryDate) {
      estimatedFinalDeliveryDate = leg.estimatedDeliveryDate;
    }
  }

  const totalAmountMinor = legs.reduce(
    (total, leg) => total + leg.shippingCost.amountMinor,
    0,
  );
  const daysFromPromisedDate = dateDifference(
    estimatedFinalDeliveryDate,
    order.promisedDeliveryDate,
  );
  const costDifference =
    totalAmountMinor - order.currentShippingCost.amountMinor;

  return {
    optionId: optionId(kind, legs),
    kind,
    legs,
    estimatedFinalDeliveryDate,
    deliveryDateEffect: {
      daysFromPromisedDate,
      description: dayDescription(daysFromPromisedDate),
    },
    totalShippingCost: {
      currency: "INR",
      amountMinor: totalAmountMinor,
    },
    shippingCostEffect: {
      difference: {
        currency: "INR",
        amountMinor: costDifference,
      },
      description: costDescription(costDifference),
    },
    tradeoffs: [
      dayDescription(daysFromPromisedDate),
      costDescription(costDifference),
    ],
    sourceReferences: [...new Set(sourceReferences)].sort(),
  };
}

function quoteToLeg(quote: ShippingQuote): FulfillmentLeg {
  return {
    quoteId: quote.id,
    warehouseId: quote.warehouseId,
    items: quote.items,
    estimatedDeliveryDate: quote.estimatedDeliveryDate,
    shippingCost: quote.cost,
  };
}

function evaluateFullOrderQuotes(snapshot: SourceSnapshot): {
  options: FulfillmentOption[];
  unavailable: UnavailableCandidate[];
} {
  const options: FulfillmentOption[] = [];
  const unavailable: UnavailableCandidate[] = [];

  for (const quote of snapshot.shippingQuotes.filter(
    (candidate) => candidate.purpose === "FULL_ORDER",
  )) {
    if (!coversOrder(quote.items, snapshot.order)) {
      unavailable.push({
        candidateId: quote.id,
        reason: "INCOMPLETE_ORDER_COVERAGE",
        detail: "The quote does not cover every ordered quantity.",
      });
      continue;
    }
    if (!hasInventory(snapshot, quote)) {
      unavailable.push({
        candidateId: quote.id,
        reason: "INSUFFICIENT_INVENTORY",
        detail: "The quoted warehouse does not have all required inventory.",
      });
      continue;
    }

    options.push(
      buildOption("single_warehouse", [quoteToLeg(quote)], snapshot.order, [
        quote.id,
        quote.warehouseId,
      ]),
    );
  }

  return { options, unavailable };
}

function evaluateSplits(snapshot: SourceSnapshot): {
  options: FulfillmentOption[];
  unavailable: UnavailableCandidate[];
} {
  const options: FulfillmentOption[] = [];
  const unavailable: UnavailableCandidate[] = [];

  for (const support of snapshot.splitShipmentSupport) {
    if (!support.supported) {
      unavailable.push({
        candidateId: support.id,
        reason: "SPLIT_NOT_SUPPORTED",
        detail: "The commerce source does not support this split shipment.",
      });
      continue;
    }

    const firstQuote = snapshot.shippingQuotes.find(
      (candidate) => candidate.id === support.quoteIds[0],
    );
    const secondQuote = snapshot.shippingQuotes.find(
      (candidate) => candidate.id === support.quoteIds[1],
    );
    if (firstQuote === undefined || secondQuote === undefined) {
      unavailable.push({
        candidateId: support.id,
        reason: "MISSING_QUOTE",
        detail:
          "At least one source-supported split leg has no shipping quote.",
      });
      continue;
    }
    const quotes = [firstQuote, secondQuote];

    if (
      quotes.some((quote) => quote.purpose !== "SPLIT_LEG") ||
      new Set(quotes.map((quote) => quote.warehouseId)).size !== quotes.length
    ) {
      unavailable.push({
        candidateId: support.id,
        reason: "INVALID_SPLIT_CONFIGURATION",
        detail:
          "A split requires two split-leg quotes from distinct warehouses.",
      });
      continue;
    }

    if (
      !coversOrder(
        quotes.flatMap((quote) => quote.items),
        snapshot.order,
      )
    ) {
      unavailable.push({
        candidateId: support.id,
        reason: "INCOMPLETE_ORDER_COVERAGE",
        detail: "The quoted split legs do not cover every ordered quantity.",
      });
      continue;
    }

    if (quotes.some((quote) => !hasInventory(snapshot, quote))) {
      unavailable.push({
        candidateId: support.id,
        reason: "INSUFFICIENT_INVENTORY",
        detail: "At least one split leg lacks the quoted inventory.",
      });
      continue;
    }

    const legs: [FulfillmentLeg, FulfillmentLeg] = [
      quoteToLeg(firstQuote),
      quoteToLeg(secondQuote),
    ];
    options.push(
      buildOption("split_shipment", legs, snapshot.order, [
        support.id,
        ...quotes.flatMap((quote) => [quote.id, quote.warehouseId]),
      ]),
    );
  }

  return { options, unavailable };
}

export function calculateFulfillmentOptions(
  investigation: InvestigationResult,
): FulfillmentPreview {
  const singleWarehouse = evaluateFullOrderQuotes(investigation.sourceSnapshot);
  const splitShipments = evaluateSplits(investigation.sourceSnapshot);

  return fulfillmentPreviewSchema.parse({
    orderId: investigation.orderId,
    evidenceVersion: investigation.evidenceVersion,
    currentPlanBaseline: {
      promisedDeliveryDate:
        investigation.sourceSnapshot.order.promisedDeliveryDate,
      shippingCost: investigation.sourceSnapshot.order.currentShippingCost,
    },
    availableOptions: [
      ...singleWarehouse.options,
      ...splitShipments.options,
    ].sort((left, right) => left.optionId.localeCompare(right.optionId)),
    unavailableCandidateReasons: [
      ...singleWarehouse.unavailable,
      ...splitShipments.unavailable,
    ].sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
    decisionOwner: "human_reviewer",
  });
}
