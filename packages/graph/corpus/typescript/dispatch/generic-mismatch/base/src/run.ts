import { Repo, User } from "./types";

export function firstUser(r: Repo<User>): string {
  return r.find("1").name;
}
