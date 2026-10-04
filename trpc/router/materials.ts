import { z } from "zod";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";
import { receiveLotInput } from "@shared/validation/materials";

export const materialsRouter = router({
  list: roleProcedure("bodega", "jefe_planta", "calidad", "director_tecnico", "admin").query(({ ctx }) =>
    tenantTx(ctx, (tx) => tx.rawMaterial.findMany({ where: { tenantId: ctx.user.tenantId }, orderBy: { name: "asc" } })),
  ),
  getById: roleProcedure("bodega", "jefe_planta", "calidad", "director_tecnico", "admin")
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const material = await tx.rawMaterial.findFirst({ where: { id: input.id, tenantId: ctx.user.tenantId } });
        if (!material) throw new TRPCError({ code: "NOT_FOUND", message: "Materia prima no encontrada" });
        return material;
      }),
    ),
  create: roleProcedure("bodega", "admin")
    .input(z.object({ code: z.string(), name: z.string(), unit: z.string(), category: z.string().optional() }))
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, (tx) => tx.rawMaterial.create({ data: { ...input, tenantId: ctx.user.tenantId } })),
    ),

  receiveLot: roleProcedure("bodega")
    .input(receiveLotInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const material = await tx.rawMaterial.findFirst({
          where: { id: input.rawMaterialId, tenantId: ctx.user.tenantId },
        });
        if (!material) throw new TRPCError({ code: "NOT_FOUND", message: "Materia prima no encontrada" });
        return tx.rawMaterialLot.create({
          data: {
            tenantId: ctx.user.tenantId,
            rawMaterialId: material.id,
            supplierLotCode: input.supplierLotCode,
            supplierProvidedCode: input.supplierProvidedCode,
            coaDocumentUrl: input.coaDocumentUrl,
            quantityReceived: input.quantityReceived,
            quantityAvailable: input.quantityReceived,
            expiryDate: new Date(input.expiryDate),
            status: "cuarentena",

            qrCode: `MP-${randomUUID()}`,
          },
        });
      }),
    ),

  setStatus: roleProcedure("bodega", "calidad")
    .input(z.object({ id: z.string().uuid(), status: z.enum(["liberado", "rechazado"]) }))
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const { count } = await tx.rawMaterialLot.updateMany({
          where: { id: input.id, tenantId: ctx.user.tenantId, status: "cuarentena" },
          data: { status: input.status },
        });
        if (count === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "El lote no existe o ya no está en cuarentena.",
          });
        }
        return tx.rawMaterialLot.findFirstOrThrow({ where: { id: input.id, tenantId: ctx.user.tenantId } });
      }),
    ),

  listLots: roleProcedure("bodega", "jefe_planta", "calidad", "director_tecnico", "admin", "operario").query(
    ({ ctx }) =>
      tenantTx(ctx, (tx) =>
        tx.rawMaterialLot.findMany({
          where: { tenantId: ctx.user.tenantId },
          orderBy: { receivedAt: "desc" },
          include: { rawMaterial: true },
        }),
      ),
  ),
});
