import { notBuilt } from "./not-built.js";

export async function run(_args: string[]): Promise<number> {
  return notBuilt("trust");
}
