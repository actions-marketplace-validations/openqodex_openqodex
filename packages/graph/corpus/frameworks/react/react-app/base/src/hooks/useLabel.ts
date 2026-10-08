// Named like a hook, but it calls no hook: a plain function.
export function useLabel(name: string): string {
  return name.toUpperCase();
}
