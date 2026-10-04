import { router } from "@backend/trpc/trpc";
import { materialsRouter } from "@backend/trpc/router/materials";
import { formulasRouter } from "@backend/trpc/router/formulas";
import { productionRouter } from "@backend/trpc/router/production";
import { qcRouter } from "@backend/trpc/router/qc";
import { deviationsRouter } from "@backend/trpc/router/deviations";
import { traceabilityRouter } from "@backend/trpc/router/traceability";
import { auditRouter } from "@backend/trpc/router/audit";

export const appRouter = router({
  materials: materialsRouter,
  formulas: formulasRouter,
  production: productionRouter,
  qc: qcRouter,
  deviations: deviationsRouter,
  traceability: traceabilityRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;
