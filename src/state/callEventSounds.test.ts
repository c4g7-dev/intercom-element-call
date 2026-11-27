/*
Copyright 2026 The InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  callPlaysOwnLeave,
  hostSounds,
  hostSoundsNow,
  JOIN_LEAVE_SOUND_WINDOW_MS,
  OWN_JOIN_SETTLE_MS,
  parseHostSounds,
  RECONNECT_QUIET_MS,
  ROSTER_SETTLE_MS,
  type RosterCue,
  RosterCueGate,
  soundRoster,
} from "./callEventSounds";

const ME = "@me:example.org";
const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";
const CAROL = "@carol:example.org";

describe("soundRoster", () => {
  it("counts the others by user, and none of the user's own devices", () => {
    expect(
      soundRoster(
        [
          { userId: ME },
          { userId: ALICE },
          { userId: ME },
          { userId: ALICE },
          { userId: BOB },
        ],
        ME,
      ),
    ).toEqual({ others: [ALICE, BOB], count: 5 });
    expect(soundRoster([], ME)).toEqual({ others: [], count: 0 });
  });
});

/**
 * A gate on a clock of the test's, in a call the user joined long enough ago
 * for its list to have filled, with the host playing the user's own sounds.
 */
function gateInCall(
  others: string[],
  { hostPlaysOwnCues = true } = {},
): {
  played: RosterCue[];
  /** Who is in the call now: the others, by device */
  members: (others: string[], reconnecting?: boolean) => void;
  /** Lets time pass, asking the gate whenever it has something due */
  wait: (ms: number) => void;
  gate: RosterCueGate;
  silence: (silenced: boolean) => void;
} {
  let now = 1_000_000;
  let silenced = false;
  const played: RosterCue[] = [];
  const gate = new RosterCueGate({ now: () => now, maxCount: 8 });
  const poll = (): void => void played.push(...gate.poll({ silenced }));
  const members = (list: string[], reconnecting = false): void => {
    gate.update(
      soundRoster(
        [ME, ...list].map((userId) => ({ userId })),
        ME,
      ),
      reconnecting,
    );
    poll();
  };
  const wait = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = gate.nextDueAt();
      if (due === undefined || due > end) break;
      now = Math.max(now, due);
      poll();
    }
    now = end;
    poll();
  };
  gate.hostAnswered(hostPlaysOwnCues);
  members(others);
  wait(OWN_JOIN_SETTLE_MS);
  members(others);
  return { played, members, wait, gate, silence: (s) => (silenced = s) };
}

describe("RosterCueGate", () => {
  it("is quiet while the list fills up after the user's own join", () => {
    const { played } = gateInCall([ALICE, BOB]);
    expect(played).toEqual([]);
  });

  it("plays the entering sound itself, once, where no host does", () => {
    const { played, members, wait } = gateInCall([ALICE], {
      hostPlaysOwnCues: false,
    });
    expect(played).toEqual(["join"]);
    members([ALICE]);
    wait(10_000);
    expect(played).toEqual(["join"]);
  });

  it("does not play the entering sound before the host has answered", () => {
    let now = 0;
    const gate = new RosterCueGate({ now: () => now, maxCount: 8 });
    gate.update({ others: [], count: 1 });
    expect(gate.nextDueAt()).toBeUndefined();
    now = 5000;
    expect(gate.poll({ silenced: false })).toEqual([]);
    gate.hostAnswered(true);
    expect(gate.poll({ silenced: false })).toEqual([]);
    expect(gate.nextDueAt()).toBeUndefined();
  });

  it("chimes for another one joining and leaving a group call while the user stays", () => {
    const { played, members, wait } = gateInCall([ALICE]);
    members([ALICE, BOB]);
    expect(played).toEqual([]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["join"]);
    wait(10_000);
    members([ALICE]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["join", "left"]);
    wait(10_000);
    members([]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["join", "left", "left"]);
  });

  it("plays one sound of a kind when several come or go at once", () => {
    const { played, members, wait } = gateInCall([]);
    members([ALICE]);
    wait(300);
    members([ALICE, BOB]);
    wait(700);
    members([ALICE, BOB, CAROL]);
    wait(ROSTER_SETTLE_MS);
    // Alice at 600, Bob at 900 (too soon after), Carol at 1600 (still)
    expect(played).toEqual(["join"]);
    wait(JOIN_LEAVE_SOUND_WINDOW_MS);
    members([]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["join", "left"]);
  });

  it("plays nothing once the user leaves: a DM that ends is the user's own leave alone", () => {
    // We hang up, and the call falls apart
    const ours = gateInCall([ALICE]);
    ours.gate.close();
    ours.members([]);
    ours.wait(10_000);
    expect(ours.played).toEqual([]);
    expect(ours.gate.nextDueAt()).toBeUndefined();

    // The other one hangs up, and the call leaves by itself at once
    const theirs = gateInCall([ALICE]);
    theirs.members([]);
    theirs.gate.close();
    theirs.wait(10_000);
    expect(theirs.played).toEqual([]);

    // The other one hangs up, and we do a moment later, before the sound
    const both = gateInCall([ALICE]);
    both.members([]);
    both.wait(ROSTER_SETTLE_MS - 1);
    both.gate.close();
    both.wait(10_000);
    expect(both.played).toEqual([]);
  });

  it("plays the other one's leave where the user stays in the call alone", () => {
    const { played, members, wait } = gateInCall([ALICE]);
    members([]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["left"]);
  });

  it("makes no sound for the user's own other device, or a second device of somebody", () => {
    const { played, gate, wait } = gateInCall([ALICE]);
    const withDevices = (userIds: string[]): void =>
      gate.update(
        soundRoster(
          userIds.map((userId) => ({ userId })),
          ME,
        ),
        false,
      );
    withDevices([ME, ALICE, ME]);
    wait(5000);
    withDevices([ME, ALICE]);
    wait(5000);
    withDevices([ME, ALICE, ALICE]);
    wait(5000);
    withDevices([ME, ALICE]);
    wait(5000);
    // And the user's own membership going while the call is torn down
    withDevices([ALICE]);
    wait(5000);
    expect(played).toEqual([]);
  });

  it("makes no sound for a membership that flaps", () => {
    const { played, members, wait } = gateInCall([ALICE]);
    // Gone and back: a reconnect of theirs
    members([]);
    wait(ROSTER_SETTLE_MS - 1);
    members([ALICE]);
    wait(5000);
    expect(played).toEqual([]);
    // There and gone: a join that did not come about
    members([ALICE, BOB]);
    wait(ROSTER_SETTLE_MS - 1);
    members([ALICE]);
    wait(5000);
    expect(played).toEqual([]);
  });

  it("makes no sound for what the user's own reconnect does to the list", () => {
    const { played, members, wait } = gateInCall([ALICE, BOB]);
    members([], true);
    wait(4000);
    members([ALICE], true);
    members([ALICE], false);
    wait(RECONNECT_QUIET_MS - 1);
    members([ALICE, BOB], false);
    wait(5000);
    expect(played).toEqual([]);
    // Bob was there before and is there again; who leaves after that is heard
    members([ALICE]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["left"]);
  });

  it("plays nothing while silenced (deafened), and does not make up for it after", () => {
    const { played, members, wait, silence } = gateInCall([ALICE]);
    silence(true);
    members([]);
    wait(5000);
    silence(false);
    wait(5000);
    expect(played).toEqual([]);
    members([ALICE]);
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["join"]);
  });

  it("plays nothing in a call larger than the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => `@u${i}:example.org`);
    const { played, members, wait } = gateInCall(many);
    members(many.slice(0, 8));
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual([]);
    wait(5000);
    members(many.slice(0, 7));
    wait(ROSTER_SETTLE_MS);
    expect(played).toEqual(["left"]);
  });
});

