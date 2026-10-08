import { onDelete, onSave } from "./handlers";

const table: Record<string, (id: string) => string> = { save: onSave, delete: onDelete };

export function dispatch(action: string, id: string): string {
  return table[action](id);
}
