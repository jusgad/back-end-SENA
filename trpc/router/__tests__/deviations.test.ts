import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

type DeviationCreateArgs = Prisma.DeviationCreateArgs;
type DeviationUpdateManyArgs = Prisma.DeviationUpdateManyArgs;

const deviationCreate = vi.fn(async (args: DeviationCreateArgs) => ({ id: "dev1", ...args.data }));
let updateManyCount = 1;
const deviationUpdateMany = vi.fn(async (args: DeviationUpdateManyArgs): Promise<{ count: number }> => {
  void args; 
  return { count: updateManyCount };
});
const deviationFindFirstOrThrow = vi.fn(async () => ({
  id: "dev1",
  tenantId: "t1",
  productionOrderId: "po1",
  description: "desc",
  investigation: "inv",
  correctiveAction: "ca",
  status: "cerrada" as const,
  raisedBy: "u1",
  approvedBy: "u2",
  approvedAt: new Date(),
}));
const deviationFindMany = vi.fn(async () => []);
let deviationById: { id: string } | null = { id: "dev1" };
const deviationFindFirst = vi.fn(async () => deviationById);
let orderForCreate: { id: string } | null = { id: "po1" };
const productionOrderFindFirst = vi.fn(async () => orderForCreate);

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({
      deviation: {
        create: deviationCreate,
        updateMany: deviationUpdateMany,
        findFirstOrThrow: deviationFindFirstOrThrow,
        findFirst: deviationFindFirst,
        findMany: deviationFindMany,
      },
      productionOrder: { findFirst: productionOrderFindFirst },
    }),
}));

import { deviationsRouter } from "../deviations";

const caller = (role: "calidad" | "jefe_planta" | "operario" | "director_tecnico" | "bodega" | "admin") =>
  deviationsRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

describe("deviations.approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManyCount = 1;
  });

  it("rejects approval from a role other than director_tecnico (brief's literal Step 1 scenario)", async () => {
    await expect(caller("calidad").approve({ id: "550e8400-e29b-41d4-a716-446655440000" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("approves a pendiente_aprobacion deviation as director_tecnico, closing it", async () => {
    const result = await caller("director_tecnico").approve({ id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.status).toBe("cerrada");
    expect(deviationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "pendiente_aprobacion" }),
        data: expect.objectContaining({ status: "cerrada", approvedBy: "u1" }),
      }),
    );
  });

  it("throws CONFLICT (TOCTOU guard) when the deviation is no longer pendiente_aprobacion", async () => {
    updateManyCount = 0;
    await expect(caller("director_tecnico").approve({ id: "550e8400-e29b-41d4-a716-446655440000" })).rejects.toMatchObject(
      { code: "CONFLICT" },
    );
  });
});

describe("deviations.create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManyCount = 1;
    orderForCreate = { id: "po1" };
  });

  it("rejects a productionOrderId that doesn't belong to the caller's tenant", async () => {
    orderForCreate = null;
    await expect(
      caller("operario").create({ productionOrderId: "550e8400-e29b-41d4-a716-446655440000", description: "0123456789" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(productionOrderFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "550e8400-e29b-41d4-a716-446655440000", tenantId: "t1" } }),
    );
    expect(deviationCreate).not.toHaveBeenCalled();
  });

  it("rejects create from a role not in calidad/jefe_planta/operario", async () => {
    await expect(
      caller("bodega").create({ productionOrderId: "550e8400-e29b-41d4-a716-446655440000", description: "0123456789" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("creates a deviation with status abierta", async () => {
    const result = await caller("operario").create({
      productionOrderId: "550e8400-e29b-41d4-a716-446655440000",
      description: "0123456789",
    });
    expect(result.status).toBe("abierta");
    expect(deviationCreate).toHaveBeenCalled();
  });
});

describe("deviations.startInvestigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManyCount = 1;
  });

  it("rejects startInvestigation from a role other than calidad", async () => {
    await expect(
      caller("operario").startInvestigation({ id: "550e8400-e29b-41d4-a716-446655440000" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("moves abierta -> en_investigacion, recording who/when it started", async () => {
    const result = await caller("calidad").startInvestigation({ id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(deviationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "abierta" }),
        data: expect.objectContaining({ status: "en_investigacion", investigationStartedBy: "u1" }),
      }),
    );
    expect(result.id).toBe("dev1");
  });

  it("throws CONFLICT (TOCTOU guard) when the deviation is not abierta", async () => {
    updateManyCount = 0;
    await expect(
      caller("calidad").startInvestigation({ id: "550e8400-e29b-41d4-a716-446655440000" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("deviations.submitInvestigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManyCount = 1;
  });

  it("rejects submitInvestigation from a role other than calidad", async () => {
    await expect(
      caller("operario").submitInvestigation({
        id: "550e8400-e29b-41d4-a716-446655440000",
        investigation: "0123456789",
        correctiveAction: "0123456789",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("submits investigation + corrective action, moving en_investigacion -> pendiente_aprobacion", async () => {
    const result = await caller("calidad").submitInvestigation({
      id: "550e8400-e29b-41d4-a716-446655440000",
      investigation: "0123456789",
      correctiveAction: "0123456789",
    });
    expect(deviationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "en_investigacion" }),
        data: expect.objectContaining({ status: "pendiente_aprobacion" }),
      }),
    );
    expect(result.id).toBe("dev1");
  });

  it("throws CONFLICT (TOCTOU guard) when the deviation is not en_investigacion", async () => {
    updateManyCount = 0;
    await expect(
      caller("calidad").submitInvestigation({
        id: "550e8400-e29b-41d4-a716-446655440000",
        investigation: "0123456789",
        correctiveAction: "0123456789",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("deviations.getById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deviationById = { id: "dev1" };
  });

  it("filters by id AND the caller's tenant", async () => {
    await caller("calidad").getById({ id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(deviationFindFirst).toHaveBeenCalledWith({
      where: { id: "550e8400-e29b-41d4-a716-446655440000", tenantId: "t1" },
    });
  });

  it("returns NOT_FOUND for a deviation outside the caller's tenant", async () => {
    deviationById = null;
    await expect(caller("calidad").getById({ id: "550e8400-e29b-41d4-a716-446655440000" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("deviations transitions re-read tenant-scoped", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateManyCount = 1;
  });

  it("approve re-reads the deviation with the caller's tenant", async () => {
    await caller("director_tecnico").approve({ id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(deviationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1" }) }),
    );
    expect(deviationFindFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "550e8400-e29b-41d4-a716-446655440000", tenantId: "t1" },
    });
  });
});
