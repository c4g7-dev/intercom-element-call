/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOST_CALL_STATE_DEBOUNCE_MS,
  type HostCallState,
  hostCallState$,
  type HostParticipantState,
  hostParticipants$,
  type HostStateMedia,
} from "./hostCallState";
import { type DeviceAvailability } from "./deviceAvailability";
import { type AloneState } from "./aloneTimer";

function media(
  userId: string,
  local = false,
): HostStateMedia & {
  speaking$: BehaviorSubject<boolean>;
  audioEnabled$: BehaviorSubject<boolean>;
  screenShares$: BehaviorSubject<unknown[]>;
} {
  return {
    userId,
    local,
    speaking$: new BehaviorSubject(false),
    audioEnabled$: new BehaviorSubject(true),
    screenShares$: new BehaviorSubject<unknown[]>([]),
  };
}

describe("hostParticipants$", () => {
  it("follows who is in the call, who speaks, who is muted and who shares", () => {
    const ada = media("@ada:x", true);
    const ben = media("@ben:x");
    const media$ = new BehaviorSubject<HostStateMedia[]>([]);
    const seen: HostParticipantState[][] = [];
    const subscription = hostParticipants$(media$).subscribe((p) =>
      seen.push(p),
    );

    expect(seen.at(-1)).toEqual([]);
    media$.next([ada, ben]);
    expect(seen.at(-1)).toEqual([
      {
        user_id: "@ada:x",
        local: true,
        speaking: false,
        audio_enabled: true,
        screen_sharing: false,
      },
      {
        user_id: "@ben:x",
        local: false,
        speaking: false,
        audio_enabled: true,
        screen_sharing: false,
      },
    ]);

    ben.speaking$.next(true);
    ben.screenShares$.next([{}]);
    ada.audioEnabled$.next(false);
    expect(seen.at(-1)).toEqual([
      expect.objectContaining({ user_id: "@ada:x", audio_enabled: false }),
      expect.objectContaining({
        user_id: "@ben:x",
        speaking: true,
        screen_sharing: true,
      }),
    ]);

    media$.next([ada]);
    expect(seen.at(-1)).toHaveLength(1);
    subscription.unsubscribe();
  });

  it("makes one entry of somebody who is in the call with two devices", () => {
    const phone = media("@ben:x");
    const desktop = media("@ben:x");
    phone.audioEnabled$.next(false);
    desktop.speaking$.next(true);
    desktop.screenShares$.next([{}]);
    let last: HostParticipantState[] = [];
    hostParticipants$(new BehaviorSubject([phone, desktop]))
      .subscribe((p) => (last = p))
      .unsubscribe();
    expect(last).toEqual([
      {
        user_id: "@ben:x",
        local: false,
        speaking: true,
        audio_enabled: true,
        screen_sharing: true,
      },
    ]);
  });
});

describe("hostCallState$", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tells the host once things hold still, and only what changed", () => {
    const audioEnabled$ = new BehaviorSubject(true);
    const videoEnabled$ = new BehaviorSubject(false);
    const audioState$ = new BehaviorSubject<DeviceAvailability>("on");
    const videoState$ = new BehaviorSubject<DeviceAvailability>("no-device");
    const deafened$ = new BehaviorSubject(false);
    const sharingScreen$ = new BehaviorSubject(false);
    const reconnecting$ = new BehaviorSubject(false);
    const participants$ = new BehaviorSubject<HostParticipantState[]>([]);
    const seen: HostCallState[] = [];
    const subscription = hostCallState$({
      audioEnabled$,
      videoEnabled$,
      audioState$,
      videoState$,
      deafened$,
      sharingScreen$,
      canShareScreen: true,
      reconnecting$,
      participants$,
    }).subscribe((s) => seen.push(s));

    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(HOST_CALL_STATE_DEBOUNCE_MS);
    expect(seen).toEqual([
      {
        audio_enabled: true,
        video_enabled: false,
        audio_state: "on",
        video_state: "no-device",
        deafened: false,
        screen_sharing: false,
        can_share_screen: true,
        reconnecting: false,
        participants: [],
      },
    ]);

    // A burst is one message
    audioEnabled$.next(false);
    deafened$.next(true);
    sharingScreen$.next(true);
    vi.advanceTimersByTime(HOST_CALL_STATE_DEBOUNCE_MS);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      audio_enabled: false,
      deafened: true,
      screen_sharing: true,
    });

    // A camera that is plugged in, a microphone that is blocked
    videoState$.next("off");
    audioState$.next("no-permission");
    vi.advanceTimersByTime(HOST_CALL_STATE_DEBOUNCE_MS);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({
      audio_state: "no-permission",
      video_state: "off",
    });

    // What changes and changes back within the wait is nothing to tell
    reconnecting$.next(true);
    reconnecting$.next(false);
    participants$.next([]);
    vi.advanceTimersByTime(HOST_CALL_STATE_DEBOUNCE_MS);
    expect(seen).toHaveLength(3);
    subscription.unsubscribe();
  });

  it("tells the host what is left of a countdown, when it changes", () => {
    let now = 50_000;
    const alone$ = new BehaviorSubject<AloneState | undefined>({
      kind: "with-others",
    });
    const audioEnabled$ = new BehaviorSubject(true);
    const seen: HostCallState[] = [];
    const subscription = hostCallState$({
      audioEnabled$,
      videoEnabled$: new BehaviorSubject(false),
      audioState$: new BehaviorSubject<DeviceAvailability>("on"),
      videoState$: new BehaviorSubject<DeviceAvailability>("off"),
      deafened$: new BehaviorSubject(false),
      sharingScreen$: new BehaviorSubject(false),
      canShareScreen: true,
      reconnecting$: new BehaviorSubject(false),
      participants$: new BehaviorSubject<HostParticipantState[]>([]),
      alone$,
      now: () => now,
    }).subscribe((s) => seen.push(s));
    const settle = (): void =>
      void vi.advanceTimersByTime(HOST_CALL_STATE_DEBOUNCE_MS);

    settle();
    expect(seen).toHaveLength(1);
    expect("alone" in seen[0]).toBe(false);

    alone$.next({ kind: "alone", deadline: now + 300_000, seq: 1 });
    settle();
    expect(seen[1].alone).toEqual({ ms_left: 300_000, seq: 1 });

    // Nothing is sent while it only counts down
    now += 100_000;
    settle();
    expect(seen).toHaveLength(2);

    // What else changes carries what is left by then
    audioEnabled$.next(false);
    settle();
    expect(seen[2].alone).toEqual({ ms_left: 200_000, seq: 1 });

    // Staying is the same time left again, and still told: another countdown
    now += 100_000;
    audioEnabled$.next(true);
    settle();
    alone$.next({ kind: "alone", deadline: now + 300_000, seq: 2 });
    settle();
    expect(seen[4].alone).toEqual({ ms_left: 300_000, seq: 2 });

    // Somebody came back
    alone$.next({ kind: "with-others" });
    settle();
    expect(seen).toHaveLength(6);
    expect("alone" in seen[5]).toBe(false);
    subscription.unsubscribe();
  });
});
