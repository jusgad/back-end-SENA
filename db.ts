import { PrismaClient, Prisma } from "@prisma/client";
import { withAuditLog } from "@backend/audit";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function withTenant<T>(
  tenantId: string,
  actorUserId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!tenantId) {
    throw new Error("withTenant: tenantId is required");
  }
  const { client: auditedPrisma, bindTransactionClient } = withAuditLog(prisma, actorUserId, tenantId);
  return auditedPrisma.$transaction(async (tx) => {
    bindTransactionClient(tx as unknown as PrismaClient);
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}
