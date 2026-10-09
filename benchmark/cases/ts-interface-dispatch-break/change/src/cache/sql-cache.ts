import type { Cache } from "./cache.js";

type Row = { value: string; storedAt: number };

const MAX_AGE_MS = 15 * 60 * 1000;

// The cache the server runs on: rows kept by key, as the database table has them.
export class SqlCache implements Cache {
  private rows = new Map<string, Row>();

  get(key: string): string {
    const row = this.rows.get(key);
    if (!row || Date.now() - row.storedAt > MAX_AGE_MS) {
      throw new Error(`no fresh entry for ${key}`);
    }
    return row.value;
  }

  set(key: string, value: string): void {
    this.rows.set(key, { value, storedAt: Date.now() });
  }
}
