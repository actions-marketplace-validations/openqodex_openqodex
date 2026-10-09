import type { Cache } from "./cache/cache.js";
import { isEnabled } from "./flags.js";
import { readSession } from "./session.js";

type Handler = (cache: Cache, sessionId: string) => string;

const pages = new Map<string, Handler>();

pages.set("/dashboard", (cache, sessionId) => {
  const roles = readSession(cache, sessionId);
  if (roles.length === 0) return "401 sign in first";
  return isEnabled(cache, "new-dashboard") ? "200 new dashboard" : "200 dashboard";
});

pages.set("/audit", (cache, sessionId) => {
  const roles = readSession(cache, sessionId);
  if (!roles.includes("admin")) return "403";
  return isEnabled(cache, "audit-log") ? "200 audit log" : "404";
});

export function route(cache: Cache, path: string, sessionId: string): string {
  const handler = pages.get(path);
  return handler ? handler(cache, sessionId) : "404";
}
