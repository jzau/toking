import type { GatewayConfig, ProviderConfig } from "./config.js";
import { GatewayError } from "./errors.js";

export type Reservation = {
  reservationId: string;
  creditAccountId: string;
  reservedCredits: string;
  postedBalance: string;
  reservedBalance: string;
  availableBalance: string;
  defaultProviderId: string | null;
};

export type Wallet = {
  postedBalance: string;
  reservedBalance: string;
  availableBalance: string;
  canReserve: boolean;
  status: string;
};

export type WalletTransactions = {
  data: Array<{
    transactionId: string;
    type: string;
    sourceReference: string;
    amount: string;
    metadata: Record<string, unknown>;
    task: { id?: string; name?: string } | null;
    postedAt: string;
  }>;
  nextCursor: string | null;
};

export class CreditClient {
  constructor(
    private readonly config: GatewayConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.config.CREDIT_SERVICE_BASE_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-toking-internal-secret": this.config.INTERNAL_SERVICE_SECRET,
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => ({})) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new GatewayError(
        response.status,
        payload.error?.code ?? "credit_service_error",
        payload.error?.message ?? "Credit Service request failed",
        response.status === 402 ? "insufficient_quota" : "credit_service_error",
      );
    }
    return payload as T;
  }

  authenticate(gatewayApiKey: string) {
    return this.request<{ creditAccountId: string; defaultProviderId: string | null }>("/internal/v1/gateway-api-keys/resolve", {
      method: "POST",
      body: JSON.stringify({ gatewayApiKey }),
    });
  }

  wallet(gatewayApiKey: string) {
    return this.request<Wallet>("/internal/v1/wallet", {
      method: "POST",
      body: JSON.stringify({ gatewayApiKey }),
    });
  }

  walletTransactions(gatewayApiKey: string, limit: number, cursor?: string) {
    return this.request<WalletTransactions>("/internal/v1/wallet/transactions", {
      method: "POST",
      body: JSON.stringify({ gatewayApiKey, limit, ...(cursor ? { cursor } : {}) }),
    });
  }

  providers() {
    return this.request<ProviderConfig[]>("/internal/v1/ai-providers", { method: "GET" });
  }

  reserve(gatewayApiKey: string, gatewayRequestId: string, estimatedCredits: bigint) {
    return this.request<Reservation>("/internal/v1/reservations", {
      method: "POST",
      body: JSON.stringify({ gatewayApiKey, gatewayRequestId, estimatedCredits: estimatedCredits.toString() }),
    });
  }

  async capture(reservationId: string, capturedCredits: bigint, metadata: Record<string, unknown>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.request<Record<string, unknown>>(`/internal/v1/reservations/${reservationId}/capture`, {
          method: "POST",
          headers: { "idempotency-key": `gateway-capture-${reservationId}` },
          body: JSON.stringify({ capturedCredits: capturedCredits.toString(), metadata }),
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  release(reservationId: string, reason: string) {
    return this.request<Record<string, unknown>>(`/internal/v1/reservations/${reservationId}/release`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }
}
