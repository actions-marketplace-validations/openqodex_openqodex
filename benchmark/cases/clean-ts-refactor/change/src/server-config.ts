export type Env = Record<string, string | undefined>;

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = "127.0.0.1";

// The value of `name` in `env`, or null when it is unset or empty.
function setting(env: Env, name: string): string | null {
  const raw = env[name];
  return raw === undefined || raw === "" ? null : raw;
}

export function port(env: Env): number {
  const raw = setting(env, "PORT");
  if (raw === null) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, not ${raw}`);
  }
  return n;
}

export function host(env: Env): string {
  return setting(env, "HOST") ?? DEFAULT_HOST;
}
