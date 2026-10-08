import { baseRate } from "./rate";

export function quote(amount: number): number {
  return amount * baseRate();
}
