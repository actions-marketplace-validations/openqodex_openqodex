import { Options } from "./options";

export function parse(raw: string): boolean {
  const opts = JSON.parse(raw) as Options;
  return opts.verbose;
}
