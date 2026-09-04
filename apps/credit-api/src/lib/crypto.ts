import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

const GIFT_CARD_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomGiftCardSegment(length: number): string {
  let result = "";

  for (let i = 0; i < length; i++) {
    result += GIFT_CARD_ALPHABET[randomInt(GIFT_CARD_ALPHABET.length)];
  }

  return result;
}

export function generateGiftCardCode(): string {
  return `TK${randomGiftCardSegment(14)}`;
}

export function generateSecret(prefix: string): {
  raw: string;
  hash: string;
  visiblePrefix: string;
} {
  const raw = `${prefix}_${randomToken(32)}`;
  return {
    raw,
    hash: sha256(raw),
    visiblePrefix: raw.slice(0, prefix.length + 9),
  };
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signToken(payload: object, secret: string): string {
  const encoded = encode(payload);
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyToken<T extends object>(token: string, secret: string): T | null {
  const [encoded, receivedSignature] = token.split(".");
  if (!encoded || !receivedSignature) return null;

  const expectedSignature = createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  const received = Buffer.from(receivedSignature);
  const expected = Buffer.from(expectedSignature);

  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function encryptionKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encryptJson(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const plaintext = JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptJson<T>(value: string, secret: string): T {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) {
    throw new Error("Invalid encrypted JSON payload");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(secret),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
