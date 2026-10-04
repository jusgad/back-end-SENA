import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { router, roleProcedure } from "../trpc";

const fakePrisma = {} as unknown as PrismaClient;

const testRouter = router({
  onlyQuality: roleProcedure("calidad").query(() => "ok"),
});

describe("roleProcedure", () => {
  it("rejects a caller whose role isn't in the allow-list", async () => {
    const caller = testRouter.createCaller({
      user: { id: "u1", tenantId: "t1", role: "operario" },
      prisma: fakePrisma,
    });
    await expect(caller.onlyQuality()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
