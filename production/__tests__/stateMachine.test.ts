import { describe, it, expect } from "vitest";
import { canTransition, nextStage } from "../stateMachine";

describe("canTransition", () => {
  it("allows the strict forward sequence", () => {
    expect(canTransition("planificado", "pesado")).toBe(true);
    expect(canTransition("pesado", "mezclado")).toBe(true);
    expect(canTransition("mezclado", "envasado")).toBe(true);
    expect(canTransition("envasado", "calidad")).toBe(true);
    expect(canTransition("calidad", "liberado")).toBe(true);
    expect(canTransition("calidad", "rechazado")).toBe(true);
  });
  it("rejects skipping a stage", () => {
    expect(canTransition("planificado", "mezclado")).toBe(false);
  });
  it("rejects moving backward", () => {
    expect(canTransition("mezclado", "pesado")).toBe(false);
  });
  it("rejects any transition out of a terminal state", () => {
    expect(canTransition("liberado", "calidad")).toBe(false);
    expect(canTransition("rechazado", "calidad")).toBe(false);
  });
});

describe("nextStage", () => {
  it("returns the single valid forward stage", () => {
    expect(nextStage("planificado")).toBe("pesado");
  });
  it("returns null for a terminal stage", () => {
    expect(nextStage("liberado")).toBeNull();
  });
});
