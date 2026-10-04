import { describe, it, expect } from "vitest";
import { escapeHtml, renderBatchRecordHtml, type BatchRecordOrder } from "../pdf";

// Zero-`any` precedent (Tasks 6-17): the brief's literal test cast its fixture
// `as any`. `BatchRecordOrder` is `renderBatchRecordHtml`'s real, exported
// parameter type (see pdf.ts) — a plain display-shape interface, not a raw
// Prisma `GetPayload`, because the PDF route converts `Decimal`/`Date` values
// to `number`/`string` at the boundary before calling this pure function
// (same "convert Decimal at the boundary" pattern as `qc.ts`'s
// `specsForFormula`). That keeps this fixture simple and fully typed.
describe("renderBatchRecordHtml", () => {
  it("includes the order number, every signature, and every QC result in the rendered HTML", () => {
    const order: BatchRecordOrder = {
      orderNumber: "OP-2026-005",
      status: "liberado",
      signatures: [
        {
          stage: "pesado",
          signedBy: "u1",
          meaningStatement: "Confirmo el pesaje",
          signedAt: new Date().toISOString(),
        },
      ],
      qcResults: [{ parameter: "pH", measuredValue: 6.5, result: "pass" }],
      events: [],
    };

    const html = renderBatchRecordHtml(order);

    expect(html).toContain("OP-2026-005");
    expect(html).toContain("Confirmo el pesaje");
    expect(html).toContain("pH");
  });

  // Final-review fix (Important 9): user-controlled free text must never be
  // able to inject markup/script into the legal batch-record PDF.
  it("HTML-escapes user-controlled fields so injected markup and script are rendered inert", () => {
    const order: BatchRecordOrder = {
      orderNumber: "OP-2026-006",
      status: "calidad",
      signatures: [
        {
          stage: "pesado",
          signedBy: "u1",
          meaningStatement: '<script>fetch("http://169.254.169.254/")</script><h1>LIBERADO</h1>',
          signedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      qcResults: [{ parameter: '<img src=x onerror="alert(1)">', measuredValue: 6.5, result: "pass" }],
      events: [{ eventType: "weighing", occurredAt: "2026-01-01T00:00:00.000Z", actorUserId: "a'b\"c&d" }],
    };

    const html = renderBatchRecordHtml(order);

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<h1>LIBERADO</h1>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("a&#39;b&quot;c&amp;d");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml(6.5)).toBe("6.5");
  });
});
