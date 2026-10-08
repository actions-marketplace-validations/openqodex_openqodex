import { oldFormat } from "./legacy";

export function line(cents: number): string {
  return oldFormat(cents);
}
