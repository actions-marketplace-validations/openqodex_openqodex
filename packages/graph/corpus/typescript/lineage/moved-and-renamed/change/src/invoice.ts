import { formatMoney } from "./money";

export function line(cents: number): string {
  return formatMoney(cents);
}
