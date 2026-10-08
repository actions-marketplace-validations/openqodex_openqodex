// Leases: one file per reader that holds a generation open, under
// `leases/`. A lease protects its generation from the collector while its
// process runs (the pid is alive with the start time the lease names) or
// while the lease file is under 24 hours old. No heartbeat: the pid check
// and the age bound cover a reader that crashed (PLAN.md decision row 8).
import { randomBytes } from "node:crypto";
import { LEASE_MAX_AGE_MS, type BuildId } from "./types.js";
import { holderAlive, startTag, validPid } from "./lock.js";

export type LeaseRecord = { id: BuildId; pid: number; start: string; purpose: string; time: number };

export const LEASE_NAME = /^\d{1,7}-[0-9a-f]{1,8}-[0-9a-f]{8}\.json$/;
export const LEASE_MAX_BYTES = 4096;

// leases/<pid>-<start>-<random>.json: one process may hold several leases.
export function leaseFileName(pid: number, start: string): string {
  return `${pid}-${startTag(start)}-${randomBytes(4).toString("hex")}.json`;
}

export function parseLease(data: Buffer | null, idPattern: RegExp): LeaseRecord | null {
  if (data === null) return null;
  try {
    const v = JSON.parse(data.toString("utf8")) as Partial<LeaseRecord>;
    if (
      typeof v.id === "string" &&
      idPattern.test(v.id) &&
      validPid(v.pid) &&
      typeof v.start === "string" &&
      v.start.length <= 200 &&
      typeof v.purpose === "string" &&
      v.purpose.length <= 64 &&
      typeof v.time === "number" &&
      Number.isFinite(v.time)
    ) {
      return { id: v.id, pid: v.pid, start: v.start, purpose: v.purpose, time: v.time };
    }
  } catch {
    // not a lease: it protects nothing
  }
  return null;
}

// True while the lease keeps its generation: the file is under 24 hours old
// by the time it records, or its process still runs. A lease that claims a
// time more than 24 hours ahead is not young: a clock that far off says
// nothing about the reader.
export async function leaseProtects(lease: LeaseRecord, now: number): Promise<boolean> {
  const age = now - lease.time;
  if (age < LEASE_MAX_AGE_MS && age > -LEASE_MAX_AGE_MS) return true;
  return holderAlive(lease.pid, lease.start);
}
