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

/**
 * How long a change in who is in the call has to stand before it is a sound.
 * Somebody whose membership comes and goes within it (a join that did not
 * come about, a reconnect) makes none.
 */
export const ROSTER_SETTLE_MS = 600;

/**
 * How long after the user's own connection came back the list of members is
 * still finding itself again, which is nobody coming or going.
 */
export const RECONNECT_QUIET_MS = 2000;

/** Who is in the call, as far as its sounds go. */
export interface SoundRoster {
  /**
   * The user IDs of the others in the call, each once. The user's own ID is
   * not among them, whichever device of theirs it is in the call with.
   */
  others: string[];
  /** How many memberships the call has, the user's own among them. */
  count: number;
}

/**
 * Reads the {@link SoundRoster} from the members of a call: one entry per
 * user, so that somebody who is in the call twice (a second device, or a
 * membership left behind by a connection that broke) neither joins nor leaves
 * while one of the two stays, and nothing for the user's own devices.
 */
export function soundRoster(
  members: readonly { userId: string }[],
  ownUserId: string,
): SoundRoster {
  const others = new Set<string>();
  for (const member of members)
    if (member.userId !== ownUserId) others.add(member.userId);
  return { others: [...others], count: members.length };
}

export interface RosterCueGateOptions {
  /** The time, in ms. */
  now: () => number;
  /** Calls with more memberships than this make no such sounds. */
  maxCount: number;
}

/** How things stand when the gate is asked what is to be played. */
export interface RosterCueGateState {
  /** Whether the call's sounds are off: muted by the setting, or deafened. */
  silenced: boolean;
}

/**
 * Decides which sounds of coming and going the call plays. It is told who is
 * in the call ({@link update}) and asked what is due ({@link poll}), and has
 * no timers of its own: {@link nextDueAt} says when to ask again.
 *
 * The call is the owner of the sounds of the *others*; the user's own join
 * and leave are the host's where there is one that plays them (InterCom), and
 * the call's otherwise. So that every coming and going is heard once:
 *
 *  - a change is counted by user, and never for the user's own ID: a second
 *    device of somebody, the user's own other devices and memberships left
 *    over from a broken connection make no sound;
 *  - a change must stand for {@link ROSTER_SETTLE_MS}: who comes and is gone
 *    again within it, or goes and is back, makes no sound;
 *  - nothing while the list fills up after the user's own join
 *    ({@link OWN_JOIN_SETTLE_MS}), nothing while the user's own connection is
 *    being re-established or for {@link RECONNECT_QUIET_MS} after;
 *  - nothing from when the user leaves ({@link close}), whatever of the call
 *    falls apart after that: the one sound of that is the user's own leave;
 *  - at most one sound of a kind per {@link JOIN_LEAVE_SOUND_WINDOW_MS}, none
 *    while silenced, none in calls larger than `maxCount`.
 */
export class RosterCueGate {
  private readonly startedAt: number;
  /** The others the user has heard come, or who were there from the start */
  private readonly announced = new Set<string>();
  /** Since when somebody is not what `announced` says, by user ID */
  private readonly pending = new Map<string, number>();
  private current = new Set<string>();
  private count = 0;
  private history: RosterCueHistory = {};
  private quietUntil: number;
  private closed = false;
  /** undefined: the host has not said yet whose the user's own join is */
  private hostPlaysOwnCues: boolean | undefined;
  private ownJoinDone = false;

  public constructor(private readonly options: RosterCueGateOptions) {
    this.startedAt = options.now();
    this.quietUntil = this.startedAt + OWN_JOIN_SETTLE_MS;
  }

  /**
   * The host answered, or there is none: whether it plays the user's own join
   * and leave. Until this is known the user's own join is not played here.
   */
  public hostAnswered(hostPlaysOwnCues: boolean): void {
    this.hostPlaysOwnCues = hostPlaysOwnCues;
  }

  /** Who is in the call now, and whether the user's connection is down. */
  public update(roster: SoundRoster, reconnecting = false): void {
    if (this.closed) return;
    const now = this.options.now();
    this.current = new Set(roster.others);
    this.count = roster.count;
    if (reconnecting)
      this.quietUntil = Math.max(this.quietUntil, now + RECONNECT_QUIET_MS);
    if (now < this.quietUntil) {
      this.absorb();
      return;
    }
    // Back to what the user knows before the change was a sound: none
    for (const userId of this.pending.keys())
      if (this.announced.has(userId) === this.current.has(userId))
        this.pending.delete(userId);
    for (const userId of new Set([...this.announced, ...this.current]))
      if (
        this.announced.has(userId) !== this.current.has(userId) &&
        !this.pending.has(userId)
      )
        this.pending.set(userId, now);
  }

