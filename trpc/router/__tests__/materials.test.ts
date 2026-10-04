import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma, RawMaterialLot } from "@prisma/client";
import { TRPCError } from "@trpc/server";

type CreateArgs = Prisma.RawMaterialLotCreateArgs;

let rawMaterial: { id: string } | null;
let setStatusCount: number;

const create = vi.fn(async (args: CreateArgs): Promise<RawMaterialLot> => {
  return {
    ...(args.data as unknown as RawMaterialLot),
    id: "lot-1",
  };
});
const rawMaterialFindFirst = vi.fn(async () => rawMaterial);
const lotUpdateMany = vi.fn(async () => ({ count: setStatusCount }));
const lotFindFirstOrThrow = vi.fn(async () => ({ id: "lot-1", status: "liberado" }));

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({
      rawMaterial: { findFirst: rawMaterialFindFirst },
      rawMaterialLot: { create, updateMany: lotUpdateMany, findFirstOrThrow: lotFindFirstOrThrow },
    }),
}));

import { materialsRouter } from "../materials";

const caller = (role: "bodega" | "calidad" = "bodega") =>
  materialsRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

const LOT_ID = "550e8400-e29b-41d4-a716-446655440009";

beforeEach(() => {
  vi.clearAllMocks();
  rawMaterial = { id: "550e8400-e29b-41d4-a716-446655440000" };
  setStatusCount = 1;
});

describe("materials.receiveLot", () => {
  it("accepts a lot with no supplierProvidedCode and still generates an internal qrCode", async () => {
    const result = await caller().receiveLot({
      rawMaterialId: "550e8400-e29b-41d4-a716-446655440000",
      supplierLotCode: "SUP-123",
      quantityReceived: 25,
      expiryDate: "2027-01-01",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "cuarentena", qrCode: expect.any(String), tenantId: "t1" }),
      }),
    );
    expect(result.id).toBe("lot-1");
  });

  it("rejects a raw material that doesn't belong to the caller's tenant", async () => {
    rawMaterial = null;
    const error = await caller()
      .receiveLot({
        rawMaterialId: "550e8400-e29b-41d4-a716-446655440000",
        supplierLotCode: "SUP-123",
        quantityReceived: 25,
        expiryDate: "2027-01-01",
      })
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
    expect(rawMaterialFindFirst).toHaveBeenCalledWith({
      where: { id: "550e8400-e29b-41d4-a716-446655440000", tenantId: "t1" },
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("materials.setStatus", () => {
  it("scopes the guarded transition to the caller's tenant", async () => {
    await caller("calidad").setStatus({ id: LOT_ID, status: "liberado" });
    expect(lotUpdateMany).toHaveBeenCalledWith({
      where: { id: LOT_ID, tenantId: "t1", status: "cuarentena" },
      data: { status: "liberado" },
    });
    expect(lotFindFirstOrThrow).toHaveBeenCalledWith({ where: { id: LOT_ID, tenantId: "t1" } });
  });

  it("throws CONFLICT when no lot in cuarentena matched for this tenant", async () => {
    setStatusCount = 0;
    await expect(caller("calidad").setStatus({ id: LOT_ID, status: "liberado" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
