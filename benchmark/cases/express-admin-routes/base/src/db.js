// A stand-in for the user table: an in-memory map, with the same async
// interface the real database client has.
const users = new Map();

export async function listUsers() {
  return [...users.values()];
}

export async function removeUser(id) {
  if (!users.delete(id)) throw new Error(`no user ${id}`);
}
