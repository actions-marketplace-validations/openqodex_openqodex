import { Repo } from "./repo";

export class SqlRepo implements Repo {
  find(id: string): string {
    return "sql:" + id;
  }
}
