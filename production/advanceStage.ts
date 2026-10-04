import type { BatchStatus, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { canTransition } from "@backend/production/stateMachine";


export async function advanceStageInternal(
  tx: Prisma.TransactionClient,
  tenantId: string,
  orderId: string,
  to: BatchStatus,
) {
  const order = await tx.productionOrder.findFirst({ where: { id: orderId, tenantId } });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
  }
  if (!canTransition(order.status, to)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `No se puede pasar de ${order.status} a ${to}` });
  }
  const { count } = await tx.productionOrder.updateMany({
    where: { id: orderId, tenantId, status: order.status },
    data: { status: to },
  });
  if (count === 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `La orden ya no está en '${order.status}' — otra operación cambió su etapa`,
    });
  }
  const updated = await tx.productionOrder.findFirst({ where: { id: orderId, tenantId } });
  if (!updated) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
  }
  return updated;
}
