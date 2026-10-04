import type { Prisma } from "@prisma/client";

export async function generateOrderNumber(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.productionOrder.count({
    where: { tenantId, orderNumber: { startsWith: `OP-${year}-` } },
  });
  return `OP-${year}-${String(count + 1).padStart(3, "0")}`;
}
