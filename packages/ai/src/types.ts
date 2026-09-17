/**
 * Typed adapter interfaces for the nine external services (spec: every
 * external service sits behind a typed adapter with a deterministic mock).
 *
 * Providers: Llm (Anthropic Claude), Embedding + Vision (Google Gemini),
 * Search (Meilisearch), Payments (Stripe Connect), Mail (Resend),
 * Realtime (Pusher), Storage (R2/S3-compatible), Tracking (EasyPost),
 * Queue (Inngest).
 *
 * All money is integer cents. No mock may use Math.random, Date.now, or the
 * network — identical call sequences must produce identical results.
 */

// ---------- LLM (Anthropic Claude) ----------
export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  stopReason: "end_turn" | "max_tokens";
  inputTokens: number;
  outputTokens: number;
}

export interface LlmAdapter {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// ---------- Embedding (Google Gemini) ----------
export interface EmbeddingResponse {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface EmbeddingAdapter {
  embed(text: string): Promise<EmbeddingResponse>;
  embedBatch(texts: string[]): Promise<EmbeddingResponse[]>;
}

// ---------- Vision (Google Gemini) ----------
export interface VisionInput {
  /** Image bytes as base64. */
  base64: string;
  mimeType: string;
}

export interface VisionResult {
  labels: string[];
  model: string;
  /** Deterministic fingerprint of the input, for traceability in tests. */
  inputHash: string;
}

export interface VisionAdapter {
  classify(input: VisionInput): Promise<VisionResult>;
}

// ---------- Search (Meilisearch) ----------
export interface SearchDocument {
  id: string;
  title: string;
  body?: string;
  /** Facet attributes, e.g. { material: "PET", category: "rigid" }. */
  attributes?: Record<string, string>;
}

export interface SearchQuery {
  q: string;
  filters?: Record<string, string>;
  limit?: number;
}

export interface SearchHit {
  id: string;
  /** 0..1, tokens matched over tokens queried. */
  score: number;
  document: SearchDocument;
}

export interface SearchAdapter {
  index(indexName: string, documents: SearchDocument[]): Promise<void>;
  query(indexName: string, query: SearchQuery): Promise<SearchHit[]>;
}

// ---------- Payments (Stripe Connect) ----------
/** Separate charges and transfers: capture to the platform balance (escrow
 * hold), transfer to the supplier connected account (release), refund from
 * the platform balance. The escrow state machine in packages/core decides
 * when these are called; the ledger stays the source of truth. */
export interface ChargeRequest {
  amountCents: number;
  currency: string;
  connectedAccountId?: string;
  metadata?: Record<string, string>;
}

export interface Charge {
  id: string;
  amountCents: number;
  currency: string;
  status: "captured" | "refunded" | "partially_refunded";
}

export interface TransferRequest {
  chargeId: string;
  connectedAccountId: string;
  amountCents: number;
}

export interface Transfer {
  id: string;
  chargeId: string;
  connectedAccountId: string;
  amountCents: number;
  status: "paid";
}

export interface Refund {
  id: string;
  chargeId: string;
  amountCents: number;
}

export interface ConnectedAccountRequest {
  /** Supplier's legal business name — becomes the mock account label. */
  businessName: string;
  country: string;
}

export interface ConnectedAccount {
  /** Platform-side identifier to persist on the supplier profile. */
  id: string;
  businessName: string;
  country: string;
  /** Mock always returns true; a real Stripe adapter reports onboarding state. */
  chargesEnabled: boolean;
}

export interface PaymentsAdapter {
  /** Creates (or idempotently returns) the supplier's Connect account.
   * Same businessName + country → same account id, so re-running the
   * onboarding step cannot mint duplicate accounts. */
  createConnectedAccount(request: ConnectedAccountRequest): Promise<ConnectedAccount>;
  captureCharge(request: ChargeRequest): Promise<Charge>;
  transferToConnectedAccount(request: TransferRequest): Promise<Transfer>;
  refundCharge(chargeId: string, amountCents?: number): Promise<Refund>;
  getCharge(chargeId: string): Promise<Charge | undefined>;
}

// ---------- Mail (Resend) ----------
export interface MailRequest {
  from?: string;
  to: string;
  subject: string;
  html: string;
}

export interface MailResult {
  id: string;
  accepted: true;
}

export interface MailAdapter {
  send(request: MailRequest): Promise<MailResult>;
}

// ---------- Realtime (Pusher) ----------
export interface RealtimeEvent {
  channel: string;
  event: string;
  payload: unknown;
}

export interface RealtimeAdapter {
  trigger(event: RealtimeEvent): Promise<{ ok: true }>;
}

// ---------- Storage (R2 / S3-compatible) ----------
export interface StoredObject {
  key: string;
  body: Uint8Array;
  contentType?: string;
}

export interface StorageAdapter {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<{ key: string; url: string }>;
  get(key: string): Promise<StoredObject | undefined>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, expiresIn?: number): Promise<string>;
}

// ---------- Tracking (EasyPost) ----------
export interface TrackingEvent {
  at: string;
  status: string;
  description: string;
}

export interface ShipmentRequest {
  carrier: string;
  service?: string;
}

export interface Shipment {
  id: string;
  trackingCode: string;
  carrier: string;
}

export interface TrackingStatus {
  trackingCode: string;
  status: "pre_transit" | "in_transit" | "delivered" | "unknown";
  events: TrackingEvent[];
}

export interface TrackingAdapter {
  createShipment(request: ShipmentRequest): Promise<Shipment>;
  track(trackingCode: string): Promise<TrackingStatus>;
}

// ---------- Queue (Inngest) ----------
export interface QueueEventEnvelope<TData = unknown> {
  name: string;
  data: TData;
}

export interface EnqueueResult {
  id: string;
}

export interface QueueAdapter {
  send<TData>(event: QueueEventEnvelope<TData>): Promise<EnqueueResult>;
}

/** Every adapter, keyed by service. createAdapters() returns this. */
export interface Adapters {
  llm: LlmAdapter;
  embedding: EmbeddingAdapter;
  vision: VisionAdapter;
  search: SearchAdapter;
  payments: PaymentsAdapter;
  mail: MailAdapter;
  realtime: RealtimeAdapter;
  storage: StorageAdapter;
  tracking: TrackingAdapter;
  queue: QueueAdapter;
}
