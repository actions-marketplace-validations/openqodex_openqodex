import { BaseRepo } from "./base-repo";

export function run(repo: BaseRepo): string {
  return repo.find("1");
}
