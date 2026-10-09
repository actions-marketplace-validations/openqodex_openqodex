import { label } from "./format";

export function labels(items: string[]): string[] {
  return items.map(label);
}