  /** Takes the call as it is for what the user knows, without a sound. */
  private absorb(): void {
    this.announced.clear();
    for (const userId of this.current) this.announced.add(userId);
    this.pending.clear();
  }

  /**
   * The user is leaving, or the call is over: nothing is played from here on.
   */
  public close(): void {
    this.closed = true;
    this.pending.clear();
  }

  /** When {@link poll} has something to decide next, if at all. */
  public nextDueAt(): number | undefined {
    if (this.closed) return undefined;
    let due: number | undefined;
    if (!this.ownJoinDone && this.hostPlaysOwnCues === false)
      due = this.startedAt;
    for (const since of this.pending.values()) {
      const at = since + ROSTER_SETTLE_MS;
      if (due === undefined || at < due) due = at;
    }
    return due;
  }

  /** The sounds to play now. */
  public poll({ silenced }: RosterCueGateState): RosterCue[] {
    if (this.closed) return [];
    const now = this.options.now();
    const due = new Set<RosterCue>();
    if (!this.ownJoinDone && this.hostPlaysOwnCues !== undefined) {
      // Entering the call is the one join sound of the call's own, where no
      // host plays it
      this.ownJoinDone = true;
      if (!this.hostPlaysOwnCues) due.add("join");
    }
    for (const [userId, since] of this.pending) {
      if (now - since < ROSTER_SETTLE_MS) continue;
      this.pending.delete(userId);
      if (this.current.has(userId)) {
        this.announced.add(userId);
        due.add("join");
      } else {
        this.announced.delete(userId);
        due.add("left");
      }
    }
    const cues: RosterCue[] = [];
    for (const cue of due) {
      if (silenced || this.count > this.options.maxCount) continue;
      const last = this.history[cue];
      if (last !== undefined && now - last < JOIN_LEAVE_SOUND_WINDOW_MS)
        continue;
      this.history = { ...this.history, [cue]: now };
      cues.push(cue);
    }
    return cues;
  }
}

/**
 * Whether the call itself plays the sound of the user's own leaving when the
 * call's view goes away: not where the host plays it, which would be the same
 * sound twice.
 */
export function callPlaysOwnLeave(host: HostSounds | undefined): boolean {
  return host?.hostPlaysOwnCues !== true;
}

/** What the host says about the call's sounds. */
export interface HostSounds {
  /** Whether the host plays the user's own join and leave sounds. */
  hostPlaysOwnCues: boolean;
  /** The user's own sound files, which replace the built-in ones. */
  sounds: Partial<Record<RosterCue, ArrayBuffer>>;
  /**
   * The user's own file for the ringback, which is played on a loop while the
   * other side is being rung.
   */
  ringback?: ArrayBuffer;
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
 * `{ host_cues: boolean, sounds: { join?: { data }, leave?: { data }, ringback?: { data } } }`,
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
  ) as { join?: unknown; leave?: unknown; ringback?: unknown };
  const sounds: HostSounds["sounds"] = {};
  const join = decodeSound(files.join);
  if (join) sounds.join = join;
  const left = decodeSound(files.leave);
  if (left) sounds.left = left;
  const ringback = decodeSound(files.ringback);
  return {
    hostPlaysOwnCues: raw.host_cues === true,
    sounds,
    ...(ringback && { ringback }),
  };
}

interface SoundsHost {
  requestSounds(): Promise<HostSounds | undefined>;
}

const asked = new WeakMap<SoundsHost, Promise<HostSounds | undefined>>();
const answered = new WeakMap<SoundsHost, HostSounds | undefined>();

/**
 * Asks the host about the call's sounds, once per host however often it is
 * called: the answer carries sound files. A host that fails to answer is one
 * that has nothing to say.
 */
export async function hostSounds(
  host: SoundsHost,
): Promise<HostSounds | undefined> {
  let answer = asked.get(host);
  if (answer === undefined) {
    answer = host
      .requestSounds()
      .catch(() => undefined)
      .then((sounds) => {
        answered.set(host, sounds);
        return sounds;
      });
    asked.set(host, answer);
  }
  return await answer;
}

/** What the host answered to {@link hostSounds}, if it has by now. */
export function hostSoundsNow(host: SoundsHost): HostSounds | undefined {
  return answered.get(host);
}
