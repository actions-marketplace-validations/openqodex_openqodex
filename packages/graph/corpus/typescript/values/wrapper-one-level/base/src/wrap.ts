export function wrap(fn: (input: string) => string): (input: string) => string {
  return (...a) => fn(...a);
}
