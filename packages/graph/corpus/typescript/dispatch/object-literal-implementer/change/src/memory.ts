import type { Repo } from "./repo";

export const memoryRepo: Repo = {
  find(id: string): string {
    return "mem " + id;
  },
};
