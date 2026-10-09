import type { Repo } from "./repo";

export function load(repo: Repo): string {
  return repo.find("1");
}
