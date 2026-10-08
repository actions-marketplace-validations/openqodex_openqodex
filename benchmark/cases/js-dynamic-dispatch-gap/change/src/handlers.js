import { writeFile } from "node:fs/promises";
import { store } from "./store.js";

const SNAPSHOT = new URL("../data/notes.json", import.meta.url);

export async function onSave(id) {
  store.set(id, Date.now());
  await writeFile(SNAPSHOT, JSON.stringify([...store]));
  return `saved ${id}`;
}

export function onDelete(id) {
  store.delete(id);
  return `deleted ${id}`;
}
