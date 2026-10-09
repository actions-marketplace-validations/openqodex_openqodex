"use client";

import { useEffect, useState } from "react";

export function UserList() {
  const [users, setUsers] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then(setUsers);
  }, []);
  return (
    <ul>
      {users.map((u) => (
        <li key={u}>{u}</li>
      ))}
    </ul>
  );
}
