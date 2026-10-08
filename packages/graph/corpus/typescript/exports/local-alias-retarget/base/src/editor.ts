import { save } from "./storage";

export function persist(key: string): string {
  return save(key);
}
