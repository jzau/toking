import { and, eq } from "drizzle-orm";

import type { DbExecutor } from "../db/client.js";
import { clientApiKeys, integrationClients } from "../db/schema.js";
import { generateSecret, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";

export const CLIENT_API_SCOPES = [
  "gift-cards:redeem-anonymously",
] as const;
export type ClientApiScope = typeof CLIENT_API_SCOPES[number];

export async function createIntegrationClient(executor: DbExecutor, name: string) {
  const id = newId();
  await executor.insert(integrationClients).values({ id, name });
  return { id, name };
}

export async function createClientApiKey(
  executor: DbExecutor,
  input: { clientId: string; name: string; scopes: ClientApiScope[] },
) {
  const client = await executor
    .select({ id: integrationClients.id, status: integrationClients.status })
    .from(integrationClients)
    .where(eq(integrationClients.id, input.clientId))
    .limit(1);
  if (!client[0]) throw new AppError(404, "client_not_found", "Client was not found");
  if (client[0].status !== "active") {
    throw new AppError(409, "client_disabled", "Client is disabled");
  }

  const secret = generateSecret("tci_live");
  const id = newId();
  await executor.insert(clientApiKeys).values({
    id,
    clientId: input.clientId,
    name: input.name,
    scopes: input.scopes,
    keyPrefix: secret.visiblePrefix,
    keyHash: secret.hash,
  });

  return { id, rawKey: secret.raw, prefix: secret.visiblePrefix };
}

export async function authenticateClient(
  executor: DbExecutor,
  rawKey: string,
  requiredScope: ClientApiScope,
) {
  const rows = await executor
    .select({
      apiKeyId: clientApiKeys.id,
      clientId: clientApiKeys.clientId,
      scopes: clientApiKeys.scopes,
      keyStatus: clientApiKeys.status,
      clientStatus: integrationClients.status,
    })
    .from(clientApiKeys)
    .innerJoin(integrationClients, eq(clientApiKeys.clientId, integrationClients.id))
    .where(
      and(
        eq(clientApiKeys.keyHash, sha256(rawKey)),
        eq(clientApiKeys.status, "active"),
      ),
    )
    .limit(1);

  const credential = rows[0];
  if (!credential || credential.clientStatus !== "active") {
    throw new AppError(401, "invalid_client_api_key", "Invalid client API key");
  }
  if (!credential.scopes.includes(requiredScope)) {
    throw new AppError(403, "missing_scope", `Required scope: ${requiredScope}`);
  }
  return credential;
}
