import { formatDate } from "@lib/dates";

export function render(): string {
  return formatDate(new Date(0));
}
