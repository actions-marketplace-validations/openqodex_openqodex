import { formatPrice } from "./money";

export type Line = { name: string; cents: number };

export function invoiceLines(lines: Line[]): string[] {
  return lines.map((line) => `${line.name}: ${formatPrice(line.cents)}`);
}
