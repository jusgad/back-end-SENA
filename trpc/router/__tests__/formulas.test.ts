import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

type MockFormula = { id: string; status: string; ingredients: { percentage: number }[] };

let formula: MockFormula | null;
let rawMaterial: { id: string } | null;
let activateCount: number;

const formulaFindFirst = vi.fn(async (): Promise<MockFormula | null> => formula);
const formulaFindFirstOrThrow = vi.fn(async () => ({ ...formula, status: "active" }));
const formulaUpdateMany = vi.fn(async () => ({ count: activateCount }));
const rawMaterialFindFirst = vi.fn(async () => rawMaterial);
const ingredientCreate = vi.fn(async () => ({ id: "ing1" }));

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({
      masterFormula: { findFirst: formulaFindFirst, findFirstOrThrow: formulaFindFirstOrThrow, updateMany: formulaUpdateMany },
      rawMaterial: { findFirst: rawMaterialFindFirst },
      formulaIngredient: { create: ingredientCreate },
    }),
}));

import { formulasRouter } from "../formulas";

const FORMULA_ID = "550e8400-e29b-41d4-a716-446655440000";
const RAW_MATERIAL_ID = "550e8400-e29b-41d4-a716-446655440001";

const caller = (role: "calidad" | "jefe_planta") =>
  formulasRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(() => undefined).catch((e: unknown) => e);
  return err instanceof TRPCError ? err.code : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  formula = { id: FORMULA_ID, status: "draft", ingredients: [{ percentage: 60 }, { percentage: 40 }] };
  rawMaterial = { id: RAW_MATERIAL_ID };
  activateCount = 1;
});

describe("formulas.activate", () => {

  it("rejects activation when ingredients don't sum to ~100%", async () => {
    formula = { ...formula!, ingredients: [{ percentage: 60 }, { percentage: 39 }] };
    const error = await caller("calidad")
      .activate({ id: FORMULA_ID })
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    expect((error as TRPCError).message).toContain("99");
    expect(formulaUpdateMany).not.toHaveBeenCalled();
  });

  it("activates a draft whose ingredients sum to 100%, guarding the write on status draft + tenant", async () => {
    await caller("calidad").activate({ id: FORMULA_ID });
    expect(formulaFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: FORMULA_ID, tenantId: "t1" } }));
    expect(formulaUpdateMany).toHaveBeenCalledWith({
      where: { id: FORMULA_ID, tenantId: "t1", status: "draft" },
      data: expect.objectContaining({ status: "active", approvedBy: "u1" }),
    });
  });

  it.each(["active", "archived"])("refuses to activate a formula that is '%s'", async (status) => {
    formula = { ...formula!, status };
    expect(await codeOf(caller("calidad").activate({ id: FORMULA_ID }))).toBe("BAD_REQUEST");
    expect(formulaUpdateMany).not.toHaveBeenCalled();
  });

  it("throws CONFLICT if the formula left draft between the read and the guarded write", async () => {
    activateCount = 0;
    expect(await codeOf(caller("calidad").activate({ id: FORMULA_ID }))).toBe("CONFLICT");
  });

  it("treats a formula outside the caller's tenant as NOT_FOUND", async () => {
    formula = null;
    expect(await codeOf(caller("calidad").activate({ id: FORMULA_ID }))).toBe("NOT_FOUND");
  });
});

describe("formulas.addIngredient", () => {
  const input = { formulaId: FORMULA_ID, rawMaterialId: RAW_MATERIAL_ID, percentage: 10, orderIndex: 0 };

  it("adds an ingredient to a draft formula after verifying both ids belong to the tenant", async () => {
    await caller("jefe_planta").addIngredient(input);
    expect(formulaFindFirst).toHaveBeenCalledWith({ where: { id: FORMULA_ID, tenantId: "t1" } });
    expect(rawMaterialFindFirst).toHaveBeenCalledWith({ where: { id: RAW_MATERIAL_ID, tenantId: "t1" } });
    expect(ingredientCreate).toHaveBeenCalledWith({ data: input });
  });

  it.each(["active", "archived"])("refuses to modify a formula that is '%s'", async (status) => {
    formula = { ...formula!, status };
    expect(await codeOf(caller("jefe_planta").addIngredient(input))).toBe("BAD_REQUEST");
    expect(ingredientCreate).not.toHaveBeenCalled();
  });

  it("rejects a formula outside the caller's tenant", async () => {
    formula = null;
    expect(await codeOf(caller("jefe_planta").addIngredient(input))).toBe("NOT_FOUND");
    expect(ingredientCreate).not.toHaveBeenCalled();
  });

  it("rejects a raw material outside the caller's tenant", async () => {
    rawMaterial = null;
    expect(await codeOf(caller("jefe_planta").addIngredient(input))).toBe("NOT_FOUND");
    expect(ingredientCreate).not.toHaveBeenCalled();
  });
});
