import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { applyWeighing, assertAllIngredientsWeighed, getMissingIngredients, WEIGHABLE_STATUSES } from "../weighing";

const ORDER_ID = "550e8400-e29b-41d4-a716-446655440000";
const LOT_ID = "550e8400-e29b-41d4-a716-446655440001";

type MockOrder = {
  id: string;
  status: string;
  formulaId: string;
  plannedQuantity: number;
  formula: { ingredients: { rawMaterialId: string; percentage: number }[] };
};
type MockLot = { id: string; rawMaterialId: string; status: string; expiryDate: Date };

let order: MockOrder | null;
let lot: MockLot | null;
let lotUpdateCount: number;

const orderFindFirst = vi.fn(async (): Promise<MockOrder | null> => order);
const orderUpdateMany = vi.fn(async () => ({ count: 1 }));
const lotFindFirst = vi.fn(async (): Promise<MockLot | null> => lot);
const lotUpdateMany = vi.fn(async () => ({ count: lotUpdateCount }));
const lotFindMany = vi.fn(async (): Promise<{ rawMaterialId: string }[]> => []);
const eventCreate = vi.fn(async (args: Prisma.BatchEventCreateArgs) => ({ id: "ev1", ...args.data }));
const eventFindMany = vi.fn(async (): Promise<{ payload: Prisma.JsonValue }[]> => []);
const ingredientFindMany = vi.fn(async (): Promise<{ rawMaterialId: string }[]> => []);

const tx = {
  productionOrder: { findFirst: orderFindFirst, updateMany: orderUpdateMany },
  rawMaterialLot: { findFirst: lotFindFirst, updateMany: lotUpdateMany, findMany: lotFindMany },
  batchEvent: { create: eventCreate, findMany: eventFindMany },
  formulaIngredient: { findMany: ingredientFindMany },
} as unknown as Prisma.TransactionClient;

const input = {
  tenantId: "t1",
  actorUserId: "u1",
  productionOrderId: ORDER_ID,
  rawMaterialLotId: LOT_ID,
  actualQty: 119.5,
  clientEventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: new Date("2026-09-30T10:00:00.000Z"),
};

