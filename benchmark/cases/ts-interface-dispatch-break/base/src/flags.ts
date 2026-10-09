import type { Cache } from "./cache/cache.js";

const defaults = new Map<string, boolean>([
  ["new-dashboard", false],
  ["audit-log", true],
]);

export function isEnabled(cache: Cache, flag: string): boolean {
  const stored = cache.get(`flag:${flag}`);
  if (stored === "") return defaults.get(flag) ?? false;
  return stored === "on";
}
