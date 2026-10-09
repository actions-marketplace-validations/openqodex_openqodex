import type { Cache } from "./cache.js";

export class MemoryCache implements Cache {
  private values = new Map<string, string>();

  get(key: string): string {
    return this.values.get(key) ?? "";
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}
