/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * How long the user stays in a private call after everybody else left it, in
 * seconds, or "never" to stay until they leave themselves.
 */
export type AloneTimeout = number | "never";

/** The longest a host may ask for: a day. Anything longer is a mistake. */
const MAX_ALONE_TIMEOUT_S = 24 * 60 * 60;

/**
 * Reads the `intercomAloneTimeout` URL parameter, or what the host sends when
 * the setting changes during a call: a number of seconds, or "never".
 * Anything else is no timeout at all, which leaves the call as its host
 * (or the intent) would have it without InterCom.
 */
export function parseAloneTimeout(value: unknown): AloneTimeout | undefined {
  if (value === "never") return "never";
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(Math.round(seconds), MAX_ALONE_TIMEOUT_S);
}

/**
 * Where the user stands in a call as far as being alone in it goes:
 *
 *  - `not-applicable`: nothing counts down here. A voice channel, another
 *    host, a timeout of "never", or the user has left;
 *  - `waiting-for-others`: nobody else has been in the call yet (it rings the
 *    other side, say). That is not being alone;
 *  - `with-others`: somebody else is in the call;
 *  - `alone`: everybody else left, and the user is taken out of the call at
 *    `deadline` (in ms, on the timer's clock). `seq` goes up with every
 *    countdown that starts or starts over;
 *  - `expired`: the deadline passed, and the call is to be left.
 */
export type AloneState =
  | { kind: "not-applicable" }
  | { kind: "waiting-for-others" }
  | { kind: "with-others" }
  | { kind: "alone"; deadline: number; seq: number }
  | { kind: "expired" };

export interface AloneTimerOptions {
  /** The time, in ms. */
  now: () => number;
  /** undefined: nothing counts down in this call (see {@link AloneState}). */
  timeout: AloneTimeout | undefined;
}

/**
 * Decides when a private call the user is left alone in ends (InterCom). It
 * is told how many others are in the call and what the user asks for, and
 * has no timers of its own: {@link state} looks at the clock it was given,
 * and {@link nextDueAt} says when to look again.
 *
 * The countdown starts when the last of the others leaves, and only then:
 * a call nobody else has joined yet is waited in for as long as it takes.
 * Somebody coming back ends the countdown, staying starts it over in full,
 * and so does another timeout chosen while it runs.
 */
export class AloneTimer {
  private timeout: AloneTimeout | undefined;
  private others = 0;
  /** Whether somebody else has been in the call at all */
  private hadOthers = false;
  private deadline: number | undefined;
  private seq = 0;
  private ended: "expired" | "left" | undefined;

  public constructor(private readonly options: AloneTimerOptions) {
    this.timeout = options.timeout;
  }

  /** How things stand now. */
  public get state(): AloneState {
    if (this.ended === "expired") return { kind: "expired" };
    if (
      this.ended === "left" ||
      this.timeout === undefined ||
      this.timeout === "never"
    )
      return { kind: "not-applicable" };
    if (this.others > 0) return { kind: "with-others" };
    if (!this.hadOthers || this.deadline === undefined)
      return { kind: "waiting-for-others" };
    if (this.options.now() >= this.deadline) {
      this.ended = "expired";
      this.deadline = undefined;
      return { kind: "expired" };
    }
    return { kind: "alone", deadline: this.deadline, seq: this.seq };
  }

  /** When {@link state} changes by itself, in ms, if it does. */
  public nextDueAt(): number | undefined {
    const state = this.state;
    return state.kind === "alone" ? state.deadline : undefined;
  }

  /** How many others (by user, not counting the user's own devices) are in the call. */
  public setOthers(count: number): AloneState {
    // Looked at first, so that a deadline that has passed stays passed
    if (this.over()) return this.state;
    const wasWithOthers = this.others > 0;
    this.others = Math.max(0, count);
    if (this.others > 0) {
      this.hadOthers = true;
      this.deadline = undefined;
    } else if (wasWithOthers) this.restart();
    return this.state;
  }

  /** The user wants to stay: the countdown starts over, in full. */
  public stay(): AloneState {
    if (this.state.kind === "alone") this.restart();
    return this.state;
  }

  /** The user left the call: nothing counts down any more. */
  public leave(): AloneState {
    if (this.ended === undefined) this.ended = "left";
    this.deadline = undefined;
    return this.state;
  }

  /**
   * Another timeout was chosen. A countdown that runs starts over with it,
   * rather than ending the call at once because the new one is shorter.
   */
  public setTimeout(timeout: AloneTimeout | undefined): AloneState {
    if (this.over() || timeout === this.timeout) return this.state;
    this.timeout = timeout;
    if (this.others === 0 && this.hadOthers) this.restart();
    return this.state;
  }

  private over(): boolean {
    return this.state.kind === "expired" || this.ended !== undefined;
  }

  private restart(): void {
    if (typeof this.timeout !== "number") {
      // Still alone, which counts again once there is a timeout
      this.deadline = undefined;
      return;
    }
    this.deadline = this.options.now() + this.timeout * 1000;
    this.seq++;
  }
}

/**
 * What the host is told of a countdown: how long is left of it, from which
 * it counts down by itself, and which countdown it is (the same time left
 * with another `seq` is one that started over).
 */
export type HostAloneState = {
  ms_left: number;
  seq: number;
};

/** The countdown for the host, if one runs. */
export function hostAloneState(
  state: AloneState | undefined,
  now: number,
): HostAloneState | undefined {
  if (state?.kind !== "alone") return undefined;
  return { ms_left: Math.max(0, state.deadline - now), seq: state.seq };
}

/** Why the call told the host it is leaving by itself. */
export const ALONE_TIMEOUT_LEFT_REASON = "alone-timeout";

/** The time left until `deadline` as minutes and seconds: "4:59", "0:07". */
export function formatCountdown(msLeft: number): string {
  const seconds = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
