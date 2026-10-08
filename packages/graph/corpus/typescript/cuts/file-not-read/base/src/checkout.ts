import { toCents } from "./units";

export function charge(amount: number): number {
  return toCents(amount);
}
