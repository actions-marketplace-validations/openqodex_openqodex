import { pick } from "./pick";

export function run(k: boolean): string {
  return pick(k)();
}

export function later(k: boolean): string {
  const h = pick(k);
  return h();
}
