import { and, eq, gt, isNull } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/client.js";
import { creditAccounts, otpChallenges, users, userSessions } from "../db/schema.js";
import { createHmac } from "node:crypto";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { createCreditAccount } from "./credit-accounts.js";

function normalizePhone(phone: string): string {
  const normalized = phone.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new AppError(400, "invalid_phone", "Phone must use E.164 format");
  }
  return normalized;
}

function otpHash(challengeId: string, code: string): string {
  return createHmac("sha256", config.ADMIN_SESSION_SECRET)
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

export async function requestOtp(phone: string) {
  const phoneE164 = normalizePhone(phone);
  const id = newId();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.insert(otpChallenges).values({
    id,
    phoneE164,
    codeHash: otpHash(id, config.DEV_OTP_CODE),
    expiresAt,
  });

  return {
    challengeId: id,
    expiresAt,
    ...(config.NODE_ENV !== "production" ? { debugCode: config.DEV_OTP_CODE } : {}),
  };
}

export async function verifyOtp(input: { challengeId: string; code: string }) {
  const outcome = await db.transaction(async (tx) => {
    const challenges = await tx
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.id, input.challengeId))
      .for("update")
      .limit(1);
    const challenge = challenges[0];
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) {
      throw new AppError(400, "invalid_otp_challenge", "OTP challenge is invalid or expired");
    }
    if (challenge.attempts >= 5) {
      throw new AppError(429, "otp_attempts_exceeded", "Too many OTP attempts");
    }
    if (otpHash(challenge.id, input.code) !== challenge.codeHash) {
      await tx
        .update(otpChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(otpChallenges.id, challenge.id));
      return { ok: false as const };
    }

    const existing = await tx
      .select()
      .from(users)
      .where(eq(users.phoneE164, challenge.phoneE164))
      .limit(1);
    let user = existing[0];
    if (!user) {
      const userId = newId();
      const now = new Date();
      await tx.insert(users).values({
        id: userId,
        phoneE164: challenge.phoneE164,
        phoneVerifiedAt: now,
      });
      await createCreditAccount(tx, { ownerType: "user", userId });
      user = {
        id: userId,
        phoneE164: challenge.phoneE164,
        phoneVerifiedAt: now,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
    }
    if (user.status !== "active") {
      throw new AppError(403, "user_suspended", "User is suspended");
    }

    await tx
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, challenge.id));

    const rawToken = `tus_${randomToken(32)}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await tx.insert(userSessions).values({
      id: newId(),
      userId: user.id,
      tokenHash: sha256(rawToken),
      expiresAt,
    });

    return {
      ok: true as const,
      value: { accessToken: rawToken, expiresAt, userId: user.id },
    };
  });

  if (!outcome.ok) throw new AppError(400, "invalid_otp", "OTP code is invalid");
  return outcome.value;
}

export async function authenticateUser(rawToken: string) {
  const rows = await db
    .select({
      sessionId: userSessions.id,
      userId: users.id,
      userStatus: users.status,
      creditAccountId: creditAccounts.id,
      accountStatus: creditAccounts.status,
    })
    .from(userSessions)
    .innerJoin(users, eq(userSessions.userId, users.id))
    .innerJoin(creditAccounts, eq(creditAccounts.userId, users.id))
    .where(
      and(
        eq(userSessions.tokenHash, sha256(rawToken)),
        isNull(userSessions.revokedAt),
        gt(userSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const authenticated = rows[0];
  if (!authenticated || authenticated.userStatus !== "active") {
    throw new AppError(401, "invalid_user_session", "Invalid user session");
  }
  if (authenticated.accountStatus !== "active") {
    throw new AppError(403, "credit_account_suspended", "Credit Account is suspended");
  }
  return authenticated;
}

export async function logoutUser(rawToken: string) {
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(eq(userSessions.tokenHash, sha256(rawToken)));
}
