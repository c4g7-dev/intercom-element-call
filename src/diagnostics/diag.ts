/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * The prefix of every diagnostics line on the console. The application
 * hosting Element Call writes the lines that start with it to a file, so this
 * is a contract with the host.
 */
export const DIAG_PREFIX = "[intercom-diag] ";

export const DIAG_FORMAT_VERSION = 1;

/** What the ring buffer keeps: about ten minutes of a small call. */
const BUFFER_SIZE = 3000;

/** One line of the diagnostics log. */
export interface DiagRecord {
  v: number;
  /** Wall clock, milliseconds since the epoch. */
  t: number;
  seq: number;
  type: string;
  [field: string]: unknown;
}

const KEY_OF_A_SECRET =
  /token|secret|password|passphrase|authorization|^jwt$|^sdp$|e2ee|private|^keys?$|keyMaterial/i;

/**
 * A copy that is safe to write down: nothing under a name that says it holds
 * a secret, no strings long enough to be a message, errors as their name and
 * message. Diagnostics carry numbers and names; this is the backstop.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string")
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "object") return undefined;
  if (value instanceof Error) return describeError(value);
  if (depth >= 6) return undefined;
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => sanitize(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (KEY_OF_A_SECRET.test(key)) continue;
    const safe = sanitize(item, depth + 1);
    if (safe !== undefined) copy[key] = safe;
  }
  return copy;
}

export function describeError(e: unknown): { name: string; message: string } {
  if (e instanceof Error)
    return { name: e.name, message: e.message.slice(0, 300) };
  return { name: "Error", message: String(e).slice(0, 300) };
}

/** Where the lines go; the tests point it elsewhere to keep their output readable. */
export const diagOutput = {
  write: (line: string): void => {
    // The console is the transport here: the host's main process reads it
    // oxlint-disable-next-line no-console
    console.log(line);
  },
};

let seq = 0;
const buffer: DiagRecord[] = [];

/** What the ring buffer holds, oldest first. */
export function diagBuffer(): readonly DiagRecord[] {
  return buffer;
}

/** For tests. */
export function resetDiag(): void {
  seq = 0;
  buffer.length = 0;
}

/**
 * Records one thing that happened: kept in the ring buffer and written to the
 * console as one line of JSON behind `DIAG_PREFIX`. Never throws.
 */
export function diag(type: string, fields: Record<string, unknown> = {}): void {
  try {
    const record: DiagRecord = {
      ...(sanitize(fields) as Record<string, unknown>),
      v: DIAG_FORMAT_VERSION,
      t: Date.now(),
      seq: seq++,
      type,
    };
    buffer.push(record);
    if (buffer.length > BUFFER_SIZE)
      buffer.splice(0, buffer.length - BUFFER_SIZE);
    diagOutput.write(DIAG_PREFIX + JSON.stringify(record));
  } catch {
    // Diagnostics must never break the call they describe
  }
}
