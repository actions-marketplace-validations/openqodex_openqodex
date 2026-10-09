import { SqlRepo } from "./sql-repo";

export class CachedRepo extends SqlRepo {
  find(id: string): string {
    return "cached " + id;
  }
}
