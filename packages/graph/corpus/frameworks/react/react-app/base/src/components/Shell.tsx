import { Button as UiButton } from "@acme/ui";
import { Legacy } from "./Legacy";
import { UserCard } from "./UserCard";

export function Shell() {
  return (
    <main>
      <Legacy title="People" />
      <UiButton />
      <UserCard id="1" />
    </main>
  );
}
