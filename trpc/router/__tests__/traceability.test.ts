import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

type BatchEventWhereInput = Prisma.BatchEventWhereInput;
type WeighingEvent = { id: string; productionOrderId: string; payload: Prisma.JsonValue };

const batchEvents: WeighingEvent[] = [
  { id: "ev1", productionOrderId: "po1", payload: { rawMaterialLotId: "lot1" } },
];

const batchEventFindMany = vi.fn(async (args: { where: BatchEventWhereInput }): Promise<WeighingEvent[]> => {
  void args;
  return batchEvents;
});
const rawMaterialLotFindFirstOrThrow = vi.fn(async () => ({ id: "lot1", supplierLotCode: "SUP-001" }));
const rawMaterialLotFindMany = vi.fn(async () => [{ id: "lot1", supplierLotCode: "SUP-001" }]);
const finishedProductLotFindFirstOrThrow = vi.fn(async () => ({
  id: "flot1",
  code: "PT-0001",
  productionOrderId: "po1",
}));
const productionOrderFindMany = vi.fn(async () => [{ id: "po1", orderNumber: "OP-2026-001" }]);

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({
      batchEvent: { findMany: batchEventFindMany },
      rawMaterialLot: { findFirstOrThrow: rawMaterialLotFindFirstOrThrow, findMany: rawMaterialLotFindMany },
      finishedProductLot: { findFirstOrThrow: finishedProductLotFindFirstOrThrow },
      productionOrder: { findMany: productionOrderFindMany },
    }),
}));

import { traceabilityRouter } from "../traceability";

const caller = (role: "calidad" | "director_tecnico") =>
  traceabilityRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

describe("traceability.byRawMaterialLot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rawMaterialLotFindFirstOrThrow.mockResolvedValue({ id: "lot1", supplierLotCode: "SUP-001" });
    batchEventFindMany.mockResolvedValue(batchEvents);
    productionOrderFindMany.mockResolvedValue([{ id: "po1", orderNumber: "OP-2026-001" }]);
  });

  it("resolves the lot code to an id, then returns the distinct production orders (with human-readable orderNumber) that consumed it", async () => {
    const result = await caller("calidad").byRawMaterialLot({ rawMaterialLotCode: "SUP-001" });

    expect(rawMaterialLotFindFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "t1" }),
      }),
    );
    expect(batchEventFindMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", eventType: "weighing" },
    });
    expect(productionOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "t1", id: { in: ["po1"] } }),
      }),
    );
    expect(result).toEqual([{ id: "po1", orderNumber: "OP-2026-001" }]);
  });

  it("dedupes production orders across multiple weighing events for the same lot", async () => {
    batchEventFindMany.mockResolvedValue([
      { id: "ev1", productionOrderId: "po1", payload: { rawMaterialLotId: "lot1" } },
      { id: "ev2", productionOrderId: "po1", payload: { rawMaterialLotId: "lot1" } },
      { id: "ev3", productionOrderId: "po2", payload: { rawMaterialLotId: "other-lot" } },
    ]);

    const result = await caller("director_tecnico").byRawMaterialLot({ rawMaterialLotCode: "SUP-001" });

    expect(productionOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["po1"] } }),
      }),
    );
    expect(result).toEqual([{ id: "po1", orderNumber: "OP-2026-001" }]);
  });

  it("returns an empty list without querying production orders when no weighing event matches", async () => {
    batchEventFindMany.mockResolvedValue([]);

    const result = await caller("calidad").byRawMaterialLot({ rawMaterialLotCode: "SUP-001" });

    expect(productionOrderFindMany).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe("traceability.byFinishedLot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    finishedProductLotFindFirstOrThrow.mockResolvedValue({
      id: "flot1",
      code: "PT-0001",
      productionOrderId: "po1",
    });
    batchEventFindMany.mockResolvedValue(batchEvents);
    rawMaterialLotFindMany.mockResolvedValue([{ id: "lot1", supplierLotCode: "SUP-001" }]);
  });

  it("resolves the finished-lot code, then returns the raw material lots (with human-readable supplierLotCode) consumed in its production order", async () => {
    const result = await caller("calidad").byFinishedLot({ finishedProductLotCode: "PT-0001" });

    expect(finishedProductLotFindFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "t1", code: "PT-0001" }),
      }),
    );
    expect(batchEventFindMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", productionOrderId: "po1", eventType: "weighing" },
    });
    expect(rawMaterialLotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "t1", id: { in: ["lot1"] } }),
      }),
    );
    expect(result).toEqual([{ id: "lot1", supplierLotCode: "SUP-001" }]);
  });

  it("filters out weighing events with no rawMaterialLotId in the payload", async () => {
    batchEventFindMany.mockResolvedValue([
      { id: "ev1", productionOrderId: "po1", payload: { rawMaterialLotId: "lot1" } },
      { id: "ev2", productionOrderId: "po1", payload: {} },
    ]);

    const result = await caller("calidad").byFinishedLot({ finishedProductLotCode: "PT-0001" });

    expect(result).toEqual([{ id: "lot1", supplierLotCode: "SUP-001" }]);
  });

  it("returns an empty list without querying raw material lots when no weighing event has a lot id", async () => {
    batchEventFindMany.mockResolvedValue([{ id: "ev1", productionOrderId: "po1", payload: {} }]);

    const result = await caller("calidad").byFinishedLot({ finishedProductLotCode: "PT-0001" });

    expect(rawMaterialLotFindMany).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
