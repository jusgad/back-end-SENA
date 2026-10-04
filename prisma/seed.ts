
if (process.env.NODE_ENV === "production") {
  throw new Error("Seed no debe correr en produccion");
}

import { PrismaClient, type Role } from "@prisma/client";

const prisma = new PrismaClient();

const ORG_ID = "seed-org-1";

const USER_IDS: Record<Role, string> = {
  operario: "seed-user-operario",
  jefe_planta: "seed-user-jefe-planta",
  calidad: "seed-user-calidad",
  director_tecnico: "seed-user-director-tecnico",
  bodega: "seed-user-bodega",
  admin: "seed-user-admin",
};

const RAW_MATERIAL_IDS = {
  agua: "00000000-0000-4000-8000-000000000001",
  glicerina: "00000000-0000-4000-8000-000000000002",
  fragancia: "00000000-0000-4000-8000-000000000003",
} as const;

const RAW_MATERIAL_LOT_IDS = {
  agua: "00000000-0000-4000-8000-000000000011",
  glicerina: "00000000-0000-4000-8000-000000000012",
  fragancia: "00000000-0000-4000-8000-000000000013",
} as const;

const MASTER_FORMULA_ID = "00000000-0000-4000-8000-000000000021";

const FORMULA_INGREDIENT_IDS = {
  agua: "00000000-0000-4000-8000-000000000031",
  glicerina: "00000000-0000-4000-8000-000000000032",
  fragancia: "00000000-0000-4000-8000-000000000033",
} as const;

async function main(): Promise<void> {
  await prisma.$transaction(async (tx) => {

    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${ORG_ID}, true)`;
    const org = await tx.organization.upsert({
      where: { id: ORG_ID },
      update: {
        name: "CosmoLab Demo S.A.S.",
        nit: "900123456-7",
        invimaRegistration: "INVIMA-DEMO-2026",
      },
      create: {
        id: ORG_ID,
        name: "CosmoLab Demo S.A.S.",
        nit: "900123456-7",
        invimaRegistration: "INVIMA-DEMO-2026",
      },
    });

    const usersByRole: { role: Role; fullName: string; email: string }[] = [
      { role: "operario", fullName: "Ana Operaria", email: "operario@cosmolab.demo" },
      { role: "jefe_planta", fullName: "Carlos Jefe de Planta", email: "jefe.planta@cosmolab.demo" },
      { role: "calidad", fullName: "Beatriz Calidad", email: "calidad@cosmolab.demo" },
      { role: "director_tecnico", fullName: "Diego Director Tecnico", email: "director.tecnico@cosmolab.demo" },
      { role: "bodega", fullName: "Elena Bodega", email: "bodega@cosmolab.demo" },
      { role: "admin", fullName: "Fabian Admin", email: "admin@cosmolab.demo" },
    ];

    for (const u of usersByRole) {
      const id = USER_IDS[u.role];
      await tx.user.upsert({
        where: { id },
        update: {
          tenantId: org.id,
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          mfaEnabled: true,
          active: true,
        },
        create: {
          id,
          tenantId: org.id,
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          mfaEnabled: true,
          active: true,
        },
      });
    }

    const rawMaterials = [
      {
        id: RAW_MATERIAL_IDS.agua,
        code: "MP-001",
        name: "Agua Desionizada",
        unit: "kg",
        category: "solvente",
        lotId: RAW_MATERIAL_LOT_IDS.agua,
        supplierLotCode: "PROV-AGUA-2026-01",
      },
      {
        id: RAW_MATERIAL_IDS.glicerina,
        code: "MP-002",
        name: "Glicerina Vegetal",
        unit: "kg",
        category: "humectante",
        lotId: RAW_MATERIAL_LOT_IDS.glicerina,
        supplierLotCode: "PROV-GLIC-2026-01",
      },
      {
        id: RAW_MATERIAL_IDS.fragancia,
        code: "MP-003",
        name: "Fragancia Floral",
        unit: "kg",
        category: "fragancia",
        lotId: RAW_MATERIAL_LOT_IDS.fragancia,
        supplierLotCode: "PROV-FRAG-2026-01",
      },
    ] as const;

    const expiryDate = new Date("2027-12-31");

    for (const rm of rawMaterials) {
      const rawMaterial = await tx.rawMaterial.upsert({
        where: { tenantId_code: { tenantId: org.id, code: rm.code } },
        update: {
          name: rm.name,
          unit: rm.unit,
          category: rm.category,
        },
        create: {
          id: rm.id,
          tenantId: org.id,
          code: rm.code,
          name: rm.name,
          unit: rm.unit,
          category: rm.category,
        },
      });

      await tx.rawMaterialLot.upsert({
        where: { id: rm.lotId },
        update: {
          rawMaterialId: rawMaterial.id,
          supplierLotCode: rm.supplierLotCode,
          expiryDate,
          quantityReceived: 100,
          quantityAvailable: 100,
          status: "liberado",
        },
        create: {
          id: rm.lotId,
          tenantId: org.id,
          rawMaterialId: rawMaterial.id,
          supplierLotCode: rm.supplierLotCode,
          expiryDate,
          quantityReceived: 100,
          quantityAvailable: 100,
          status: "liberado",
        },
      });
    }

    const formula = await tx.masterFormula.upsert({
      where: { tenantId_code_version: { tenantId: org.id, code: "F-001", version: 1 } },
      update: {
        name: "Crema Hidratante Base",
        status: "active",
        productType: "crema",
        approvedBy: USER_IDS.calidad,
        approvedAt: new Date(),
      },
      create: {
        id: MASTER_FORMULA_ID,
        tenantId: org.id,
        code: "F-001",
        name: "Crema Hidratante Base",
        version: 1,
        status: "active",
        productType: "crema",
        approvedBy: USER_IDS.calidad,
        approvedAt: new Date(),
      },
    });

    const ingredients = [
      { id: FORMULA_INGREDIENT_IDS.agua, rawMaterialId: RAW_MATERIAL_IDS.agua, percentage: 60, orderIndex: 0 },
      {
        id: FORMULA_INGREDIENT_IDS.glicerina,
        rawMaterialId: RAW_MATERIAL_IDS.glicerina,
        percentage: 30,
        orderIndex: 1,
      },
      {
        id: FORMULA_INGREDIENT_IDS.fragancia,
        rawMaterialId: RAW_MATERIAL_IDS.fragancia,
        percentage: 10,
        orderIndex: 2,
      },
    ] as const;

    for (const ingredient of ingredients) {
      await tx.formulaIngredient.upsert({
        where: { id: ingredient.id },
        update: {
          formulaId: formula.id,
          rawMaterialId: ingredient.rawMaterialId,
          percentage: ingredient.percentage,
          orderIndex: ingredient.orderIndex,
        },
        create: {
          id: ingredient.id,
          formulaId: formula.id,
          rawMaterialId: ingredient.rawMaterialId,
          percentage: ingredient.percentage,
          orderIndex: ingredient.orderIndex,
        },
      });
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
