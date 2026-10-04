import { chromium } from "playwright";

export interface BatchRecordSignature {
  stage: string;
  signedBy: string;
  meaningStatement: string;
  signedAt: string;
}

export interface BatchRecordQcResult {
  parameter: string;
  measuredValue: number;
  result: string;
}

export interface BatchRecordEvent {
  eventType: string;
  occurredAt: string;
  actorUserId: string;
}

export interface BatchRecordOrder {
  orderNumber: string;
  status: string;
  signatures: BatchRecordSignature[];
  qcResults: BatchRecordQcResult[];
  events: BatchRecordEvent[];
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export function renderBatchRecordHtml(order: BatchRecordOrder): string {
  const e = escapeHtml;
  return `
    <html><head><meta charset="utf-8"></head><body style="font-family: sans-serif;">
      <h1>Batch Record — ${e(order.orderNumber)}</h1>
      <p>Estado: ${e(order.status)}</p>
      <h2>Firmas</h2>
      <ul>${order.signatures.map((s) => `<li>${e(s.stage)}: ${e(s.meaningStatement)} — ${e(s.signedBy)} (${e(s.signedAt)})</li>`).join("")}</ul>
      <h2>Resultados de calidad</h2>
      <ul>${order.qcResults.map((r) => `<li>${e(r.parameter)}: ${e(r.measuredValue)} (${e(r.result)})</li>`).join("")}</ul>
      <h2>Eventos</h2>
      <ul>${order.events.map((ev) => `<li>${e(ev.eventType)} — ${e(ev.occurredAt)} — ${e(ev.actorUserId)}</li>`).join("")}</ul>
    </body></html>
  `;
}

export async function renderPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.setContent(html);
    return await page.pdf({ format: "A4" });
  } finally {
    await browser.close();
  }
}
