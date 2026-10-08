import { parseToken } from "./b6";

export function login(raw: string): string {
  return parseToken(raw);
}
