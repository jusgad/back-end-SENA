import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TRPCContext } from "./context";
import type { Role } from "@prisma/client";
import { withTenant } from "@backend/db";

const t = initTRPC.context<TRPCContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export function roleProcedure(...roles: Role[]) {
  return protectedProcedure.use(({ ctx, next }) => {
    if (!roles.includes(ctx.user.role)) throw new TRPCError({ code: "FORBIDDEN" });
    return next({ ctx });
  });
}

export function tenantTx<T>(ctx: TRPCContext, fn: Parameters<typeof withTenant<T>>[2]) {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return withTenant(ctx.user.tenantId, ctx.user.id, fn);
}
