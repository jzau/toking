import type { DbExecutor } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { newId } from "../lib/ids.js";

export async function recordAudit(
  executor: DbExecutor,
  input: {
    actorType: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await executor.insert(auditEvents).values({
    id: newId(),
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    metadata: input.metadata ?? {},
  });
}
