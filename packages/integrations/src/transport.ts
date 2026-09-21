/**
 * Delivery transports. The mock is deterministic and records every call so
 * tests can assert exact attempt counts and signed bodies without a network.
 */

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface WebhookResponse {
  ok: boolean;
  status: number;
  detail?: string;
}

export interface WebhookTransport {
  send(request: WebhookRequest): Promise<WebhookResponse>;
}

export interface MockWebhookTransportCall extends WebhookRequest {
  /** 1-based count of this call within the transport instance. */
  attempt: number;
}

/**
 * Deterministic mock transport: succeeds on every attempt from
 * `failUntilAttempt + 1` onward (default: always succeeds). Records every
 * call for assertions.
 */
export class MockWebhookTransport implements WebhookTransport {
  readonly calls: MockWebhookTransportCall[] = [];

  constructor(
    private readonly status: number = 200,
    private readonly failUntilAttempt: number = 0,
  ) {}

  async send(request: WebhookRequest): Promise<WebhookResponse> {
    const attempt = this.calls.push({ ...request, attempt: this.calls.length + 1 });
    if (attempt <= this.failUntilAttempt) {
      return { ok: false, status: this.status, detail: "mock transport failure" };
    }
    return { ok: true, status: 200, detail: "mock transport ok" };
  }
}

/** Real HTTP transport for production wiring — disabled by default (mock-first). */
export class FetchWebhookTransport implements WebhookTransport {
  async send(request: WebhookRequest): Promise<WebhookResponse> {
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...request.headers },
        body: request.body,
      });
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, status: 0, detail: error instanceof Error ? error.message : "fetch failed" };
    }
  }
}
