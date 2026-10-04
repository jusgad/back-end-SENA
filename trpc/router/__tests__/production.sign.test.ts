import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";

type SignatureCreateArgs = Prisma.BatchSignatureCreateArgs;
type EventCreateArgs = Prisma.BatchEventCreateArgs;
type MockOrder = { id: string; formulaId: string; status: string };

let currentOrder: MockOrder | null = { id: "po1", formulaId: "f1", status: "pesado" };
const batchSignatureCreate = vi.fn(async (args: SignatureCreateArgs) => ({ id: "sig1", ...args.data }));
const batchEventCreate = vi.fn(async (args: EventCreateArgs) => ({ id: "ev1", ...args.data }));
const findFirst = vi.fn(async (): Promise<MockOrder | null> => currentOrder);

const updateMany = vi.fn(async (): Promise<{ count: number }> => ({ count: 1 }));

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({
      batchSignature: { create: batchSignatureCreate },
      batchEvent: { create: batchEventCreate },
      productionOrder: { findFirst, updateMany },
    }),
}));

const { assertAllIngredientsWeighed } = vi.hoisted(() => ({
  assertAllIngredientsWeighed: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("@backend/production/weighing", () => ({ assertAllIngredientsWeighed, applyWeighing: vi.fn() }));

let hasReverification = true;
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ has: (): boolean => hasReverification }),
}));

import { productionRouter } from "../production";

type Role = "operario" | "jefe_planta" | "calidad" | "director_tecnico" | "admin";
const caller = (role: Role = "operario") =>
  productionRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

const ORDER_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("production.sign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasReverification = true;
    currentOrder = { id: "po1", formulaId: "f1", status: "pesado" };
  });

  it("rejects when reauthVerified is false", async () => {
    await expect(
      caller().sign({
        productionOrderId: ORDER_ID,
        stage: "pesado",
        meaningStatement: "Confirmo el pesaje",
        reauthVerified: false as unknown as true,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("rejects an empty meaningStatement even if reauthVerified is true", async () => {
    await expect(
      caller().sign({ productionOrderId: ORDER_ID, stage: "pesado", meaningStatement: "", reauthVerified: true }),
    ).rejects.toThrow();
  });

  it("rejects when the server-side reverification check fails, even though the client claims reauthVerified: true", async () => {
    hasReverification = false;
    const error = await caller()
      .sign({ productionOrderId: ORDER_ID, stage: "pesado", meaningStatement: "Confirmo el pesaje realizado", reauthVerified: true })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("UNAUTHORIZED");
    expect(batchSignatureCreate).not.toHaveBeenCalled();
  });

  it("records the signature, appends a signature event, and advances 'pesado' -> 'mezclado'", async () => {
    await caller().sign({
      productionOrderId: ORDER_ID,
      stage: "pesado",
      meaningStatement: "Confirmo el pesaje realizado",
      reauthVerified: true,
    });

    expect(findFirst).toHaveBeenCalledWith({ where: { id: ORDER_ID, tenantId: "t1" } });
    expect(assertAllIngredientsWeighed).toHaveBeenCalledWith(expect.anything(), "t1", currentOrder);
    expect(batchSignatureCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stage: "pesado",
          signedBy: "u1",
          reauthVerified: true,
          meaningStatement: "Confirmo el pesaje realizado",
        }),
      }),
    );
    expect(batchEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: "signature" }) }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "po1", tenantId: "t1", status: "pesado" },
      data: { status: "mezclado" },
    });
  });

  it("rejects when the input stage doesn't match the order's actual status", async () => {
    await expect(
      caller().sign({
        productionOrderId: ORDER_ID,
        stage: "mezclado",
        meaningStatement: "Confirmo el mezclado realizado",
        reauthVerified: true,
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(batchSignatureCreate).not.toHaveBeenCalled();
  });

  it.each(["planificado", "liberado", "rechazado", "anything"])(
    "rejects signing the non-signable stage '%s' at input validation",
    async (stage) => {
      currentOrder = { id: "po1", formulaId: "f1", status: "planificado" };
      const error = await caller()
        .sign({
          productionOrderId: ORDER_ID,
          stage: stage as "pesado",
          meaningStatement: "Confirmo la etapa realizada",
          reauthVerified: true,
        })
        .catch((e: unknown) => e);
      expect((error as TRPCError).code).toBe("BAD_REQUEST");
      expect(batchSignatureCreate).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    },
  );

  it("forbids an operario from signing the 'calidad' stage", async () => {
    currentOrder = { id: "po1", formulaId: "f1", status: "calidad" };
    const error = await caller("operario")
      .sign({ productionOrderId: ORDER_ID, stage: "calidad", meaningStatement: "Confirmo la calidad del lote", reauthVerified: true })
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("FORBIDDEN");
    expect(batchSignatureCreate).not.toHaveBeenCalled();
  });

  it("forbids a calidad user from signing a production-floor stage ('pesado')", async () => {
    const error = await caller("calidad")
      .sign({ productionOrderId: ORDER_ID, stage: "pesado", meaningStatement: "Confirmo el pesaje realizado", reauthVerified: true })
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("FORBIDDEN");
    expect(batchSignatureCreate).not.toHaveBeenCalled();
  });

  it("lets a calidad user sign the 'calidad' stage, without auto-advancing to a QC verdict", async () => {
    currentOrder = { id: "po1", formulaId: "f1", status: "calidad" };
    await caller("calidad").sign({
      productionOrderId: ORDER_ID,
      stage: "calidad",
      meaningStatement: "Confirmo la validación de calidad",
      reauthVerified: true,
    });
    expect(batchSignatureCreate).toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(assertAllIngredientsWeighed).not.toHaveBeenCalled();
  });

  it("lets a jefe_planta sign 'envasado', advancing to 'calidad'", async () => {
    currentOrder = { id: "po1", formulaId: "f1", status: "envasado" };
    await caller("jefe_planta").sign({
      productionOrderId: ORDER_ID,
      stage: "envasado",
      meaningStatement: "Confirmo el envasado realizado",
      reauthVerified: true,
    });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "calidad" } }));
  });

  it("refuses to sign 'pesado' while formula ingredients remain unweighed", async () => {
    assertAllIngredientsWeighed.mockRejectedValueOnce(new TRPCError({ code: "BAD_REQUEST", message: "Faltan ingredientes" }));
    const error = await caller()
      .sign({ productionOrderId: ORDER_ID, stage: "pesado", meaningStatement: "Confirmo el pesaje realizado", reauthVerified: true })
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    expect(batchSignatureCreate).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("treats an order outside the caller's tenant as NOT_FOUND", async () => {
    currentOrder = null;
    const error = await caller()
      .sign({ productionOrderId: ORDER_ID, stage: "pesado", meaningStatement: "Confirmo el pesaje realizado", reauthVerified: true })
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe("NOT_FOUND");
    expect(batchSignatureCreate).not.toHaveBeenCalled();
  });
});
