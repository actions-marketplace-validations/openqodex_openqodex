const users: string[] = ["ada"];

export function listUsers(): string[] {
  return users;
}

export function addUser(name: string): string {
  users.push(name);
  return name;
}
