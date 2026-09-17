import { Counter } from "./counter";
import type { Shipment, ShipmentRequest, TrackingAdapter, TrackingStatus } from "../types";

const FIXED_EVENTS = [
  { at: "2026-01-01T00:00:00Z", status: "in_transit", description: "Mock carrier picked up the shipment" },
  { at: "2026-01-02T00:00:00Z", status: "in_transit", description: "Mock carrier line-haul scan" },
];

/** Deterministic EasyPost stand-in: created shipments track as in_transit
 * against a fixed event timeline; unknown codes report status "unknown". */
export class MockTrackingAdapter implements TrackingAdapter {
  readonly #shipments = new Map<string, Shipment>();
  readonly #counter = new Counter();

  async createShipment(request: ShipmentRequest): Promise<Shipment> {
    const shipment: Shipment = {
      id: this.#counter.nextId("shp_mock"),
      trackingCode: this.#counter.nextId("trk_mock"),
      carrier: request.carrier,
    };
    this.#shipments.set(shipment.trackingCode, shipment);
    return { ...shipment };
  }

  async track(trackingCode: string): Promise<TrackingStatus> {
    const known = this.#shipments.has(trackingCode);
    return {
      trackingCode,
      status: known ? "in_transit" : "unknown",
      events: known ? FIXED_EVENTS : [],
    };
  }
}
