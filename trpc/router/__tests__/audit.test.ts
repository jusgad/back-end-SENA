import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";

type AuditLogWhereInput = Prisma.AuditLogWhereInput;
type AuditRow = {
  id: string;
  tenantId: string;
  tableName: string;
  recordId: string;
  action: string;
  beforeData: Prisma.JsonValue | null;
  afterData: Prisma.JsonValue | null;
  actorUserId: string;
  occurredAt: Date;
};

const rows: AuditRow[] = [
  {
    id: "log1",
    tenantId: "t1",
    tableName: "ProductionOrder",
    recordId: "po1",
    action: "update",
    beforeData: null,
    afterData: { status: "pesado" },
    actorUserId: "u1",
    occurredAt: new Date("2026-01-01T10:00:00.000Z"),
  },
];

const auditLogFindMany = vi.fn(async (args: { where: AuditLogWhereInput }): Promise<AuditRow[]> => {
  void args;
  return rows;
});

vi.mock("@backend/db", () => ({
  withTenant: (_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({ auditLog: { findMany: auditLogFindMany } }),
}));

import { auditRouter } from "../audit";

const caller = (role: "admin" | "director_tecnico" | "operario") =>
  auditRouter.createCaller({ user: { id: "u1", tenantId: "t1", role }, prisma: {} as never });

describe("audit.search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogFindMany.mockResolvedValue(rows);
  });

  it("rejects a caller without admin/director_tecnico role", async () => {
    await expect(caller("operario").search({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(auditLogFindMany).not.toHaveBeenCalled();
  });

  it("scopes the query to the caller's tenant and applies filters", async () => {
    const result = await caller("admin").search({ tableName: "ProductionOrder", actorUserId: "u1" });

    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "t1", tableName: "ProductionOrder", actorUserId: "u1" }),
      }),
    );
    expect(result).toEqual(rows);
  });

  it("applies a date range filter when dateFrom/dateTo are given", async () => {
    await caller("director_tecnico").search({
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-01-31T00:00:00.000Z",
    });

    expect(auditLogFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurredAt: { gte: new Date("2026-01-01T00:00:00.000Z"), lte: new Date("2026-01-31T00:00:00.000Z") },
        }),
      }),
    );
  });
});

describe("audit.export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogFindMany.mockResolvedValue(rows);
  });

  it("rejects a caller without admin/director_tecnico role", async () => {
    await expect(caller("operario").export({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("returns a CSV string with a header row and one row per audit_log entry", async () => {
    const csv = await caller("admin").export({});
    const lines = csv.split("\n");

    expect(lines[0]).toBe("occurredAt,tableName,recordId,action,actorUserId,afterData");
    expect(lines[1]).toContain("ProductionOrder");
    expect(lines[1]).toContain("po1");
    expect(lines[1]).toContain("update");
    expect(lines[1]).toContain("u1");
    expect(lines).toHaveLength(2);
  });

  it("quotes CSV fields containing a comma", async () => {
    auditLogFindMany.mockResolvedValue([
      { ...rows[0], afterData: { note: "a, b" } },
    ]);

    const csv = await caller("admin").export({});
    expect(csv).toContain('"{""note"":""a, b""}"');
  });
});
