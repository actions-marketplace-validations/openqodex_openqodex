import { BaseRepo } from "./base-repo";

export class SqlRepo extends BaseRepo {
  find(id: string): string {
    return "sql:" + id;
  }
}
