import type { GatewayConfig } from "./config.js";

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number | string;
  [key: string]: unknown;
};

export function estimatePromptTokens(messages: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(messages ?? []).length / 4));
}

export function estimateCredits(config: GatewayConfig, promptTokens: number, outputCharacters: number) {
  const tokens = promptTokens + Math.ceil(outputCharacters / 4);
  return BigInt(Math.max(1, Math.ceil(tokens * config.FALLBACK_CREDITS_PER_TOKEN)));
}

export function usageCredits(config: GatewayConfig, usage: Usage | undefined): bigint | null {
  if (!usage) return null;
  const cost = typeof usage.cost === "number" || (typeof usage.cost === "string" && usage.cost.trim() !== "")
    ? Number(usage.cost) : NaN;
  if (Number.isFinite(cost) && cost >= 0) {
    return BigInt(Math.ceil(cost * config.CREDITS_PER_USD));
  }
  const tokens = Number(usage.total_tokens ?? 0);
  if (Number.isFinite(tokens) && tokens > 0) {
    return BigInt(Math.ceil(tokens * config.FALLBACK_CREDITS_PER_TOKEN));
  }
  return null;
}
