import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

/**
 * The local files one provider reading was derived from. Fresh reuse serves a
 * cached reading only while every one of them is unchanged, so a login that
 * rewrites a credential store or a configuration that now names another
 * deployment is read again instead of answering with the previous account.
 *
 * A source whose changes cannot be checked without reading a credential marks
 * the trace unverifiable. Its quota may still be cached for stale fallback,
 * but file metadata and environment selection cannot vouch for fresh reuse.
 */
const trace = new AsyncLocalStorage<{
  states: Map<string, string>;
  reusable: boolean;
}>();

export type TracedInputs = {
  /** Every traced path, sorted. */
  paths: string[];
  /** {@link inputsDigest} of those paths as they were when last read. */
  digest: string;
  /** A consulted source cannot be checked safely for changes. */
  reusable?: false;
};

/**
 * Record that the current reading is about to consult `path`, present or not.
 * Its state is captured now, before the read, so a store rewritten while the
 * reading is still in flight can never be vouched for by that reading.
 */
export function traceInput(path: string): void {
  trace.getStore()?.states.set(path, inputState(path));
}

/**
 * A consulted input has no safely observable change signal. The flag is sticky
 * across sibling sources and lanes: a later file read cannot vouch for it.
 */
export function traceUnverifiableInput(): void {
  const current = trace.getStore();
  if (current) current.reusable = false;
}

/** Run `read` and return what it produced plus every input it traced. */
export async function withInputTrace<T>(
  read: () => Promise<T>,
): Promise<{ value: T; inputs: TracedInputs }> {
  const states = new Map<string, string>();
  const current = { states, reusable: true };
  const value = await trace.run(current, read);
  const paths = [...states.keys()].sort();
  return {
    value,
    inputs: {
      paths,
      digest: digestStates(paths.map((path) => states.get(path) as string)),
      ...(!current.reusable ? { reusable: false as const } : {}),
    },
  };
}

/**
 * A one-way digest of the current state of `paths`: identity, size, and
 * modification times, or absence. Contents are never read, so a credential
 * file's bytes never enter it.
 */
export function inputsDigest(paths: readonly string[]): string {
  return digestStates(paths.map(inputState));
}

function digestStates(states: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(["inputs-v1", states]))
    .digest("hex");
}

function inputState(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return [
      path,
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(":");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unreadable";
    return `${path}:${code}`;
  }
}
