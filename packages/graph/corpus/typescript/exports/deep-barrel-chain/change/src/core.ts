function parseToken(raw: string): string {
  return raw.trim();
}

export function version(): number {
  return 1;
}

export const internal = { parseToken };
