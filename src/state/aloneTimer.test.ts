/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  type AloneTimeout,
  AloneTimer,
  formatCountdown,
  hostAloneState,
  parseAloneTimeout,
} from "./aloneTimer";

function setUp(timeout: AloneTimeout | "none" = 300): {
  timer: AloneTimer;
  advance: (ms: number) => void;
  time: () => number;
} {
  let now = 1_000_000;
  return {
    timer: new AloneTimer({
      now: () => now,
      timeout: timeout === "none" ? undefined : timeout,
    }),
    advance: (ms): void => void (now += ms),
    time: () => now,
  };
}

describe("parseAloneTimeout", () => {
  it("reads seconds and never", () => {
    expect(parseAloneTimeout("300")).toBe(300);
    expect(parseAloneTimeout(" 180 ")).toBe(180);
    expect(parseAloneTimeout(600)).toBe(600);
    expect(parseAloneTimeout("never")).toBe("never");
  });

  it("takes anything else for no timeout at all", () => {
    for (const value of [
      null,
      undefined,
      "",
      "0",
      "-5",
      "5m",
      "1.5",
      "Never",
      0,
      -1,
      NaN,
      Infinity,
      {},
      true,
    ])
      expect(parseAloneTimeout(value)).toBeUndefined();
  });

  it("does not take more than a day", () => {
    expect(parseAloneTimeout("999999999")).toBe(86400);
  });
});

