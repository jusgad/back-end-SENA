import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: "u1", orgId: "org1" }) }));

const { withTenant, findUnique } = vi.hoisted(() => {
  const findUnique = vi.fn(async () => ({ id: "u1", tenantId: "org1", role: "operario", active: true }));
  const withTenant = vi.fn((_tenantId: string, _actorUserId: string, fn: (tx: unknown) => unknown) =>
    fn({ user: { findUnique } }),
  );
  return { withTenant, findUnique };
});
vi.mock("@backend/db", () => ({ withTenant }));

import { requireRole, getCurrentUser, ForbiddenError } from "@backend/auth";

describe("requireRole", () => {
  it("throws ForbiddenError when the user's role isn't in the allow-list", async () => {
    await expect(requireRole(["director_tecnico"])).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("getCurrentUser", () => {
  beforeEach(() => {
    withTenant.mockClear();
    findUnique.mockClear();
  });

  // Final-review fix (Critical 2c): the lookup must run with
  // `app.current_tenant_id` set to the session's org, or it would match no
  // rows once the `users` RLS policy is enforced.
  it("looks the user up inside withTenant scoped to the session's organization", async () => {
    await expect(getCurrentUser()).resolves.toEqual({ id: "u1", tenantId: "org1", role: "operario" });
    expect(withTenant).toHaveBeenCalledWith("org1", "u1", expect.any(Function));
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "u1" } });
  });

  it("returns null when the user row belongs to a different tenant than the active org", async () => {
    findUnique.mockResolvedValueOnce({ id: "u1", tenantId: "org2", role: "operario", active: true });
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});
