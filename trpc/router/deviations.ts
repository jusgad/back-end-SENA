import { TRPCError } from "@trpc/server";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";
import {
  createDeviationInput,
  startInvestigationInput,
  submitInvestigationInput,
  approveDeviationInput,
} from "@shared/validation/deviations";
import { z } from "zod";

export const deviationsRouter = router({

  list: roleProcedure("calidad", "director_tecnico", "jefe_planta", "operario").query(({ ctx }) =>
    tenantTx(ctx, (tx) =>
      tx.deviation.findMany({
        where: { tenantId: ctx.user.tenantId, status: { not: "cerrada" } },
        orderBy: { id: "asc" },
      }),
    ),
  ),

  getById: roleProcedure("calidad", "director_tecnico", "jefe_planta", "operario")
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const deviation = await tx.deviation.findFirst({ where: { id: input.id, tenantId: ctx.user.tenantId } });
        if (!deviation) throw new TRPCError({ code: "NOT_FOUND", message: "Desviación no encontrada" });
        return deviation;
      }),
    ),

  create: roleProcedure("calidad", "jefe_planta", "operario")
    .input(createDeviationInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const order = await tx.productionOrder.findFirst({
          where: { id: input.productionOrderId, tenantId: ctx.user.tenantId },
          select: { id: true },
        });
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
        return tx.deviation.create({
          data: { tenantId: ctx.user.tenantId, ...input, raisedBy: ctx.user.id, status: "abierta" },
        });
      }),
    ),

  startInvestigation: roleProcedure("calidad")
    .input(startInvestigationInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const { count } = await tx.deviation.updateMany({
          where: { id: input.id, tenantId: ctx.user.tenantId, status: "abierta" },
          data: {
            status: "en_investigacion",
            investigationStartedBy: ctx.user.id,
            investigationStartedAt: new Date(),
          },
        });
        if (count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "La desviación no está en estado 'abierta'",
          });
        }
        return tx.deviation.findFirstOrThrow({ where: { id: input.id, tenantId: ctx.user.tenantId } });
      }),
    ),

  submitInvestigation: roleProcedure("calidad")
    .input(submitInvestigationInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const { count } = await tx.deviation.updateMany({
          where: { id: input.id, tenantId: ctx.user.tenantId, status: "en_investigacion" },
          data: {
            investigation: input.investigation,
            correctiveAction: input.correctiveAction,
            status: "pendiente_aprobacion",
          },
        });
        if (count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "La desviación no está en estado 'en_investigacion' — inicie la investigación primero",
          });
        }
        return tx.deviation.findFirstOrThrow({ where: { id: input.id, tenantId: ctx.user.tenantId } });
      }),
    ),

  approve: roleProcedure("director_tecnico")
    .input(approveDeviationInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const { count } = await tx.deviation.updateMany({
          where: { id: input.id, tenantId: ctx.user.tenantId, status: "pendiente_aprobacion" },
          data: { status: "cerrada", approvedBy: ctx.user.id, approvedAt: new Date() },
        });
        if (count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "La desviación no está pendiente de aprobación",
          });
        }
        return tx.deviation.findFirstOrThrow({ where: { id: input.id, tenantId: ctx.user.tenantId } });
      }),
    ),
});
