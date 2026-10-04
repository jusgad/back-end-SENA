import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, roleProcedure, tenantTx } from "@backend/trpc/trpc";
import { sumPercentages, isWithinTolerance } from "@shared/formulas/validateComposition";
import { createFormulaInput } from "@shared/validation/formulas";

export const formulasRouter = router({
  list: roleProcedure("jefe_planta", "calidad", "director_tecnico", "admin").query(({ ctx }) =>
    tenantTx(ctx, (tx) => tx.masterFormula.findMany({ where: { tenantId: ctx.user.tenantId }, orderBy: { name: "asc" } })),
  ),
  listActive: roleProcedure("jefe_planta", "calidad", "director_tecnico", "admin").query(({ ctx }) =>
    tenantTx(ctx, (tx) =>
      tx.masterFormula.findMany({ where: { tenantId: ctx.user.tenantId, status: "active" }, orderBy: { name: "asc" } }),
    ),
  ),
  getById: roleProcedure("jefe_planta", "calidad", "director_tecnico", "admin")
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const formula = await tx.masterFormula.findFirst({
          where: { id: input.id, tenantId: ctx.user.tenantId },
          include: { ingredients: true },
        });
        if (!formula) throw new TRPCError({ code: "NOT_FOUND", message: "Fórmula no encontrada" });
        return formula;
      }),
    ),
  create: roleProcedure("jefe_planta")
    .input(createFormulaInput)
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, (tx) => tx.masterFormula.create({ data: { ...input, tenantId: ctx.user.tenantId } })),
    ),

  addIngredient: roleProcedure("jefe_planta")
    .input(
      z.object({
        formulaId: z.string().uuid(),
        rawMaterialId: z.string().uuid(),
        percentage: z.number().positive(),
        orderIndex: z.number().int(),
      }),
    )
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const formula = await tx.masterFormula.findFirst({
          where: { id: input.formulaId, tenantId: ctx.user.tenantId },
        });
        if (!formula) throw new TRPCError({ code: "NOT_FOUND", message: "Fórmula no encontrada" });
        if (formula.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `La fórmula está en '${formula.status}' — solo se modifican fórmulas en borrador`,
          });
        }
        const rawMaterial = await tx.rawMaterial.findFirst({
          where: { id: input.rawMaterialId, tenantId: ctx.user.tenantId },
        });
        if (!rawMaterial) throw new TRPCError({ code: "NOT_FOUND", message: "Materia prima no encontrada" });
        return tx.formulaIngredient.create({ data: input });
      }),
    ),

  activate: roleProcedure("calidad")
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      tenantTx(ctx, async (tx) => {
        const tenantId = ctx.user.tenantId;
        const formula = await tx.masterFormula.findFirst({
          where: { id: input.id, tenantId },
          include: { ingredients: true },
        });
        if (!formula) throw new TRPCError({ code: "NOT_FOUND", message: "Fórmula no encontrada" });
        if (formula.status !== "draft") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `La fórmula está en '${formula.status}' — solo una fórmula en borrador puede activarse`,
          });
        }
        const sum = sumPercentages(
          formula.ingredients.map((ingredient) => ({ percentage: Number(ingredient.percentage) })),
        );
        if (!isWithinTolerance(sum)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `La suma de ingredientes es ${sum}%, debe ser 100% ± tolerancia`,
          });
        }
        const { count } = await tx.masterFormula.updateMany({
          where: { id: formula.id, tenantId, status: "draft" },
          data: { status: "active", approvedBy: ctx.user.id, approvedAt: new Date() },
        });
        if (count === 0) {
          throw new TRPCError({ code: "CONFLICT", message: "La fórmula ya no está en borrador" });
        }
        return tx.masterFormula.findFirstOrThrow({ where: { id: formula.id, tenantId } });
      }),
    ),
});
