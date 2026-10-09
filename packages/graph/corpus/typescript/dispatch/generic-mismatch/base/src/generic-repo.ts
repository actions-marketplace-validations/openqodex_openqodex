import { Repo } from "./types";

export class GenericRepo<T> implements Repo<T> {
  find(id: string): T {
    throw new Error("no row " + id);
  }
}
