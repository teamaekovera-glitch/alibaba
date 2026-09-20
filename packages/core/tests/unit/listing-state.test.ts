import { describe, expect, it } from "vitest";
import {
  LISTING_STATUSES,
  LISTING_TRANSITION_AUDIT_ACTIONS,
  LISTING_TRANSITIONS,
  IllegalListingTransitionError,
  SpecExtractionUnconfirmedError,
  assertListingTransition,
  assertPublishAllowed,
  availableListingActions,
  listingTransition,
} from "../../src/index";

/**
 * The listing lifecycle is a closed edge list: every legal transition is in
 * LISTING_TRANSITIONS, everything else must be refused — notably DRAFT → LIVE
 * (publish-only-after-submit) and every edge out of REJECTED except revise.
 */

const STATUSES = LISTING_STATUSES;

function legalPairs(): Set<string> {
  return new Set(LISTING_TRANSITIONS.map((t) => `${t.from}->${t.to}`));
}

describe("listing state machine", () => {
  it("accepts every edge in the table with the recorded permission", () => {
    for (const transition of LISTING_TRANSITIONS) {
      expect(listingTransition(transition.from, transition.to)).toEqual(transition);
      expect(assertListingTransition(transition.from, transition.to)).toEqual(transition);
    }
  });

  it("refuses every transition not in the table", () => {
    const legal = legalPairs();
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (legal.has(`${from}->${to}`)) {
          continue;
        }
        expect(() => assertListingTransition(from, to)).toThrow(IllegalListingTransitionError);
        expect(listingTransition(from, to)).toBeNull();
      }
    }
  });

  it("never allows publish-before-submit or edges out of REJECTED except revise", () => {
    expect(legalPairs().has("DRAFT->LIVE")).toBe(false);
    expect(legalPairs().has("DRAFT->PAUSED")).toBe(false);
    for (const to of STATUSES) {
      if (to === "DRAFT") {
        continue;
      }
      expect(legalPairs().has(`REJECTED->${to}`)).toBe(false);
    }
  });

  it("exposes exactly the actions each status can take", () => {
    expect(availableListingActions("DRAFT")).toEqual(["submit"]);
    expect(availableListingActions("PENDING_REVIEW")).toEqual(["publish", "reject", "withdraw"]);
    expect(availableListingActions("LIVE")).toEqual(["unpublish"]);
    expect(availableListingActions("PAUSED")).toEqual(["republish", "resumeEditing"]);
    expect(availableListingActions("REJECTED")).toEqual(["revise"]);
  });

  it("requires moderation permission for publish/reject and supplier permission elsewhere", () => {
    for (const transition of LISTING_TRANSITIONS) {
      if (transition.action === "publish" || transition.action === "reject") {
        expect(transition.permission).toBe("moderation:manage");
      } else {
        expect(transition.permission).toBe("listing:manage");
      }
    }
  });

  it("has an audit action name for every transition action", () => {
    expect(Object.keys(LISTING_TRANSITION_AUDIT_ACTIONS).sort()).toEqual(
      LISTING_TRANSITIONS.map((t) => t.action).sort(),
    );
    expect(LISTING_TRANSITION_AUDIT_ACTIONS.publish).toBe("listing.publish");
    expect(LISTING_TRANSITION_AUDIT_ACTIONS.submit).toBe("listing.submit");
  });
});

describe("spec-extraction publish gate", () => {
  it("blocks publishing while any sheet is EXTRACTED (unconfirmed suggestions)", () => {
    expect(() =>
      assertPublishAllowed([{ id: "sheet_1", extractionStatus: "EXTRACTED" }]),
    ).toThrow(SpecExtractionUnconfirmedError);
  });

  it("allows publishing with no sheets, UPLOADED sheets, or confirmed sheets", () => {
    expect(() => assertPublishAllowed([])).not.toThrow();
    expect(() =>
      assertPublishAllowed([{ id: "sheet_1", extractionStatus: "UPLOADED" }]),
    ).not.toThrow();
    expect(() =>
      assertPublishAllowed([
        { id: "sheet_1", extractionStatus: "CONFIRMED" },
        { id: "sheet_2", extractionStatus: "UPLOADED" },
      ]),
    ).not.toThrow();
  });
});
