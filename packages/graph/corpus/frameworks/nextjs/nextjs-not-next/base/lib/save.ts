import { format } from "./format";

// Not directives: a directive is a string at the very start of a file or a body.
// oxlint-disable-next-line no-unused-expressions
"use server";

export async function save(value: string): Promise<string> {
  const clean = format(value);
  // oxlint-disable-next-line no-unused-expressions
  "use server";
  return clean;
}
