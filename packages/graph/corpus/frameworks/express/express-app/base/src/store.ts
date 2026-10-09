export type User = { id: string; name: string };

const users = new Map<string, User>();

export function allUsers(): User[] {
  return [...users.values()];
}

export function findUser(id: string): User | undefined {
  return users.get(id);
}

export function saveUser(name: string): User {
  const user = { id: String(users.size + 1), name };
  users.set(user.id, user);
  return user;
}

export function deleteUser(id: string): void {
  users.delete(id);
}