function futureDate(): Date {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

beforeEach(() => {
  vi.clearAllMocks();
  order = {
    id: ORDER_ID,
    status: "planificado",
    formulaId: "f1",
    plannedQuantity: 200,
    formula: {
      ingredients: [
        { rawMaterialId: "rm1", percentage: 60 },
        { rawMaterialId: "rm2", percentage: 40 },
      ],
    },
  };
  lot = { id: LOT_ID, rawMaterialId: "rm1", status: "liberado", expiryDate: futureDate() };
  lotUpdateCount = 1;
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const err = await promise.then(() => undefined).catch((e: unknown) => e);
  return err instanceof TRPCError ? err.code : undefined;
}

describe("applyWeighing", () => {
  it("decrements the lot's stock, persists the SERVER-computed theoreticalQty, and advances planificado -> pesado", async () => {
    await applyWeighing(tx, input);

    expect(orderFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORDER_ID, tenantId: "t1" } }));
    expect(lotFindFirst).toHaveBeenCalledWith({ where: { id: LOT_ID, tenantId: "t1" } });
    expect(lotUpdateMany).toHaveBeenCalledWith({
      where: { id: LOT_ID, tenantId: "t1", status: "liberado", quantityAvailable: { gte: 119.5 } },
      data: { quantityAvailable: { decrement: 119.5 } },
    });
  
    expect(eventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          eventType: "weighing",
          payload: { rawMaterialLotId: LOT_ID, theoreticalQty: 120, actualQty: 119.5 },
        }),
      }),
    );
    expect(orderUpdateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ID, tenantId: "t1", status: "planificado" },
      data: { status: "pesado" },
    });
  });

  it("records a further ingredient on a 'pesado' order without trying to advance it again", async () => {
    order = { ...order!, status: "pesado" };
    await applyWeighing(tx, input);
    expect(eventCreate).toHaveBeenCalled();
    expect(orderUpdateMany).not.toHaveBeenCalled();
  });


  it.each(["mezclado", "calidad", "liberado", "rechazado"])(
    "rejects a weighing for an order in '%s' without writing anything",
    async (status) => {
      order = { ...order!, status };
      expect(await codeOf(applyWeighing(tx, input))).toBe("BAD_REQUEST");
      expect(lotUpdateMany).not.toHaveBeenCalled();
      expect(eventCreate).not.toHaveBeenCalled();
    },
  );

  it("treats an order outside the caller's tenant as NOT_FOUND", async () => {
    order = null;
    expect(await codeOf(applyWeighing(tx, input))).toBe("NOT_FOUND");
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("treats a lot outside the caller's tenant as NOT_FOUND", async () => {
    lot = null;
    expect(await codeOf(applyWeighing(tx, input))).toBe("NOT_FOUND");
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it.each(["cuarentena", "rechazado"])("rejects a lot in '%s'", async (status) => {
    lot = { ...lot!, status };
    expect(await codeOf(applyWeighing(tx, input))).toBe("BAD_REQUEST");
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("rejects an expired lot", async () => {
    lot = { ...lot!, expiryDate: new Date("2020-01-01T00:00:00.000Z") };
    expect(await codeOf(applyWeighing(tx, input))).toBe("BAD_REQUEST");
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("rejects a lot whose raw material is not an ingredient of the order's formula", async () => {
    lot = { ...lot!, rawMaterialId: "rm-other" };
    expect(await codeOf(applyWeighing(tx, input))).toBe("BAD_REQUEST");
    expect(lotUpdateMany).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });

  it("rejects when the lot no longer has enough stock (atomic decrement matched no row)", async () => {
    lotUpdateCount = 0;
    expect(await codeOf(applyWeighing(tx, input))).toBe("BAD_REQUEST");
    expect(eventCreate).not.toHaveBeenCalled();
  });
});

describe("assertAllIngredientsWeighed", () => {
  const target = { id: ORDER_ID, formulaId: "f1" };

  beforeEach(() => {
    ingredientFindMany.mockResolvedValue([{ rawMaterialId: "rm1" }, { rawMaterialId: "rm2" }]);
  });

  it("passes when every formula ingredient has at least one weighing", async () => {
    eventFindMany.mockResolvedValueOnce([{ payload: { rawMaterialLotId: "lotA" } }, { payload: { rawMaterialLotId: "lotB" } }]);
    lotFindMany.mockResolvedValueOnce([{ rawMaterialId: "rm1" }, { rawMaterialId: "rm2" }]);
    await expect(assertAllIngredientsWeighed(tx, "t1", target)).resolves.toBeUndefined();
    expect(lotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["lotA", "lotB"] }, tenantId: "t1" } }),
    );
  });

  it("fails when only one of two ingredients was weighed", async () => {
    eventFindMany.mockResolvedValueOnce([{ payload: { rawMaterialLotId: "lotA" } }]);
    lotFindMany.mockResolvedValueOnce([{ rawMaterialId: "rm1" }]);
    expect(await codeOf(assertAllIngredientsWeighed(tx, "t1", target))).toBe("BAD_REQUEST");
  });

  it("fails when two lots of the same ingredient were weighed but another ingredient was not", async () => {
    eventFindMany.mockResolvedValueOnce([{ payload: { rawMaterialLotId: "lotA" } }, { payload: { rawMaterialLotId: "lotA2" } }]);
    lotFindMany.mockResolvedValueOnce([{ rawMaterialId: "rm1" }, { rawMaterialId: "rm1" }]);
    expect(await codeOf(assertAllIngredientsWeighed(tx, "t1", target))).toBe("BAD_REQUEST");
  });

  it("fails when nothing was weighed at all", async () => {
    eventFindMany.mockResolvedValueOnce([]);
    expect(await codeOf(assertAllIngredientsWeighed(tx, "t1", target))).toBe("BAD_REQUEST");
  });
});

describe("getMissingIngredients", () => {
  const target = { id: ORDER_ID, formulaId: "f1" };

  beforeEach(() => {
    ingredientFindMany.mockResolvedValue([
      { rawMaterialId: "rm1" },
      { rawMaterialId: "rm2" },
      { rawMaterialId: "rm3" },
    ]);
  });

  it("reports every ingredient as missing when nothing was weighed yet", async () => {
    eventFindMany.mockResolvedValueOnce([]);
    const missing = await getMissingIngredients(tx, "t1", target);
    expect(missing).toEqual([{ rawMaterialId: "rm1" }, { rawMaterialId: "rm2" }, { rawMaterialId: "rm3" }]);
  });

  it("reports only the ingredients that still lack a weighing", async () => {
    eventFindMany.mockResolvedValueOnce([{ payload: { rawMaterialLotId: "lotA" } }]);
    lotFindMany.mockResolvedValueOnce([{ rawMaterialId: "rm1" }]);
    const missing = await getMissingIngredients(tx, "t1", target);
    expect(missing).toEqual([{ rawMaterialId: "rm2" }, { rawMaterialId: "rm3" }]);
  });

  it("reports nothing missing once every ingredient has a weighing", async () => {
    eventFindMany.mockResolvedValueOnce([
      { payload: { rawMaterialLotId: "lotA" } },
      { payload: { rawMaterialLotId: "lotB" } },
      { payload: { rawMaterialLotId: "lotC" } },
    ]);
    lotFindMany.mockResolvedValueOnce([
      { rawMaterialId: "rm1" },
      { rawMaterialId: "rm2" },
      { rawMaterialId: "rm3" },
    ]);
    const missing = await getMissingIngredients(tx, "t1", target);
    expect(missing).toEqual([]);
  });
});

describe("WEIGHABLE_STATUSES", () => {

  it("includes both planificado and pesado", () => {
    expect(WEIGHABLE_STATUSES).toContain("planificado");
    expect(WEIGHABLE_STATUSES).toContain("pesado");
  });
});
