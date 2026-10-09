import { Counter } from "../../components/Counter";
import { saveProfile } from "../actions";

export default function Dashboard() {
  return (
    <form action={saveProfile}>
      <input name="name" />
      <Counter />
      <button type="submit">Save</button>
    </form>
  );
}
