/*
Copyright 2026 The InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * At most one join sound and one leave sound are played in a window of this
 * length, however many people came or went in it.
 */
export const JOIN_LEAVE_SOUND_WINDOW_MS = 1500;

/**
 * How long after the user joined the members' list is still filling up: those
 * already in the call appear one after the other, which is nobody joining.
 */
export const OWN_JOIN_SETTLE_MS = 2500;

/** The sound of somebody coming into the call, or of somebody going. */
export type RosterCue = "join" | "left";

/** When a cue of each kind was last played, in ms. */
export interface RosterCueHistory {
  join?: number;
  left?: number;
}

export interface RosterCueContext {
  /** The time, in ms. */
  now: number;
  /** When the user joined the call, on the same clock. */
  joinedAt: number;
  /**
   * Whether the host plays the user's own join and leave sounds (InterCom
   * does: they are heard while deafened too, and the leave sound after the
   * call's view is gone). The call then stays quiet while its list fills.
   */
  hostPlaysOwnCues: boolean;
  /** Whether the call's sounds are off: muted by the setting, or deafened. */
  silenced: boolean;
}

/**
 * Whether the call plays a sound for a change in who is in it, and what is to
 * be remembered for the next change.
 *
 *  - nothing while the call's sounds are off, which they are while deafened;
 *  - nothing while the list of members fills up after the user's own join,
 *    where the host plays the sound of that join itself;
 *  - at most one sound of each kind per {@link JOIN_LEAVE_SOUND_WINDOW_MS}.
 *
 * Calls with more members than MAX_PARTICIPANT_COUNT_FOR_SOUND make no such
 * sounds at all, which the view model sees to: in a full room somebody comes
 * or goes all the time.
 */
export function rosterCueDecision(
  cue: RosterCue,
  history: RosterCueHistory,
  { now, joinedAt, hostPlaysOwnCues, silenced }: RosterCueContext,
): { play: boolean; history: RosterCueHistory } {
  if (silenced) return { play: false, history };
  if (hostPlaysOwnCues && now - joinedAt < OWN_JOIN_SETTLE_MS)
    return { play: false, history };
  const last = history[cue];
  if (last !== undefined && now - last < JOIN_LEAVE_SOUND_WINDOW_MS)
    return { play: false, history };
  return { play: true, history: { ...history, [cue]: now } };
}

/** What the host says about the call's sounds. */
export interface HostSounds {
  /** Whether the host plays the user's own join and leave sounds. */
  hostPlaysOwnCues: boolean;
  /** The user's own sound files, which replace the built-in ones. */
  sounds: Partial<Record<RosterCue, ArrayBuffer>>;
}

/** The largest sound taken from the host: 2 MB of audio, as base64. */
const MAX_SOUND_BASE64_LENGTH = Math.ceil((2 * 1024 * 1024) / 3) * 4;

function decodeSound(entry: unknown): ArrayBuffer | undefined {
  const data = (entry as { data?: unknown } | null | undefined)?.data;
  if (typeof data !== "string" || !data) return undefined;
  if (data.length > MAX_SOUND_BASE64_LENGTH) return undefined;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch {
    return undefined;
  }
}

/**
 * Reads the host's answer to the sounds request:
 * `{ host_cues: boolean, sounds: { join?: { data }, leave?: { data } } }`,
 * `data` being the file in base64. Whatever is missing, too large or not
 * base64 is left out: the built-in sound is played then.
 */
export function parseHostSounds(reply: unknown): HostSounds {
  const raw = (typeof reply === "object" && reply !== null ? reply : {}) as {
    host_cues?: unknown;
    sounds?: unknown;
  };
  const files = (
    typeof raw.sounds === "object" && raw.sounds !== null ? raw.sounds : {}
  ) as { join?: unknown; leave?: unknown };
  const sounds: HostSounds["sounds"] = {};
  const join = decodeSound(files.join);
  if (join) sounds.join = join;
  const left = decodeSound(files.leave);
  if (left) sounds.left = left;
  return { hostPlaysOwnCues: raw.host_cues === true, sounds };
}
