import type { Cache } from "./cache/cache.js";

export function readSession(cache: Cache, id: string): string[] {
  const raw = cache.get(`session:${id}`);
  return raw === "" ? [] : raw.split(",");
}

export function writeSession(cache: Cache, id: string, roles: string[]): void {
  cache.set(`session:${id}`, roles.join(","));
}
