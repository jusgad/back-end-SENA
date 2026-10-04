import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MasterFormula } from "@prisma/client";

let formulaResult: Partial<MasterFormula> | null = { id: "f1", version: 2, status: "draft" };
const masterFormulaFindFirst = vi.fn(async (): Promise<Partial<MasterFormula> | null> => formulaResult);
const count = vi.fn(async () => 0);
const create = vi.fn(async () => ({ id: "po1" }));
const productionOrderFindMany = vi.fn(async () => []);

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({
      masterFormula: { findFirst: masterFormulaFindFirst },
      productionOrder: { create, count, findMany: productionOrderFindMany },
    }),
}));

import { productionRouter } from "../production";
import { TRPCError } from "@trpc/server";

const caller = (role: "jefe_planta" | "operario" = "jefe_planta") =>
  productionRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

describe("production.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formulaResult = { id: "f1", version: 2, status: "draft" };
  });

  it("rejects creating an order from a non-active formula", async () => {

    const error = await caller()
      .create({ formulaId: "550e8400-e29b-41d4-a716-446655440000", plannedQuantity: 10 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    expect(create).not.toHaveBeenCalled();
  });

  it("looks the formula up scoped to the caller's tenant and rejects a foreign/unknown formula", async () => {
    formulaResult = null;
    const error = await caller()
      .create({ formulaId: "550e8400-e29b-41d4-a716-446655440000", plannedQuantity: 10 })
      .catch((e: unknown) => e);

    expect((error as TRPCError).code).toBe("NOT_FOUND");
    expect(masterFormulaFindFirst).toHaveBeenCalledWith({
      where: { id: "550e8400-e29b-41d4-a716-446655440000", tenantId: "t1" },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates an order from an active formula, numbering it per tenant through the transaction", async () => {
    formulaResult = { id: "f1", version: 2, status: "active" };
    await caller().create({ formulaId: "550e8400-e29b-41d4-a716-446655440000", plannedQuantity: 10 });

    expect(count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1" }) }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          orderNumber: `OP-${new Date().getFullYear()}-001`,
          formulaId: "f1",
        }),
      }),
    );
  });
});

describe("production.list", () => {
  it("filters by the caller's tenant explicitly", async () => {
    await caller("operario").list();
    expect(productionOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" } }),
    );
  });
});