describe("AloneTimer", () => {
  it("does not count a call nobody else has joined yet as being alone", () => {
    const { timer, advance } = setUp();
    expect(timer.state).toEqual({ kind: "waiting-for-others" });
    expect(timer.setOthers(0)).toEqual({ kind: "waiting-for-others" });
    // However long it rings
    advance(3_600_000);
    expect(timer.state).toEqual({ kind: "waiting-for-others" });
    expect(timer.nextDueAt()).toBeUndefined();
  });

  it("counts down from when the last of the others leaves, and expires", () => {
    const { timer, advance, time } = setUp(300);
    expect(timer.setOthers(2)).toEqual({ kind: "with-others" });
    advance(60_000);
    // One of two leaving is not being alone
    expect(timer.setOthers(1)).toEqual({ kind: "with-others" });
    advance(60_000);
    const deadline = time() + 300_000;
    expect(timer.setOthers(0)).toEqual({ kind: "alone", deadline, seq: 1 });
    expect(timer.nextDueAt()).toBe(deadline);
    advance(299_999);
    expect(timer.state).toEqual({ kind: "alone", deadline, seq: 1 });
    advance(1);
    expect(timer.state).toEqual({ kind: "expired" });
    expect(timer.nextDueAt()).toBeUndefined();
  });

  it("stays expired, whatever comes after", () => {
    const { timer, advance } = setUp(180);
    timer.setOthers(1);
    timer.setOthers(0);
    advance(180_000);
    // Somebody comes back in the moment the time is up: too late
    expect(timer.setOthers(1)).toEqual({ kind: "expired" });
    expect(timer.stay()).toEqual({ kind: "expired" });
    expect(timer.setTimeout("never")).toEqual({ kind: "expired" });
    expect(timer.leave()).toEqual({ kind: "expired" });
  });

  it("forgets the countdown when somebody comes back", () => {
    const { timer, advance, time } = setUp(300);
    timer.setOthers(1);
    timer.setOthers(0);
    advance(200_000);
    expect(timer.setOthers(1)).toEqual({ kind: "with-others" });
    expect(timer.nextDueAt()).toBeUndefined();
    // Well past what the deadline was
    advance(500_000);
    expect(timer.state).toEqual({ kind: "with-others" });
    // Alone again: a countdown of its own, in full
    expect(timer.setOthers(0)).toEqual({
      kind: "alone",
      deadline: time() + 300_000,
      seq: 2,
    });
  });

  it("starts over in full when the user stays, and still ends", () => {
    const { timer, advance, time } = setUp(300);
    timer.setOthers(1);
    timer.setOthers(0);
    advance(290_000);
    const deadline = time() + 300_000;
    expect(timer.stay()).toEqual({ kind: "alone", deadline, seq: 2 });
    advance(299_000);
    expect(timer.state.kind).toBe("alone");
    advance(1_000);
    expect(timer.state).toEqual({ kind: "expired" });
  });

  it("has nothing to stay for while nothing counts down", () => {
    const { timer } = setUp(300);
    expect(timer.stay()).toEqual({ kind: "waiting-for-others" });
    timer.setOthers(1);
    expect(timer.stay()).toEqual({ kind: "with-others" });
  });

  it("never ends a call by itself where the timeout is never", () => {
    const { timer, advance } = setUp("never");
    expect(timer.state).toEqual({ kind: "not-applicable" });
    timer.setOthers(1);
    expect(timer.setOthers(0)).toEqual({ kind: "not-applicable" });
    advance(86_400_000);
    expect(timer.state).toEqual({ kind: "not-applicable" });
    expect(timer.nextDueAt()).toBeUndefined();
  });

  it("is not applicable where the host gave no timeout: a voice channel", () => {
    const { timer, advance } = setUp("none");
    timer.setOthers(3);
    expect(timer.setOthers(0)).toEqual({ kind: "not-applicable" });
    advance(86_400_000);
    expect(timer.state).toEqual({ kind: "not-applicable" });
    expect(timer.stay()).toEqual({ kind: "not-applicable" });
  });

  it("starts over with a timeout chosen while it counts down", () => {
    const { timer, advance, time } = setUp(600);
    timer.setOthers(1);
    timer.setOthers(0);
    advance(400_000);
    // Shorter than what has passed already: not the end of the call at once
    expect(timer.setTimeout(180)).toEqual({
      kind: "alone",
      deadline: time() + 180_000,
      seq: 2,
    });
    // The same again changes nothing
    advance(10_000);
    expect(timer.setTimeout(180)).toMatchObject({ seq: 2 });
    advance(170_000);
    expect(timer.state).toEqual({ kind: "expired" });
  });

  it("stops counting when never is chosen, and counts again after", () => {
    const { timer, advance, time } = setUp(300);
    timer.setOthers(1);
    timer.setOthers(0);
    advance(100_000);
    expect(timer.setTimeout("never")).toEqual({ kind: "not-applicable" });
    advance(1_000_000);
    expect(timer.state).toEqual({ kind: "not-applicable" });
    expect(timer.setTimeout(300)).toEqual({
      kind: "alone",
      deadline: time() + 300_000,
      seq: 2,
    });
  });

  it("takes a timeout chosen while others are there for the next time alone", () => {
    const { timer, time } = setUp("never");
    timer.setOthers(1);
    expect(timer.setTimeout(180)).toEqual({ kind: "with-others" });
    expect(timer.setOthers(0)).toEqual({
      kind: "alone",
      deadline: time() + 180_000,
      seq: 1,
    });
  });

  it("counts nothing down once the user left", () => {
    const { timer, advance } = setUp(300);
    timer.setOthers(1);
    timer.setOthers(0);
    expect(timer.leave()).toEqual({ kind: "not-applicable" });
    advance(600_000);
    expect(timer.state).toEqual({ kind: "not-applicable" });
    expect(timer.setOthers(1)).toEqual({ kind: "not-applicable" });
    expect(timer.setOthers(0)).toEqual({ kind: "not-applicable" });
  });
});

describe("hostAloneState", () => {
  it("is what is left of a countdown, and nothing otherwise", () => {
    expect(
      hostAloneState({ kind: "alone", deadline: 10_000, seq: 3 }, 4_000),
    ).toEqual({ ms_left: 6_000, seq: 3 });
    expect(
      hostAloneState({ kind: "alone", deadline: 10_000, seq: 3 }, 11_000),
    ).toEqual({ ms_left: 0, seq: 3 });
    expect(hostAloneState({ kind: "with-others" }, 0)).toBeUndefined();
    expect(hostAloneState({ kind: "expired" }, 0)).toBeUndefined();
    expect(hostAloneState(undefined, 0)).toBeUndefined();
  });
});

describe("formatCountdown", () => {
  it("is minutes and seconds", () => {
    expect(formatCountdown(300_000)).toBe("5:00");
    expect(formatCountdown(299_001)).toBe("5:00");
    expect(formatCountdown(299_000)).toBe("4:59");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(7_000)).toBe("0:07");
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-500)).toBe("0:00");
  });
});
