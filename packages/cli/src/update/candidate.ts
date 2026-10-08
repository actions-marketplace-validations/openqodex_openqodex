// Which published releases the self-update may install. The input is npm's
// full metadata document for the package; anything in it that does not
// parse makes that one version ineligible, never the whole list.
import { contractOf, sameContract, type Contract } from "../contract.js";

export type UpdateCandidate = {
  version: string;
  tarball: string;
  integrity: string;
  attestationsUrl: string;
  publishedAt: string;
  // The contract the release declares (src/contract.ts); null for a release
  // from before contracts. The worker installs in the background only a
  // release whose contract equals the running one's.
  contract: Contract | null;
};

// A release younger than this is not installed: a window to notice and
// deprecate a bad publish before it reaches laptops.
export const MIN_AGE_MS = 24 * 60 * 60 * 1000;

const REGISTRY_HOST = "registry.npmjs.org";
const PACKAGE = "openqodex";

type Version = [number, number, number];

// Plain x.y.z only: a prerelease, build metadata or a leading zero does not parse.
function parseVersion(text: unknown): Version | null {
  if (typeof text !== "string") return null;
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])] as Version;
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// The engines ranges this package uses: ">=N", ">=N.M" or ">=N.M.P". Any
// other range is not understood, so the version is not offered.
function nodeSatisfies(range: string, node: Version): boolean {
  const m = /^\s*>=\s*(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?\s*$/.exec(range);
  if (!m) return false;
  const floor: Version = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  return compare(node, floor) >= 0;
}

function onRegistry(url: unknown, pathPrefix: string): url is string {
  if (typeof url !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === REGISTRY_HOST &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.pathname.startsWith(pathPrefix)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// The versions eligible to install, highest first. The caller tries them in
// order and skips one that fails verification, so a bad high version does
// not block a good lower one.
export function selectCandidates(
  metadata: unknown,
  opts: { current: string; now: number | Date; nodeVersion: string },
): UpdateCandidate[] {
  const current = parseVersion(opts.current);
  const node = parseVersion(opts.nodeVersion.replace(/^v/, ""));
  const now = opts.now instanceof Date ? opts.now.getTime() : opts.now;
  const doc = record(metadata);
  const versions = record(doc?.versions);
  const times = record(doc?.time);
  if (current === null || node === null || versions === null || times === null || !Number.isFinite(now)) return [];

  const found: Array<{ parsed: Version; candidate: UpdateCandidate }> = [];
  for (const [version, raw] of Object.entries(versions)) {
    const parsed = parseVersion(version);
    if (parsed === null || compare(parsed, current) <= 0) continue;
    // Same major only. While the major is 0 that is any higher 0.x.
    if (parsed[0] !== current[0]) continue;

    const published = times[version];
    const at = typeof published === "string" ? Date.parse(published) : Number.NaN;
    if (!Number.isFinite(at) || now - at < MIN_AGE_MS) continue;

    const meta = record(raw);
    if (meta === null) continue;
    if (meta.deprecated !== undefined && meta.deprecated !== false && meta.deprecated !== "") continue;

    const engines = meta.engines === undefined ? {} : record(meta.engines);
    if (engines === null) continue;
    if (engines.node !== undefined && (typeof engines.node !== "string" || !nodeSatisfies(engines.node, node))) continue;

    const dist = record(meta.dist);
    const attestations = record(dist?.attestations);
    if (dist === null || attestations === null) continue;
    if (!onRegistry(dist.tarball, `/${PACKAGE}/-/`)) continue;
    if (typeof dist.integrity !== "string" || !dist.integrity.startsWith("sha512-")) continue;
    if (!onRegistry(attestations.url, "/")) continue;

    found.push({
      parsed,
      candidate: {
        version,
        tarball: dist.tarball,
        integrity: dist.integrity,
        attestationsUrl: attestations.url,
        publishedAt: published as string,
        contract: contractOf(meta),
      },
    });
  }
  return found.sort((a, b) => compare(b.parsed, a.parsed)).map((f) => f.candidate);
}

// The releases the background worker may install, highest first: those
// with the contract it keeps. And the highest newer release with another
// contract, which waits for a foreground `openqodex update`; null when none
// is newer than every release it may install.
export function byContract(candidates: UpdateCandidate[], keep: Contract | null): { install: UpdateCandidate[]; held: UpdateCandidate | null } {
  const install = candidates.filter((c) => sameContract(c.contract, keep));
  const best = install[0] === undefined ? null : parseVersion(install[0].version);
  const held = candidates.find((c) => !sameContract(c.contract, keep) && (best === null || compare(parseVersion(c.version)!, best) > 0)) ?? null;
  return { install, held };
}

// What a release with contract `next` changes for an install that keeps `keep`.
export function contractChange(next: Contract | null, keep: Contract | null): string {
  const agent = next?.agent !== keep?.agent;
  const config = next?.config !== keep?.config;
  if (agent && config) return "how agents run a review and the config format";
  return config ? "the config format" : "how agents run a review";
}
