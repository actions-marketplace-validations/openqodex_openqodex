import { store } from "./store.js";

export function onSave(id) {
  store.set(id, Date.now());
  return `saved ${id}`;
}

export function onDelete(id) {
  store.delete(id);
  return `deleted ${id}`;
}
