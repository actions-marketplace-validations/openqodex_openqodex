import type { Repo } from "./repo";

export class Service {
  constructor(private repo: Repo) {}

  load(id: string): string {
    return this.repo.find(id);
  }
}
