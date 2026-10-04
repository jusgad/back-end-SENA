import type { Prisma } from "@prisma/client";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";
import { auditSearchInput } from "@shared/validation/audit";

function buildWhere(tenantId: string, input: { tableName?: string; actorUserId?: string; dateFrom?: string; dateTo?: string }): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { tenantId };
  if (input.tableName) where.tableName = input.tableName;
  if (input.actorUserId) where.actorUserId = input.actorUserId;
  if (input.dateFrom || input.dateTo) {
    where.occurredAt = {
      ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
      ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
    };
  }
  return where;
}

function toCsvField(value: string): string {

  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const CSV_HEADER = ["occurredAt", "tableName", "recordId", "action", "actorUserId", "afterData"];

export const auditRouter = router({

  search: roleProcedure("admin", "director_tecnico")
    .input(auditSearchInput)
    .query(({ ctx, input }) =>
      tenantTx(ctx, (tx) =>
        tx.auditLog.findMany({
          where: buildWhere(ctx.user.tenantId, input),
          orderBy: { occurredAt: "desc" },
        }),
      ),
    ),

  export: roleProcedure("admin", "director_tecnico")
    .input(auditSearchInput)
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const rows = await tx.auditLog.findMany({
          where: buildWhere(ctx.user.tenantId, input),
          orderBy: { occurredAt: "desc" },
        });
        const lines = rows.map((row) =>
          [
            row.occurredAt.toISOString(),
            row.tableName,
            row.recordId,
            row.action,
            row.actorUserId,
            row.afterData === null ? "" : JSON.stringify(row.afterData),
          ]
            .map(toCsvField)
            .join(","),
        );
        return [CSV_HEADER.join(","), ...lines].join("\n");
      }),
    ),
});