describe("the host's answer about the sounds", () => {
  it("is asked for once, and known from when it came", async () => {
    let calls = 0;
    const host = {
      requestSounds: async (): Promise<{
        hostPlaysOwnCues: boolean;
        sounds: object;
      }> => {
        calls++;
        return await Promise.resolve({ hostPlaysOwnCues: true, sounds: {} });
      },
    };
    expect(hostSoundsNow(host)).toBeUndefined();
    const [a, b] = await Promise.all([hostSounds(host), hostSounds(host)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(hostSoundsNow(host)?.hostPlaysOwnCues).toBe(true);
  });

  it("takes a host that fails to answer for one that says nothing", async () => {
    const host = {
      requestSounds: async (): Promise<undefined> =>
        await Promise.reject(new Error("no")),
    };
    expect(await hostSounds(host)).toBeUndefined();
    expect(hostSoundsNow(host)).toBeUndefined();
  });

  it("leaves the user's own leave sound to the host that plays it", () => {
    expect(callPlaysOwnLeave(undefined)).toBe(true);
    expect(callPlaysOwnLeave({ hostPlaysOwnCues: false, sounds: {} })).toBe(
      true,
    );
    expect(callPlaysOwnLeave({ hostPlaysOwnCues: true, sounds: {} })).toBe(
      false,
    );
  });
});

describe("parseHostSounds", () => {
  it("takes a host that does not answer the question for one without sounds", () => {
    for (const reply of [undefined, null, "x", 3, {}, { sounds: 5 }]) {
      expect(parseHostSounds(reply)).toEqual({
        hostPlaysOwnCues: false,
        sounds: {},
      });
    }
  });

  it("reads the user's own files", () => {
    const parsed = parseHostSounds({
      host_cues: true,
      sounds: { join: { data: btoa("abc") }, leave: { data: btoa("de") } },
    });
    expect(parsed.hostPlaysOwnCues).toBe(true);
    expect(new Uint8Array(parsed.sounds.join!)).toEqual(
      new Uint8Array([97, 98, 99]),
    );
    expect(parsed.sounds.left!.byteLength).toBe(2);
    expect(parsed.ringback).toBeUndefined();
  });

  it("reads the user's own ringback, apart from the sounds of the roster", () => {
    const parsed = parseHostSounds({
      host_cues: true,
      sounds: { ringback: { data: btoa("ring") }, ringtone: { data: "QUJD" } },
    });
    expect(parsed.sounds).toEqual({});
    expect(new Uint8Array(parsed.ringback!)).toEqual(
      new Uint8Array([114, 105, 110, 103]),
    );
  });

  it("leaves out what is not a sound file", () => {
    const parsed = parseHostSounds({
      host_cues: true,
      sounds: {
        join: { data: "not base64 !!" },
        leave: { data: "A".repeat(3 * 1024 * 1024) },
        mute: { data: btoa("x") },
      },
    });
    expect(parsed.sounds).toEqual({});
  });
});
