import type { BatchStatus } from "@prisma/client";

const SEQUENCE: BatchStatus[] = ["planificado", "pesado", "mezclado", "envasado", "calidad"];
const TERMINAL: BatchStatus[] = ["liberado", "rechazado"];

export function nextStage(current: BatchStatus): BatchStatus | null {
  const idx = SEQUENCE.indexOf(current);
  if (idx === -1 || idx === SEQUENCE.length - 1) return null;
  return SEQUENCE[idx + 1];
}

export function canTransition(from: BatchStatus, to: BatchStatus): boolean {
  if (TERMINAL.includes(from)) return false;
  if (from === "calidad") return to === "liberado" || to === "rechazado";
  return nextStage(from) === to;
}
