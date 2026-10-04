import type { BatchStatus, Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { advanceStageInternal } from "@backend/production/advanceStage";


export type WeighingInput = {
  tenantId: string;
  actorUserId: string;
  productionOrderId: string;
  rawMaterialLotId: string;
  actualQty: number;
  clientEventId: string;
  occurredAt: Date;
  deviceId?: string;
};


export const WEIGHABLE_STATUSES: readonly BatchStatus[] = ["planificado", "pesado"];

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function reject(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

export async function applyWeighing(tx: Prisma.TransactionClient, input: WeighingInput) {
  const { tenantId } = input;

  const order = await tx.productionOrder.findFirst({
    where: { id: input.productionOrderId, tenantId },
    include: { formula: { include: { ingredients: true } } },
  });
  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Orden de producción no encontrada" });
  }
  if (!WEIGHABLE_STATUSES.includes(order.status)) {
    reject(`La orden está en '${order.status}' — ya no admite pesajes`);
  }

  const lot = await tx.rawMaterialLot.findFirst({ where: { id: input.rawMaterialLotId, tenantId } });
  if (!lot) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Lote de materia prima no encontrado" });
  }
  if (lot.status !== "liberado") {
    reject(`El lote está en '${lot.status}' — solo lotes liberados pueden pesarse`);
  }

  if (lot.expiryDate < startOfUtcDay(new Date())) {
    reject("El lote está vencido");
  }

  const ingredient = order.formula.ingredients.find((item) => item.rawMaterialId === lot.rawMaterialId);
  if (!ingredient) {
    reject("El lote no corresponde a ningún ingrediente de la fórmula de esta orden");
  }


  const theoreticalQty = (Number(ingredient.percentage) / 100) * Number(order.plannedQuantity);


  const { count } = await tx.rawMaterialLot.updateMany({
    where: { id: lot.id, tenantId, status: "liberado", quantityAvailable: { gte: input.actualQty } },
    data: { quantityAvailable: { decrement: input.actualQty } },
  });
  if (count === 0) {
    reject("Cantidad disponible insuficiente en el lote para este pesaje");
  }

  const event = await tx.batchEvent.create({
    data: {
      tenantId,
      productionOrderId: order.id,
      eventType: "weighing",
      payload: { rawMaterialLotId: lot.id, theoreticalQty, actualQty: input.actualQty },
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      clientEventId: input.clientEventId,
      deviceId: input.deviceId,
    },
  });

  if (order.status === "planificado") {
    try {
      await advanceStageInternal(tx, tenantId, order.id, "pesado");
    } catch (err) {

      if (!(err instanceof TRPCError && err.code === "CONFLICT")) throw err;
      const current = await tx.productionOrder.findFirst({ where: { id: order.id, tenantId } });
      if (current?.status !== "pesado") throw err;
    }
  }

  return event;
}

export function weighingLotId(payload: Prisma.JsonValue): string | undefined {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const id = (payload as { rawMaterialLotId?: unknown }).rawMaterialLotId;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

export async function getMissingIngredients(
  tx: Prisma.TransactionClient,
  tenantId: string,
  order: { id: string; formulaId: string },
) {
  const ingredients = await tx.formulaIngredient.findMany({
    where: { formulaId: order.formulaId, formula: { tenantId } },
    select: { rawMaterialId: true },
  });
  const weighings = await tx.batchEvent.findMany({
    where: { tenantId, productionOrderId: order.id, eventType: "weighing" },
    select: { payload: true },
  });
  const lotIds = [
    ...new Set(weighings.map((w) => weighingLotId(w.payload)).filter((id): id is string => id !== undefined)),
  ];
  const lots =
    lotIds.length === 0
      ? []
      : await tx.rawMaterialLot.findMany({ where: { id: { in: lotIds }, tenantId }, select: { rawMaterialId: true } });
  const weighedMaterials = new Set(lots.map((lot) => lot.rawMaterialId));
  return ingredients.filter((ingredient) => !weighedMaterials.has(ingredient.rawMaterialId));
}

export async function assertAllIngredientsWeighed(
  tx: Prisma.TransactionClient,
  tenantId: string,
  order: { id: string; formulaId: string },
): Promise<void> {
  const ingredients = await tx.formulaIngredient.findMany({
    where: { formulaId: order.formulaId, formula: { tenantId } },
    select: { rawMaterialId: true },
  });
  const missing = await getMissingIngredients(tx, tenantId, order);

  if (ingredients.length === 0 || missing.length > 0) {
    reject(
      `Faltan ${missing.length === 0 ? "ingredientes" : `${missing.length} ingrediente(s)`} por pesar antes de firmar el pesaje`,
    );
  }
}
