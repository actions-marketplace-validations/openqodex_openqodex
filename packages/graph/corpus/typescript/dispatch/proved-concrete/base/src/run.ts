import { SqlRepo } from "./sql-repo";

export function run(): string {
  const r = new SqlRepo();
  return r.find("1");
}
