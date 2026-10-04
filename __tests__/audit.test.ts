import { describe, it, expect } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { withAuditLog } from "../audit";

type AuditLogCreateArgs = Prisma.AuditLogCreateArgs;

type AllOperationsParams = {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
};

function getAllOperations(client: PrismaClient): (params: AllOperationsParams) => Promise<unknown> {
  return (
    client as unknown as {
      query: { $allModels: { $allOperations: (params: AllOperationsParams) => Promise<unknown> } };
    }
  ).query.$allModels.$allOperations;
}

function fakePrisma(created: AuditLogCreateArgs["data"][]): PrismaClient {
  return {
    $extends: (config: unknown) => config,
    auditLog: { create: async (args: AuditLogCreateArgs) => created.push(args.data) },
  } as unknown as PrismaClient;
}

describe("withAuditLog", () => {
  it("writes an audit_log row for every write on a regulated model", async () => {
    const created: AuditLogCreateArgs["data"][] = [];
    const basePrisma = fakePrisma(created);
    const { client } = withAuditLog(basePrisma, "actor-1", "tenant-1");
    const query = getAllOperations(client);

    await query({
      model: "ProductionOrder",
      operation: "update",
      args: { where: { id: "po1" }, data: { status: "pesado" } },
      query: async (args: Record<string, unknown>) => ({
        id: "po1",
        status: (args.data as { status: string }).status,
      }),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      tableName: "ProductionOrder",
      action: "update",
      actorUserId: "actor-1",
      tenantId: "tenant-1",
      recordId: "po1",
    });
  });

  it("does not audit reads or non-regulated models", async () => {
    const created: AuditLogCreateArgs["data"][] = [];
    const basePrisma = fakePrisma(created);
    const { client } = withAuditLog(basePrisma, "actor-1", "tenant-1");
    const query = getAllOperations(client);

    await query({ model: "RawMaterial", operation: "findMany", args: {}, query: async () => [] });
    expect(created).toHaveLength(0);
  });

  it("falls back to the where-clause id when the result has no id (e.g. updateMany)", async () => {
    const created: AuditLogCreateArgs["data"][] = [];
    const basePrisma = fakePrisma(created);
    const { client } = withAuditLog(basePrisma, "actor-1", "tenant-1");
    const query = getAllOperations(client);

    await query({
      model: "Deviation",
      operation: "updateMany",
      args: { where: { id: "dev1", status: "abierta" }, data: { status: "en_investigacion" } },
      query: async () => ({ count: 1 }),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tableName: "Deviation", action: "updateMany", recordId: "dev1" });
  });

  it('records recordId as "unknown" when neither the result nor the where clause carries an id', async () => {
    const created: AuditLogCreateArgs["data"][] = [];
    const basePrisma = fakePrisma(created);
    const { client } = withAuditLog(basePrisma, "actor-1", "tenant-1");
    const query = getAllOperations(client);

    await query({
      model: "QcResult",
      operation: "createMany",
      args: { data: [{ result: "pass" }] },
      query: async () => ({ count: 1 }),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ tableName: "QcResult", action: "createMany", recordId: "unknown" });
  });

  it("routes the audit write through the bound transaction client, not the original outer client", async () => {
    const outerCreated: AuditLogCreateArgs["data"][] = [];
    const txCreated: AuditLogCreateArgs["data"][] = [];

    const outerPrisma = fakePrisma(outerCreated);
    const txClient = { auditLog: { create: async (args: AuditLogCreateArgs) => txCreated.push(args.data) } } as unknown as PrismaClient;

    const { client, bindTransactionClient } = withAuditLog(outerPrisma, "actor-1", "tenant-1");
    const query = getAllOperations(client);

    bindTransactionClient(txClient);

    await query({
      model: "ProductionOrder",
      operation: "update",
      args: { where: { id: "po1" }, data: { status: "pesado" } },
      query: async () => ({ id: "po1", status: "pesado" }),
    });

    expect(txCreated).toHaveLength(1);
    expect(txCreated[0]).toMatchObject({ tableName: "ProductionOrder", recordId: "po1" });

    expect(outerCreated).toHaveLength(0);
  });

  it("writes through the original outer client when bindTransactionClient was never called", async () => {
    const outerCreated: AuditLogCreateArgs["data"][] = [];
    const basePrisma = fakePrisma(outerCreated);
    const { client } = withAuditLog(basePrisma, "actor-1", "tenant-1");
    const query = getAllOperations(client);

    await query({
      model: "ProductionOrder",
      operation: "update",
      args: { where: { id: "po1" }, data: { status: "pesado" } },
      query: async () => ({ id: "po1", status: "pesado" }),
    });

    expect(outerCreated).toHaveLength(1);
  });

  it("snapshots before/after row state for an updateMany targeting a where.id", async () => {
    const txCreated: AuditLogCreateArgs["data"][] = [];
    const rows: Record<string, { id: string; status: string }> = { po1: { id: "po1", status: "planificado" } };
    const findFirstCalls: unknown[] = [];
    const txClient = {
      auditLog: { create: async (args: AuditLogCreateArgs) => txCreated.push(args.data) },
      productionOrder: {
        findFirst: async (args: { where: { id: string } }) => {
          findFirstCalls.push(args);
          return { ...rows[args.where.id] };
        },
      },
    } as unknown as PrismaClient;

    const { client, bindTransactionClient } = withAuditLog(fakePrisma([]), "actor-1", "tenant-1");
    bindTransactionClient(txClient);
    const query = getAllOperations(client);

    const result = await query({
      model: "ProductionOrder",
      operation: "updateMany",
      args: { where: { id: "po1", tenantId: "tenant-1", status: "planificado" }, data: { status: "pesado" } },
      query: async () => {
        rows.po1 = { id: "po1", status: "pesado" };
        return { count: 1 };
      },
    });

    expect(result).toEqual({ count: 1 });
    expect(findFirstCalls).toEqual([
      { where: { id: "po1", tenantId: "tenant-1" } },
      { where: { id: "po1", tenantId: "tenant-1" } },
    ]);
    expect(txCreated).toHaveLength(1);
    expect(txCreated[0]).toMatchObject({
      tableName: "ProductionOrder",
      action: "updateMany",
      recordId: "po1",
      beforeData: { id: "po1", status: "planificado" },
      afterData: { id: "po1", status: "pesado" },
    });
  });

  it("records beforeData for a single-row update (afterData stays the returned row)", async () => {
    const txCreated: AuditLogCreateArgs["data"][] = [];
    const txClient = {
      auditLog: { create: async (args: AuditLogCreateArgs) => txCreated.push(args.data) },
      deviation: { findFirst: async () => ({ id: "dev1", status: "abierta" }) },
    } as unknown as PrismaClient;

    const { client, bindTransactionClient } = withAuditLog(fakePrisma([]), "actor-1", "tenant-1");
    bindTransactionClient(txClient);

    await getAllOperations(client)({
      model: "Deviation",
      operation: "update",
      args: { where: { id: "dev1" }, data: { status: "en_investigacion" } },
      query: async () => ({ id: "dev1", status: "en_investigacion" }),
    });

    expect(txCreated[0]).toMatchObject({
      beforeData: { id: "dev1", status: "abierta" },
      afterData: { id: "dev1", status: "en_investigacion" },
    });
  });

  it("does not snapshot (no reads) for a create", async () => {
    const txCreated: AuditLogCreateArgs["data"][] = [];
    let reads = 0;
    const txClient = {
      auditLog: { create: async (args: AuditLogCreateArgs) => txCreated.push(args.data) },
      qcResult: {
        findFirst: async () => {
          reads++;
          return null;
        },
      },
    } as unknown as PrismaClient;
    const { client, bindTransactionClient } = withAuditLog(fakePrisma([]), "actor-1", "tenant-1");
    bindTransactionClient(txClient);

    await getAllOperations(client)({
      model: "QcResult",
      operation: "create",
      args: { data: { result: "pass" } },
      query: async () => ({ id: "qc1", result: "pass" }),
    });

    expect(reads).toBe(0);
    expect(txCreated[0].beforeData).toBeUndefined();
    expect(txCreated[0]).toMatchObject({ afterData: { id: "qc1", result: "pass" } });
  });
});
