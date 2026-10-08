import { fetchItem } from "./index";

export function show(id: string): string {
  return fetchItem(id);
}
