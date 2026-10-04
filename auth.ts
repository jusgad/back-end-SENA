import { auth } from "@clerk/nextjs/server";
import { withTenant } from "@backend/db";
import type { Role } from "@prisma/client";

export type CurrentUser = { id: string; tenantId: string; role: Role };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return null;
  const user = await withTenant(orgId, userId, (tx) => tx.user.findUnique({ where: { id: userId } }));
  if (!user || !user.active || user.tenantId !== orgId) return null;
  return { id: user.id, tenantId: user.tenantId, role: user.role };
}

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export async function requireRole(allowed: Role[]): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError("No hay sesion activa");
  if (!allowed.includes(user.role)) throw new ForbiddenError(`Rol ${user.role} no autorizado`);
  return user;
}
