import { BaseRepo } from "./base-repo";

export class MemRepo extends BaseRepo {
  find(id: string): string {
    return "mem " + id;
  }
}
