const users = new Map([["1", { id: "1", name: "Ada" }]]);

export function allUsers() {
  return [...users.values()];
}

export function findUser(id) {
  return users.get(id);
}

export function saveUser(name) {
  const user = { id: String(users.size + 1), name };
  users.set(user.id, user);
  return user;
}
