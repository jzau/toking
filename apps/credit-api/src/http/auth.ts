import type { FastifyRequest } from "fastify";

import { config } from "../config.js";
import { safeEqual, signToken, verifyToken } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

interface AdminTokenPayload {
  role: "admin";
  exp: number;
}
export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(401, "missing_bearer_token", "Bearer token is required");
  }
  return authorization.slice("Bearer ".length).trim();
}

export function createAdminSession(): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return {
    token: signToken(
      { role: "admin", exp: Math.floor(expiresAt.getTime() / 1000) },
      config.ADMIN_SESSION_SECRET,
    ),
    expiresAt,
  };
}

export function requireAdmin(request: FastifyRequest): void {
  const payload = verifyToken<AdminTokenPayload>(
    bearerToken(request),
    config.ADMIN_SESSION_SECRET,
  );
  if (!payload || payload.role !== "admin" || payload.exp <= Date.now() / 1000) {
    throw new AppError(401, "invalid_admin_session", "Invalid admin session");
  }
}

export function requireInternalService(request: FastifyRequest): void {
  const provided = request.headers["x-toking-internal-secret"];
  if (typeof provided !== "string" || !safeEqual(provided, config.INTERNAL_SERVICE_SECRET)) {
    throw new AppError(401, "invalid_internal_credential", "Invalid internal credential");
  }
}
