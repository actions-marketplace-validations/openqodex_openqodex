import { Repo } from "./repo";

export class MemRepo implements Repo {
  find(id: string): string {
    return "mem " + id;
  }
}
