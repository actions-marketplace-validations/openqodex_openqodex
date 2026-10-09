export function onA(): string {
  return "a";
}

export function onB(): string {
  return "b";
}

export function pick(k: boolean): () => string {
  if (k) return onA;
  return onB;
}
