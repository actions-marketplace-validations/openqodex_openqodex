import { formatMoney } from "./money";

export type Line = { name: string; cents: number };

export function invoiceLines(lines: Line[], currency = "USD"): string[] {
  return lines.map((line) => `${line.name}: ${formatMoney(line.cents, currency)}`);
}
