import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/domain/canonical-json.js";
import {
  evidenceVersion,
  investigateFulfillmentHold,
} from "../src/domain/evidence.js";
import { calculateFulfillmentOptions } from "../src/domain/options.js";
import {
  assertEvidenceVersion,
  buildReviewCaseDraft,
} from "../src/domain/review-case.js";
import { sourceSnapshotSchema } from "../src/domain/types.js";
import { AppError } from "../src/errors.js";
import {
  createSyntheticCommerceSource,
  createSyntheticSnapshot,
  SYNTHETIC_ORDER_ID,
} from "../src/infrastructure/synthetic-commerce.js";

function investigateModified(
  modify: (snapshot: ReturnType<typeof createSyntheticSnapshot>) => void,
) {
  const snapshot = structuredClone(createSyntheticSnapshot());
  modify(snapshot);
  return investigateFulfillmentHold(
    createSyntheticCommerceSource([sourceSnapshotSchema.parse(snapshot)]),
    SYNTHETIC_ORDER_ID,
  );
}

function appErrorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : undefined;
  }
}

describe("canonical JSON", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: [2, 1], a: true, n: null, s: "value" })).toBe(
      '{"a":true,"n":null,"s":"value","z":[2,1]}',
    );
  });

  it.each([
    Number.POSITIVE_INFINITY,
    { value: undefined },
    new Date("2026-08-01T00:00:00.000Z"),
    Symbol("unsupported"),
  ])("rejects unsupported value %s", (value) => {
    expect(() => canonicalJson(value)).toThrow(AppError);
  });
});

describe("hold investigation", () => {
  it("builds deterministic, versioned evidence for the held order", () => {
    const source = createSyntheticCommerceSource();
    const first = investigateFulfillmentHold(source, SYNTHETIC_ORDER_ID);
    const second = investigateFulfillmentHold(source, SYNTHETIC_ORDER_ID);

    expect(first).toEqual(second);
    expect(first.evidenceVersion).toHaveLength(64);
    expect(first.holdEvidence.missingLines).toEqual([
      {
        sku: "SKU-WALNUT-STAND",
        orderedQuantity: 1,
        reservedQuantity: 0,
        missingQuantity: 1,
      },
    ]);
  });

  it("returns defensive copies of deeply frozen source data", () => {
    const source = createSyntheticCommerceSource();
    const first = source.getSnapshot(SYNTHETIC_ORDER_ID);
    expect(first).toBeDefined();
    if (first === undefined) return;
    const firstLine = first.order.lines[0];
    if (firstLine === undefined) throw new Error("fixture is invalid");
    first.order.lines[0] = { ...firstLine, quantity: 99 };

    expect(
      source.getSnapshot(SYNTHETIC_ORDER_ID)?.order.lines[0]?.quantity,
    ).toBe(2);
  });

  it("changes the evidence version when a source fact changes", () => {
    const original = createSyntheticSnapshot();
    const changed = structuredClone(original);
    changed.reservation.version = "8";
    expect(evidenceVersion(changed)).not.toBe(evidenceVersion(original));
  });

  it("treats an absent reservation line as zero reserved quantity", () => {
    const investigation = investigateModified((snapshot) => {
      snapshot.reservation.lines = snapshot.reservation.lines.filter(
        (line) => line.sku !== "SKU-WALNUT-STAND",
      );
    });
    expect(investigation.holdEvidence.missingLines[0]?.reservedQuantity).toBe(
      0,
    );
  });

  it("fails for an unknown order", () => {
    expect(
      appErrorCode(() =>
        investigateFulfillmentHold(createSyntheticCommerceSource(), "ORD-404"),
      ),
    ).toBe("ORDER_NOT_FOUND");
  });

  it("fails when the order is no longer on hold", () => {
    const snapshot = createSyntheticSnapshot();
    snapshot.order.status = "READY_TO_FULFILL";
    const source = createSyntheticCommerceSource([snapshot]);
    expect(
      appErrorCode(() =>
        investigateFulfillmentHold(source, SYNTHETIC_ORDER_ID),
      ),
    ).toBe("ORDER_NOT_ON_HOLD");
  });

  it("fails closed when hold and reservation facts conflict", () => {
    const snapshot = createSyntheticSnapshot();
    const missingReservation = snapshot.reservation.lines[1];
    if (missingReservation === undefined) throw new Error("fixture is invalid");
    missingReservation.quantity = 1;
    const source = createSyntheticCommerceSource([snapshot]);
    expect(
      appErrorCode(() =>
        investigateFulfillmentHold(source, SYNTHETIC_ORDER_ID),
      ),
    ).toBe("INTERNAL_ERROR");
  });
});

