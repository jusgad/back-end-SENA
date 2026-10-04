import { getCurrentUser } from "@backend/auth";
import { prisma } from "@backend/db";

export async function createTRPCContext() {
  const user = await getCurrentUser();
  return { prisma, user };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;
