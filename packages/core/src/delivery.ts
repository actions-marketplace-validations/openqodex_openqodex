// One row policy for the initial diff and correction ranges. Callers pass
// redacted text and count coverage only after the whole returned row fits.
// `mark`: the diff's +, - or space, kept in front of each part in the brief.
export const DELIVERY_ROW_CHARS = 2000;
export const DELIVERY_ROW_BYTES = 200 * 1024;

export function deliveryRow(path: string, line: number, text: string, prefix: string, old: boolean = false, mark: string = ""): string[] | null {
  if (Buffer.byteLength(text, "utf8") > DELIVERY_ROW_BYTES) return null;
  if (text.length <= DELIVERY_ROW_CHARS) return [`${prefix}${text}`];
  // Keep Unicode code points intact at chunk boundaries.
  const chunks: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + DELIVERY_ROW_CHARS, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(at, end));
    at = end;
  }
  const rows = chunks.map((chunk, i) => `${mark}${path}: ${old ? "old line" : "line"} ${line}, part ${i + 1} of ${chunks.length}\t${chunk}`);
  return Buffer.byteLength(rows.join("\n") + "\n", "utf8") <= DELIVERY_ROW_BYTES ? rows : null;
}