describe("fulfillment option calculation", () => {
  it("returns one full-order and one source-supported split option", () => {
    const investigation = investigateFulfillmentHold(
      createSyntheticCommerceSource(),
      SYNTHETIC_ORDER_ID,
    );
    const result = calculateFulfillmentOptions(investigation);

    expect(result.decisionOwner).toBe("human_reviewer");
    expect(result.availableOptions.map((option) => option.kind).sort()).toEqual(
      ["single_warehouse", "split_shipment"],
    );
    expect(
      result.availableOptions.every(
        (option) =>
          option.tradeoffs.length === 2 &&
          option.deliveryDateEffect.description.length > 0 &&
          option.shippingCostEffect.description.length > 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(result.availableOptions)).not.toMatch(
      /rank|recommend|preferred|selected/i,
    );
  });

  it("reports incomplete full-order quote coverage", () => {
    const investigation = investigateModified((snapshot) => {
      const quote = snapshot.shippingQuotes[0];
      if (quote === undefined) throw new Error("fixture is invalid");
      quote.items.pop();
    });
    const result = calculateFulfillmentOptions(investigation);
    expect(result.unavailableCandidateReasons).toContainEqual(
      expect.objectContaining({ reason: "INCOMPLETE_ORDER_COVERAGE" }),
    );
  });

  it("reports insufficient full-order warehouse inventory", () => {
    const investigation = investigateModified((snapshot) => {
      const warehouse = snapshot.warehouses.find(
        (candidate) => candidate.warehouseId === "WH-MUM-01",
      );
      if (warehouse === undefined) throw new Error("fixture is invalid");
      warehouse.available = warehouse.available.filter(
        (item) => item.sku !== "SKU-WALNUT-STAND",
      );
    });
    const result = calculateFulfillmentOptions(investigation);
    expect(result.unavailableCandidateReasons).toContainEqual(
      expect.objectContaining({ reason: "INSUFFICIENT_INVENTORY" }),
    );
  });

  it("reports a full-order quote for an unknown warehouse as unavailable", () => {
    const investigation = investigateModified((snapshot) => {
      const quote = snapshot.shippingQuotes[0];
      if (quote === undefined) throw new Error("fixture is invalid");
      quote.warehouseId = "WH-UNKNOWN";
    });
    expect(
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons,
    ).toContainEqual(
      expect.objectContaining({ reason: "INSUFFICIENT_INVENTORY" }),
    );
  });

  it("suppresses a split that the source does not support", () => {
    const investigation = investigateModified((snapshot) => {
      const support = snapshot.splitShipmentSupport[0];
      if (support === undefined) throw new Error("fixture is invalid");
      support.supported = false;
    });
    expect(
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons,
    ).toContainEqual(
      expect.objectContaining({ reason: "SPLIT_NOT_SUPPORTED" }),
    );
  });

  it("suppresses a split with a missing quote", () => {
    const investigation = investigateModified((snapshot) => {
      const support = snapshot.splitShipmentSupport[0];
      if (support === undefined) throw new Error("fixture is invalid");
      support.quoteIds[1] = "QUOTE-MISSING";
    });
    expect(
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons,
    ).toContainEqual(expect.objectContaining({ reason: "MISSING_QUOTE" }));
  });

  it("suppresses a split with full-order or same-warehouse legs", () => {
    const investigation = investigateModified((snapshot) => {
      const support = snapshot.splitShipmentSupport[0];
      if (support === undefined) throw new Error("fixture is invalid");
      support.quoteIds[1] = "QUOTE-MUM-FULL";
    });
    expect(
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons,
    ).toContainEqual(
      expect.objectContaining({ reason: "INVALID_SPLIT_CONFIGURATION" }),
    );
  });

  it("suppresses split legs that do not cover the complete order", () => {
    const investigation = investigateModified((snapshot) => {
      const quote = snapshot.shippingQuotes[2];
      if (quote === undefined) throw new Error("fixture is invalid");
      quote.items = [{ sku: "SKU-AURORA-LAMP", quantity: 1 }];
    });
    expect(
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons,
    ).toContainEqual(
      expect.objectContaining({ reason: "INCOMPLETE_ORDER_COVERAGE" }),
    );
  });

  it("suppresses a split when a leg lacks inventory", () => {
    const investigation = investigateModified((snapshot) => {
      const warehouse = snapshot.warehouses.find(
        (candidate) => candidate.warehouseId === "WH-HYD-01",
      );
      if (warehouse === undefined) throw new Error("fixture is invalid");
      const stand = warehouse.available.find(
        (item) => item.sku === "SKU-WALNUT-STAND",
      );
      if (stand === undefined) throw new Error("fixture is invalid");
      stand.quantity = 0;
    });
    expect(
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons,
    ).toContainEqual(
      expect.objectContaining({ reason: "INSUFFICIENT_INVENTORY" }),
    );
  });

  it("sorts multiple unavailable candidates deterministically", () => {
    const investigation = investigateModified((snapshot) => {
      const fullQuote = snapshot.shippingQuotes[0];
      const support = snapshot.splitShipmentSupport[0];
      if (fullQuote === undefined || support === undefined) {
        throw new Error("fixture is invalid");
      }
      fullQuote.items.pop();
      support.supported = false;
    });
    const reasons =
      calculateFulfillmentOptions(investigation).unavailableCandidateReasons;
    expect(reasons).toHaveLength(2);
    expect(reasons.map((reason) => reason.candidateId)).toEqual(
      [...reasons.map((reason) => reason.candidateId)].sort(),
    );
  });

  it("describes earlier and cheaper options without recommending them", () => {
    const investigation = investigateModified((snapshot) => {
      const quote = snapshot.shippingQuotes[0];
      if (quote === undefined) throw new Error("fixture is invalid");
      quote.estimatedDeliveryDate = "2026-08-03";
      quote.cost.amountMinor = 10_000;
    });
    const option = calculateFulfillmentOptions(
      investigation,
    ).availableOptions.find(
      (candidate) => candidate.kind === "single_warehouse",
    );
    expect(option?.deliveryDateEffect.daysFromPromisedDate).toBe(-1);
    expect(option?.shippingCostEffect.difference.amountMinor).toBe(-2_000);
    expect(option?.tradeoffs.join(" ")).toContain("before");
    expect(option?.tradeoffs.join(" ")).toContain("less");
  });

  it("describes unchanged shipping cost", () => {
    const investigation = investigateModified((snapshot) => {
      const quote = snapshot.shippingQuotes[0];
      if (quote === undefined) throw new Error("fixture is invalid");
      quote.cost.amountMinor = 12_000;
    });
    const option = calculateFulfillmentOptions(
      investigation,
    ).availableOptions.find(
      (candidate) => candidate.kind === "single_warehouse",
    );
    expect(option?.shippingCostEffect.description).toContain("Matches");
  });

  it("uses plural wording for delivery differences greater than one day", () => {
    const investigation = investigateModified((snapshot) => {
      const quote = snapshot.shippingQuotes[0];
      if (quote === undefined) throw new Error("fixture is invalid");
      quote.estimatedDeliveryDate = "2026-08-06";
    });
    const option = calculateFulfillmentOptions(
      investigation,
    ).availableOptions.find(
      (candidate) => candidate.kind === "single_warehouse",
    );
    expect(option?.deliveryDateEffect.description).toContain("2 days after");
  });

  it("uses the latest split leg regardless of quote order", () => {
    const investigation = investigateModified((snapshot) => {
      const secondLeg = snapshot.shippingQuotes[2];
      if (secondLeg === undefined) throw new Error("fixture is invalid");
      secondLeg.estimatedDeliveryDate = "2026-08-02";
    });
    const split = calculateFulfillmentOptions(
      investigation,
    ).availableOptions.find((candidate) => candidate.kind === "split_shipment");
    expect(split?.estimatedFinalDeliveryDate).toBe("2026-08-03");
  });
});

describe("review case construction", () => {
  it("requires the exact current evidence version", () => {
    expect(
      appErrorCode(() => {
        assertEvidenceVersion("old", "current");
      }),
    ).toBe("EVIDENCE_VERSION_MISMATCH");
    expect(() => {
      assertEvidenceVersion("same", "same");
    }).not.toThrow();
  });

  it("builds a canonical pending review draft", () => {
    const investigation = investigateFulfillmentHold(
      createSyntheticCommerceSource(),
      SYNTHETIC_ORDER_ID,
    );
    const preview = calculateFulfillmentOptions(investigation);
    expect(buildReviewCaseDraft(investigation, preview)).toMatchObject({
      workflowVersion: "1",
      status: "PENDING_HUMAN_REVIEW",
      orderId: SYNTHETIC_ORDER_ID,
    });
  });

  it("rejects evidence and preview from different snapshots", () => {
    const investigation = investigateFulfillmentHold(
      createSyntheticCommerceSource(),
      SYNTHETIC_ORDER_ID,
    );
    const preview = {
      ...calculateFulfillmentOptions(investigation),
      evidenceVersion: "a".repeat(64),
    };
    expect(
      appErrorCode(() => buildReviewCaseDraft(investigation, preview)),
    ).toBe("INTERNAL_ERROR");
  });
});
