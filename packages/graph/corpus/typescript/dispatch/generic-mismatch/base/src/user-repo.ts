import { Repo, User } from "./types";

export class UserRepo implements Repo<User> {
  find(id: string): User {
    return { name: "user " + id };
  }
}
