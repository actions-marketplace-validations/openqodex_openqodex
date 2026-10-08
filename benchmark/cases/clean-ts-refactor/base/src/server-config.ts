export type Env = Record<string, string | undefined>;

export function port(env: Env): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") return 3000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, not ${raw}`);
  }
  return n;
}

export function host(env: Env): string {
  const raw = env.HOST;
  if (raw === undefined || raw === "") return "127.0.0.1";
  return raw;
}
