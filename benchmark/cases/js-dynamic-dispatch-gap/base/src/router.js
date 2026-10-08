import { onDelete, onSave } from "./handlers.js";

const table = { save: onSave, delete: onDelete };

export function dispatch(action, id) {
  if (!Object.hasOwn(table, action)) return `unknown action ${action}`;
  return table[action](id);
}
