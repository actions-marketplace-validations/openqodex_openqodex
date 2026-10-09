import { Button } from "./Button";
import { Legacy } from "./Legacy";

const views = { button: Button, legacy: Legacy };

export function Picker({ kind }: { kind: "button" | "legacy" }) {
  const View = views[kind];
  return <View title="x" label="x" onClick={() => undefined} />;
}
