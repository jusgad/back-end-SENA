import { describe, it, expect, vi, beforeEach } from "vitest";

const executed: { sql: string; values: unknown[] }[] = [];

// Task 17 review round 1 (Critical fix): the previous version of this mock
// fabricated a `$extends` method on `tx` itself — but `Prisma.TransactionClient`
// explicitly strips `$extends` via `ITXClientDenyList` (verified against the
// compiled runtime's deny-list Proxy: a real `tx.$extends` is `undefined`),
// so that mock shape was itself inaccurate and hid the real bug (`withTenant`
// calling `tx.$extends(...)`, which throws at runtime). The fix in `db.ts`
// now extends the top-level `prisma` client BEFORE opening the transaction —
// i.e. it calls `prisma.$extends(...)`, and the object that returns is what
// `.$transaction(...)` is called on. This mock reflects that real shape:
// `FakePrismaClient.$extends` returns an object exposing `$transaction`,
// and `tx` itself (what `fn` receives inside the transaction callback) has
// no `$extends` at all, matching Prisma's actual `TransactionClient` type.
const fakeTx = {
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    executed.push({ sql: strings.join("?"), values });
    return Promise.resolve(1);
  },
};

const transactionMock = vi.fn((fn: (tx: unknown) => Promise<unknown>) =>
  fn(fakeTx),
);

const extendedClient = { $transaction: transactionMock };
const extendsMock = vi.fn(() => extendedClient);

class FakePrismaClient {
  $extends = extendsMock;
}

vi.mock("@prisma/client", () => ({
  PrismaClient: FakePrismaClient,
  Prisma: {},
}));

describe("withTenant", () => {
  beforeEach(() => {
    executed.length = 0;
    transactionMock.mockClear();
    extendsMock.mockClear();
  });

  it("sets app.current_tenant_id before running the callback", async () => {
    const { withTenant } = await import("@backend/db");

    const result = await withTenant("tenant-123", "actor-1", async (tx) => {
      expect(tx).toBe(fakeTx);
      return "ok";
    });

    expect(result).toBe("ok");
    // The extension is applied to `prisma` first, and `$transaction` is
    // called on the *extended* client, not the raw one — asserting the call
    // order this way is what would have caught the original bug (calling
    // `$extends` on `tx` inside the transaction instead).
    expect(extendsMock).toHaveBeenCalledTimes(1);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(1);
    expect(executed[0].sql).toContain("set_config");
    expect(executed[0].values).toContain("tenant-123");
  });

  it("throws when tenantId is empty and never opens a transaction", async () => {
    const { withTenant } = await import("@backend/db");

    await expect(withTenant("", "actor-1", async () => "ok")).rejects.toThrow(
      "tenantId is required",
    );
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
