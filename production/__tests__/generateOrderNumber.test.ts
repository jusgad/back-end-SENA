import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";

import { generateOrderNumber } from "../generateOrderNumber";

function fakeTx(count: () => Promise<number>): Prisma.TransactionClient {
  return { productionOrder: { count } } as unknown as Prisma.TransactionClient;
}

describe("generateOrderNumber", () => {
  it("pads the consecutive to 3 digits under the current year prefix", async () => {
    const count = vi.fn(async () => 4);
    const year = new Date().getFullYear();
    await expect(generateOrderNumber(fakeTx(count), "tenant-1")).resolves.toBe(`OP-${year}-005`);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }),
    );
  });

  it("starts a new tenant at 001 regardless of other tenants' orders", async () => {
    const count = vi.fn(async () => 0);
    const year = new Date().getFullYear();
    await expect(generateOrderNumber(fakeTx(count), "tenant-2")).resolves.toBe(`OP-${year}-001`);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-2" }) }),
    );
  });
});
