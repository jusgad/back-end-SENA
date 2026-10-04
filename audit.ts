import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

const REGULATED_MODELS = new Set([
  "ProductionOrder",
  "BatchEvent",
  "QcResult",
  "Deviation",
  "FinishedProductLot",
]);

const WRITE_OPS = new Set(["create", "update", "delete", "createMany", "updateMany", "deleteMany"]);

function whereId(args: Record<string, unknown>): string | undefined {
  const where = args.where;
  if (where && typeof where === "object" && "id" in where) {
    const id = (where as { id: unknown }).id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

function extractRecordId(result: unknown, args: Record<string, unknown>): string {
  if (result && typeof result === "object" && "id" in result) {
    const id = (result as { id: unknown }).id;
    if (typeof id === "string") return id;
  }
  return whereId(args) ?? "unknown";
}

const SNAPSHOT_BEFORE_OPS = new Set(["update", "updateMany", "delete", "deleteMany"]);
const SNAPSHOT_AFTER_OPS = new Set(["updateMany"]);

type SnapshotDelegate = { findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown> };

function delegateFor(client: PrismaClient, model: string): SnapshotDelegate | undefined {
  const key = model.charAt(0).toLowerCase() + model.slice(1);
  const delegate = (client as unknown as Record<string, unknown>)[key];
  if (delegate && typeof delegate === "object" && "findFirst" in delegate) {
    return delegate as SnapshotDelegate;
  }
  return undefined;
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === null || value === undefined ? undefined : (value as Prisma.InputJsonValue);
}

export interface AuditedClient {

  client: PrismaClient;

  bindTransactionClient: (tx: PrismaClient) => void;
}

export function withAuditLog(prisma: PrismaClient, actorUserId: string, tenantId: string): AuditedClient {
  let auditWriter: PrismaClient = prisma;

  const client = prisma.$extends({
    name: "withAuditLog",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const audited = Boolean(model && REGULATED_MODELS.has(model) && WRITE_OPS.has(operation));
          if (!audited || !model) {
            return query(args);
          }

          const argsRecord = args as Record<string, unknown>;
          const id = whereId(argsRecord);
          const delegate = id ? delegateFor(auditWriter, model) : undefined;
          const snapshot = () => delegate?.findFirst({ where: { id, tenantId } });

          const beforeData = SNAPSHOT_BEFORE_OPS.has(operation) ? await snapshot() : undefined;
          const result = await query(args);
          const afterData = SNAPSHOT_AFTER_OPS.has(operation) && delegate ? ((await snapshot()) ?? result) : result;

          await auditWriter.auditLog.create({
            data: {
              tenantId,
              tableName: model,
              recordId: extractRecordId(result, argsRecord),
              action: operation,
              beforeData: toJson(beforeData),
              afterData: toJson(afterData),
              actorUserId,
              occurredAt: new Date(),
            },
          });
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;

  return {
    client,
    bindTransactionClient: (tx) => {
      auditWriter = tx;
    },
  };
}
