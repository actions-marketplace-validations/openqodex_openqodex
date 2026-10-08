export function toCents(amount: number): number {
  return Math.round(amount * 100 + Number.EPSILON);
}
