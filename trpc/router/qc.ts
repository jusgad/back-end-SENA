import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { auth } from "@clerk/nextjs/server";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";
import { advanceStageInternal } from "@backend/production/advanceStage";
import { recordResultInput, rejectInput, releaseInput } from "@shared/validation/qc";

async function assertReverified(action: string): Promise<void> {
  const { has } = await auth();
  if (!has({ reverification: "strict" })) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: `Se requiere reautenticación (verificación de identidad) para ${action} el lote`,
    });
  }
}

async function recordDecisionSignature(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    userId: string;
    productionOrderId: string;
    stage: "liberado" | "rechazado";
    meaningStatement: string;
    reauthVerified: true;
  },
) {
  const signature = await tx.batchSignature.create({
    data: {
      productionOrderId: params.productionOrderId,
      stage: params.stage,
      signedBy: params.userId,
      meaningStatement: params.meaningStatement,
      reauthVerified: params.reauthVerified,
    },
  });
  await tx.batchEvent.create({
    data: {
      tenantId: params.tenantId,
      productionOrderId: params.productionOrderId,
      eventType: "signature",
      payload: { stage: params.stage, signatureId: signature.id },
      actorUserId: params.userId,
      occurredAt: new Date(),
      clientEventId: crypto.randomUUID(),
    },
  });
  return signature;
}

export const qcRouter = router({
  listPending: roleProcedure("calidad", "director_tecnico").query(({ ctx }) =>
    tenantTx(ctx, (tx) => tx.productionOrder.findMany({ where: { tenantId: ctx.user.tenantId, status: "calidad" } })),
  ),

  specsForFormula: roleProcedure("calidad", "director_tecnico")
    .input(z.object({ formulaId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const specs = await tx.qcSpecification.findMany({
          where: { tenantId: ctx.user.tenantId, formulaId: input.formulaId },
        });
        return specs.map((spec) => ({
          id: spec.id,
          parameter: spec.parameter,
          minValue: spec.minValue === null ? null : Number(spec.minValue),
          maxValue: spec.maxValue === null ? null : Number(spec.maxValue),
          unit: spec.unit,
        }));
      }),
    ),

  recordResult: roleProcedure("calidad")
    .input(recordResultInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const order = await tx.productionOrder.findFirst({
          where: { id: input.productionOrderId, tenantId: ctx.user.tenantId },
        });
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
        if (order.status !== "calidad") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `La orden está en '${order.status}' — solo se registran resultados de QC en 'calidad'`,
          });
        }
        return tx.qcResult.create({
          data: { tenantId: ctx.user.tenantId, ...input, recordedBy: ctx.user.id },
        });
      }),
    ),

  release: roleProcedure("director_tecnico")
    .input(releaseInput)
    .mutation(async ({ ctx, input }) => {
      await assertReverified("liberar");

      return tenantTx(ctx, async (tx) => {
        const tenantId = ctx.user.tenantId;
        const current = await tx.productionOrder.findFirst({ where: { id: input.productionOrderId, tenantId } });
        if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });

        const results = await tx.qcResult.findMany({
          where: { tenantId, productionOrderId: current.id },
        });
        if (results.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "No hay resultados de QC registrados — no se puede liberar" });
        }
        if (results.some((r) => r.result === "fail")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Hay resultados de QC en fail — no se puede liberar" });
        }

        const specs = await tx.qcSpecification.findMany({
          where: { tenantId, formulaId: current.formulaId },
        });
        const normalize = (parameter: string) => parameter.trim().toLowerCase();
        const measured = new Set(results.map((r) => normalize(r.parameter)));
        const missing = specs.filter((spec) => !measured.has(normalize(spec.parameter)));
        if (missing.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Faltan resultados de QC para: ${missing.map((spec) => spec.parameter).join(", ")}`,
          });
        }

        const openDeviations = await tx.deviation.findMany({
          where: { tenantId, productionOrderId: current.id, status: { not: "cerrada" } },
        });
        if (openDeviations.length > 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Hay desviaciones abiertas — no se puede liberar" });
        }


        const order = await advanceStageInternal(tx, tenantId, current.id, "liberado");

        const signature = await recordDecisionSignature(tx, {
          tenantId,
          userId: ctx.user.id,
          productionOrderId: order.id,
          stage: "liberado",
          meaningStatement: input.meaningStatement,
          reauthVerified: input.reauthVerified,
        });

        const lot = await tx.finishedProductLot.create({
          data: {
            tenantId,
            productionOrderId: order.id,
            code: order.orderNumber,
            releasedBy: ctx.user.id,
            releasedAt: new Date(),
          },
        });

        return { order, signature, lot };
      });
    }),

  reject: roleProcedure("director_tecnico")
    .input(rejectInput)
    .mutation(async ({ ctx, input }) => {
      await assertReverified("rechazar");

      return tenantTx(ctx, async (tx) => {
        const tenantId = ctx.user.tenantId;
        const order = await advanceStageInternal(tx, tenantId, input.productionOrderId, "rechazado");
        const signature = await recordDecisionSignature(tx, {
          tenantId,
          userId: ctx.user.id,
          productionOrderId: order.id,
          stage: "rechazado",
          meaningStatement: input.meaningStatement,
          reauthVerified: input.reauthVerified,
        });
        return { order, signature };
      });
    }),
});
