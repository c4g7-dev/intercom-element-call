/*
Copyright 2026 The InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  JOIN_LEAVE_SOUND_WINDOW_MS,
  OWN_JOIN_SETTLE_MS,
  parseHostSounds,
  rosterCueDecision,
  type RosterCueContext,
} from "./callEventSounds";

const context = (over: Partial<RosterCueContext> = {}): RosterCueContext => ({
  now: 100_000,
  joinedAt: 0,
  hostPlaysOwnCues: false,
  silenced: false,
  ...over,
});

describe("rosterCueDecision", () => {
  it("plays a sound for somebody joining or leaving", () => {
    expect(rosterCueDecision("join", {}, context())).toEqual({
      play: true,
      history: { join: 100_000 },
    });
    expect(rosterCueDecision("left", {}, context()).play).toBe(true);
  });

  it("plays nothing while the call's sounds are off or the user is deafened", () => {
    const history = { join: 1 };
    expect(
      rosterCueDecision("join", history, context({ silenced: true })),
    ).toEqual({ play: false, history });
    expect(
      rosterCueDecision("left", history, context({ silenced: true })).play,
    ).toBe(false);
  });

  it("plays one sound of a kind when many join at once", () => {
    let history = {};
    const played: boolean[] = [];
    for (const now of [0, 200, 700, 1400, JOIN_LEAVE_SOUND_WINDOW_MS, 1600]) {
      const decision = rosterCueDecision(
        "join",
        history,
        context({ now: 50_000 + now }),
      );
      history = decision.history;
      played.push(decision.play);
    }
    expect(played).toEqual([true, false, false, false, true, false]);
  });

  it("limits joining and leaving apart from each other", () => {
    const afterJoin = rosterCueDecision("join", {}, context()).history;
    expect(
      rosterCueDecision("left", afterJoin, context({ now: 100_100 })).play,
    ).toBe(true);
  });

  it("stays quiet while the list fills up, where the host plays the user's own join", () => {
    const filling = context({
      joinedAt: 10_000,
      now: 10_000 + OWN_JOIN_SETTLE_MS - 1,
      hostPlaysOwnCues: true,
    });
    expect(rosterCueDecision("join", {}, filling).play).toBe(false);
    expect(
      rosterCueDecision(
        "join",
        {},
        {
          ...filling,
          now: 10_000 + OWN_JOIN_SETTLE_MS,
        },
      ).play,
    ).toBe(true);
  });

  it("plays the entering sound itself where the host does not", () => {
    expect(
      rosterCueDecision("join", {}, context({ joinedAt: 99_900 })).play,
    ).toBe(true);
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
