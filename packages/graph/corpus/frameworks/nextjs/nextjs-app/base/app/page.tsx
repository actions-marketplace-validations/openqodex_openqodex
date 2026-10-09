import Link from "next/link";
import { UserList } from "../components/UserList";

export default function Home() {
  return (
    <main>
      <Link href="/about">About</Link>
      <UserList />
    </main>
  );
}
