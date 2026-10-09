export type User = { id: string; name: string };

export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(`/people/${encodeURIComponent(id)}`);
  return (await res.json()) as User;
}
