export const api = {
  run(id: string): string {
    return "ran " + id;
  },
  stop: () => 1,
};

export function cycle(): string {
  return api.run("2");
}
