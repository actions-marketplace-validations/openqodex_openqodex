// One line per release change that a developer must hear about even when
// their config did not change: what leaves the machine, what blocks a push,
// or who reviews. Nothing else goes here. The first command after an update
// prints every notice after the version it came from, up to its own;
// `doctor` and `update --status` print those of the last update.
//
// A notice names the version it starts in. Notices of earlier releases were
// added when this list was made, so an install that updates across them
// still hears of them.
export type Notice = { version: string; kind: "leaves the machine" | "blocks a push" | "who reviews"; text: string };

export const NOTICES: readonly Notice[] = [
  {
    version: "0.5.0",
    kind: "who reviews",
    text: "openqodex review starts Claude Code as a separate reviewer of the change, on your own login; before, the agent you were in reviewed it.",
  },
  {
    version: "0.6.0",
    kind: "who reviews",
    text: "Codex can be the reviewer: auto picks Codex when you run the review from Codex or when Codex is the only reviewer installed.",
  },
  {
    version: "0.6.0",
    kind: "leaves the machine",
    text: "The reviewer can search the web and open web pages by default; set reviewer_web: off in ~/.openqodex/config.yaml to take its web tools away.",
  },
  {
    version: "0.9.0",
    kind: "blocks a push",
    text: "A name in scanners.disable that this version does not know is ignored with a warning and the review runs, so it can block a push; before, the run stopped with exit 2 and the push went through.",
  },
];

type Version = [number, number, number];

function parse(v: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return Number.NaN;
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

// The notices of every release after `from`, up to and including `to`.
export function noticesBetween(from: string, to: string, list: readonly Notice[] = NOTICES): Notice[] {
  return list.filter((n) => compareVersions(n.version, from) > 0 && compareVersions(n.version, to) <= 0);
}
