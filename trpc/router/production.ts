import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { auth } from "@clerk/nextjs/server";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";
import { nextStage } from "@backend/production/stateMachine";
import { advanceStageInternal } from "@backend/production/advanceStage";
import { applyWeighing, assertAllIngredientsWeighed } from "@backend/production/weighing";
import { generateOrderNumber } from "@backend/production/generateOrderNumber";
import {
  createProductionOrderInput,
  recordWeighingInput,
  signInput,
  STAGE_SIGNER_ROLES,
} from "@shared/validation/production";

export const productionRouter = router({

  list: roleProcedure("jefe_planta", "calidad", "director_tecnico", "operario", "admin").query(({ ctx }) =>
    tenantTx(ctx, (tx) =>
      tx.productionOrder.findMany({
        where: { tenantId: ctx.user.tenantId },
        orderBy: { createdBy: "asc" },
        include: { formula: true },
      }),
    ),
  ),
  getById: roleProcedure("jefe_planta", "calidad", "director_tecnico", "operario", "admin")
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const order = await tx.productionOrder.findFirst({
          where: { id: input.id, tenantId: ctx.user.tenantId },
          include: { formula: true, events: { orderBy: { occurredAt: "asc" } }, signatures: true, deviations: true },
        });
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
        return order;
      }),
    ),

  create: roleProcedure("jefe_planta")
    .input(createProductionOrderInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const formula = await tx.masterFormula.findFirst({
          where: { id: input.formulaId, tenantId: ctx.user.tenantId },
        });
        if (!formula) throw new TRPCError({ code: "NOT_FOUND", message: "Fórmula no encontrada" });
        if (formula.status !== "active") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Solo formulas activas pueden usarse" });
        }
        const orderNumber = await generateOrderNumber(tx, ctx.user.tenantId);
        return tx.productionOrder.create({
          data: {
            tenantId: ctx.user.tenantId,
            orderNumber,
            formulaId: formula.id,
            formulaVersion: formula.version,
            plannedQuantity: input.plannedQuantity,
            plannedStart: input.plannedStart ? new Date(input.plannedStart) : undefined,
            createdBy: ctx.user.id,
            status: "planificado",
          },
        });
      }),
    ),

  recordWeighing: roleProcedure("operario", "jefe_planta")
    .input(recordWeighingInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        await applyWeighing(tx, {
          tenantId: ctx.user.tenantId,
          actorUserId: ctx.user.id,
          productionOrderId: input.productionOrderId,
          rawMaterialLotId: input.rawMaterialLotId,
          actualQty: input.actualQty,
          clientEventId: input.clientEventId,
          occurredAt: new Date(input.occurredAt),
        });
        const order = await tx.productionOrder.findFirst({
          where: { id: input.productionOrderId, tenantId: ctx.user.tenantId },
        });
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
        return order;
      }),
    ),

  sign: roleProcedure("operario", "jefe_planta", "calidad", "director_tecnico")
    .input(signInput)
    .mutation(async ({ ctx, input }) => {
      if (!STAGE_SIGNER_ROLES[input.stage].includes(ctx.user.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `El rol '${ctx.user.role}' no puede firmar la etapa '${input.stage}'`,
        });
      }

      const { has } = await auth();
      if (!has({ reverification: "strict" })) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Se requiere reautenticación (verificación de identidad) para firmar",
        });
      }

      return tenantTx(ctx, async (tx) => {
        const tenantId = ctx.user.tenantId;
        const order = await tx.productionOrder.findFirst({ where: { id: input.productionOrderId, tenantId } });
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
        if (order.status !== input.stage) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `La orden está en '${order.status}', no en '${input.stage}'`,
          });
        }

        if (input.stage === "pesado") {
          await assertAllIngredientsWeighed(tx, tenantId, order);
        }

        const signature = await tx.batchSignature.create({
          data: {
            productionOrderId: order.id,
            stage: input.stage,
            signedBy: ctx.user.id,
            meaningStatement: input.meaningStatement,
            reauthVerified: input.reauthVerified,
          },
        });

        await tx.batchEvent.create({
          data: {
            tenantId,
            productionOrderId: order.id,
            eventType: "signature",
            payload: { stage: input.stage, signatureId: signature.id },
            actorUserId: ctx.user.id,
            occurredAt: new Date(),
            clientEventId: crypto.randomUUID(),
          },
        });

        const to = nextStage(order.status);
        if (to) {
          await advanceStageInternal(tx, tenantId, order.id, to);
        }

        return signature;
      });
    }),
});
