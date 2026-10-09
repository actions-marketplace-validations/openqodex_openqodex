import { onRemove, onSave } from "./handlers";

const handlers = { save: onSave, remove: onRemove };

export function route(k: "save" | "remove", id: string): string {
  return handlers[k](id);
}
