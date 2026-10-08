import { useEffect, useState } from "react";
import { fetchUser } from "../api";
import type { User } from "../api";

export function useUser(id: string): User | null {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    fetchUser(id).then(setUser);
  }, [id]);
  return user;
}
