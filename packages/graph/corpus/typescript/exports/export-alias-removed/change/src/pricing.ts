function computeTotal(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0);
}

export { computeTotal };
