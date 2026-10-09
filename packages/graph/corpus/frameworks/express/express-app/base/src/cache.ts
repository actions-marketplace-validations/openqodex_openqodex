// An object with a get method, unrelated to express: its calls are no routes.
const app = {
  get(key: string, fallback: () => string): string {
    return fallback() + key;
  },
};

export function cached(): string {
  return app.get("/health", () => "miss");
}
