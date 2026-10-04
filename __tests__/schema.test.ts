import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";

// Final-review fix (Critical 1): `ProductionOrder.orderNumber` was globally
// `@unique` while `generateOrderNumber` numbers per tenant, so every tenant
// after the first collided on `OP-<year>-001`. Asserted against the generated
// client's DMMF (no database needed), so a regression in schema.prisma fails
// here after `prisma generate`.
function model(name: string) {
  const found = Prisma.dmmf.datamodel.models.find((m) => m.name === name);
  if (!found) throw new Error(`model ${name} not found in DMMF`);
  return found;
}

describe("schema uniqueness is per tenant", () => {
  it("ProductionOrder.orderNumber is unique per tenant, not globally", () => {
    const order = model("ProductionOrder");
    expect(order.fields.find((f) => f.name === "orderNumber")?.isUnique).toBe(false);
    expect(order.uniqueFields).toContainEqual(["tenantId", "orderNumber"]);
  });

  it("FinishedProductLot.code (derived from orderNumber on release) is unique per tenant", () => {
    const lot = model("FinishedProductLot");
    expect(lot.fields.find((f) => f.name === "code")?.isUnique).toBe(false);
    expect(lot.uniqueFields).toContainEqual(["tenantId", "code"]);
  });
});
