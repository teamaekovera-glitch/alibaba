/**
 * Trust & communication (spec: "Trust & comms"): general buyer–supplier
 * messaging, verified-purchase reviews with moderation, the dispute
 * lifecycle wired to the escrow freeze, and the fraud controls
 * (rate limits, duplicate-review detection) that guard them.
 */
export * from "./messaging-repository";
export * from "./dispute-machine";
export * from "./disputes-repository";
export * from "./review-machine";
export * from "./reviews-repository";
