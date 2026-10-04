import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";

type WeighingPayload = { rawMaterialLotId?: string };
function weighingLotId(payload: Prisma.JsonValue): string | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const id = (payload as WeighingPayload).rawMaterialLotId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

export const traceabilityRouter = router({
  byRawMaterialLot: roleProcedure("calidad", "director_tecnico")
    .input(z.object({ rawMaterialLotCode: z.string().min(1) }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {

        const lot = await tx.rawMaterialLot.findFirstOrThrow({
          where: {
            tenantId: ctx.user.tenantId,
            OR: [
              { supplierLotCode: input.rawMaterialLotCode },
              { supplierProvidedCode: input.rawMaterialLotCode },
              { qrCode: input.rawMaterialLotCode },
            ],
          },
        });
        const events = await tx.batchEvent.findMany({
          where: { tenantId: ctx.user.tenantId, eventType: "weighing" },
        });
        const matches = events.filter((e) => weighingLotId(e.payload) === lot.id);
        const productionOrderIds = [...new Set(matches.map((e) => e.productionOrderId))];
        if (productionOrderIds.length === 0) return [];

        const orders = await tx.productionOrder.findMany({
          where: { tenantId: ctx.user.tenantId, id: { in: productionOrderIds } },
          select: { id: true, orderNumber: true },
        });
        return orders.map((o) => ({ id: o.id, orderNumber: o.orderNumber }));
      }),
    ),
  byFinishedLot: roleProcedure("calidad", "director_tecnico")
    .input(z.object({ finishedProductLotCode: z.string().min(1) }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const finished = await tx.finishedProductLot.findFirstOrThrow({
          where: { tenantId: ctx.user.tenantId, code: input.finishedProductLotCode },
        });
        const events = await tx.batchEvent.findMany({
          where: {
            tenantId: ctx.user.tenantId,
            productionOrderId: finished.productionOrderId,
            eventType: "weighing",
          },
        });
        const rawMaterialLotIds = [
          ...new Set(events.map((e) => weighingLotId(e.payload)).filter((id): id is string => Boolean(id))),
        ];
        if (rawMaterialLotIds.length === 0) return [];

        const lots = await tx.rawMaterialLot.findMany({
          where: { tenantId: ctx.user.tenantId, id: { in: rawMaterialLotIds } },
          select: { id: true, supplierLotCode: true },
        });
        return lots.map((l) => ({ id: l.id, supplierLotCode: l.supplierLotCode }));
      }),
    ),
});
