import { useUser } from "../hooks/useUser";
import { useLabel } from "../hooks/useLabel";
import { Button } from "./Button";

export function UserCard({ id }: { id: string }) {
  const user = useUser(id);
  const title = useLabel(user?.name ?? "");
  function save() {
    console.log("save", user?.id);
  }
  if (!user) return null;
  return (
    <div>
      <h2>{title}</h2>
      <Button label="Save" onClick={save} />
    </div>
  );
}
