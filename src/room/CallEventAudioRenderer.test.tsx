/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { render } from "@testing-library/react";
import {
  beforeEach,
  expect,
  type MockedFunction,
  test,
  vitest,
  afterEach,
} from "vitest";
import { act } from "react";
import { type RoomMember } from "matrix-js-sdk";
import {
  type UnstableLivekitTransport,
  type CallMembership,
} from "matrix-js-sdk/lib/matrixrtc";

import {
  exampleTransport,
  mockMatrixRoomMember,
  mockRtcMembership,
} from "../utils/test";
import { CallEventAudioRenderer } from "./CallEventAudioRenderer";
import { useAudioContext } from "../useAudioContext";
import { prefetchSounds } from "../soundUtils";
import { getBasicCallViewModelEnvironment } from "../utils/test-viewmodel";
import {
  alice,
  aliceRtcMember,
  bob,
  bobRtcMember,
  local,
  localRtcMember,
} from "../utils/test-fixtures";
import { MAX_PARTICIPANT_COUNT_FOR_SOUND } from "../state/CallViewModel/CallViewModel";
import { initializeWidget } from "../widget";
import {
  type HostBridge,
  HostBridgeProvider,
  nullHostBridge,
} from "../HostBridge";
import {
  JOIN_LEAVE_SOUND_WINDOW_MS,
  OWN_JOIN_SETTLE_MS,
  ROSTER_SETTLE_MS,
} from "../state/callEventSounds";
initializeWidget();
vitest.mock("../useAudioContext");
vitest.mock("../soundUtils");
vitest.mock("../rtcSessionHelpers", async (importOriginal) => ({
  ...(await importOriginal()),
  makeTransport: (): [UnstableLivekitTransport] => [exampleTransport],
}));

afterEach(() => {
  vitest.clearAllMocks();
  vitest.useRealTimers();
});

let playSound: MockedFunction<
  NonNullable<ReturnType<typeof useAudioContext>>["playSound"]
>;

beforeEach(() => {
  (prefetchSounds as MockedFunction<typeof prefetchSounds>).mockResolvedValue({
    sound: new ArrayBuffer(0),
  });
  vitest.useFakeTimers();
  playSound = vitest.fn();
  (useAudioContext as MockedFunction<typeof useAudioContext>).mockReturnValue({
    playSound,
    playSoundLooping: vitest.fn(),
    soundDuration: {},
  });
});

// InterCom: who came and who went is decided by RosterCueGate, on a clock:
// a change is a sound once it has stood for a moment
const carolRtcMember = mockRtcMembership("@carol:example.org", "CCCC");
const carol = mockMatrixRoomMember(carolRtcMember);

/** Lets the host's answer about the sounds arrive, and time pass. */
async function wait(ms: number): Promise<void> {
  // The answer first, and what React does with it, before the clock moves
  await act(async () => {
    await vitest.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vitest.advanceTimersByTimeAsync(ms);
  });
}

function hostThatPlaysOwnCues(): {
  bridge: HostBridge;
  notifyLeaveSoundPlayed: MockedFunction<() => Promise<void>>;
} {
  const notifyLeaveSoundPlayed = vitest.fn().mockResolvedValue(undefined);
  return {
    bridge: {
      ...nullHostBridge,
      requestSounds: vitest
        .fn()
        .mockResolvedValue({ hostPlaysOwnCues: true, sounds: {} }),
      notifyLeaveSoundPlayed,
    },
    notifyLeaveSoundPlayed,
  };
}

/**
 * We don't want to play a sound when loading the call state
 * because typically this occurs in two stages. We first join
 * the call as a local participant and *then* the remote
 * participants join from our perspective. We don't want to make
 * a noise every time.
 */
test("plays one sound when entering a call", async () => {
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
    bob,
  ]);
  render(<CallEventAudioRenderer vm={vm} />);

  // Joining a call usually means remote participants are added later.
  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember, bobRtcMember]);
  });
  await wait(OWN_JOIN_SETTLE_MS + ROSTER_SETTLE_MS);
  expect(playSound).toHaveBeenCalledExactlyOnceWith("join");
});

test("plays a sound when a user joins", async () => {
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment(
    [local, alice, bob],
    [localRtcMember, aliceRtcMember],
  );
  render(<CallEventAudioRenderer vm={vm} />);
  await wait(OWN_JOIN_SETTLE_MS);
  playSound.mockClear();

  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember, bobRtcMember]);
  });
  expect(playSound).not.toBeCalled();
  await wait(ROSTER_SETTLE_MS);
  expect(playSound).toHaveBeenCalledExactlyOnceWith("join");
});

test("plays a sound when a user leaves", async () => {
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
  ]);
  render(<CallEventAudioRenderer vm={vm} />);
  await wait(OWN_JOIN_SETTLE_MS);
  playSound.mockClear();

  act(() => {
    rtcMemberships$.next([localRtcMember]);
  });
  await wait(ROSTER_SETTLE_MS);
  expect(playSound).toHaveBeenCalledExactlyOnceWith("left");
});

test("does not play a sound before the call is successful", async () => {
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment(
    [local, alice],
    [localRtcMember],
    undefined,
    { waitForCallPickup: true },
  );
  render(<CallEventAudioRenderer vm={vm} />);

  act(() => {
    rtcMemberships$.next([localRtcMember]);
  });
  await wait(OWN_JOIN_SETTLE_MS + ROSTER_SETTLE_MS);
  expect(playSound).not.toBeCalledWith("left");
});

test("plays no sound when the participant list is more than the maximum size", async () => {
  const mockMembers: RoomMember[] = [local];
  const mockRtcMemberships: CallMembership[] = [localRtcMember];
  for (let i = 0; i < MAX_PARTICIPANT_COUNT_FOR_SOUND; i++) {
    const membership = mockRtcMembership(`@user${i}:example.org`, `DEVICE${i}`);
    mockMembers.push(mockMatrixRoomMember(membership));
    mockRtcMemberships.push(membership);
  }

  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment(
    mockMembers,
    mockRtcMemberships,
  );

  render(<CallEventAudioRenderer vm={vm} />);
  await wait(OWN_JOIN_SETTLE_MS);
  expect(playSound).not.toBeCalled();
  // Remove the last membership in the array to test the leaving sound
  // (The array has length MAX_PARTICIPANT_COUNT_FOR_SOUND + 1)
  act(() => {
    rtcMemberships$.next(
      mockRtcMemberships.slice(0, MAX_PARTICIPANT_COUNT_FOR_SOUND),
    );
  });
  await wait(ROSTER_SETTLE_MS);
  expect(playSound).toHaveBeenCalledExactlyOnceWith("left");
});

test("plays one sound when a hand is raised", () => {
  const { vm, handRaisedSubject$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
    bob,
  ]);
  render(<CallEventAudioRenderer vm={vm} />);

  act(() => {
    handRaisedSubject$.next({
      // TODO: What is this string supposed to be?
      [`${bobRtcMember.userId}:${bobRtcMember.deviceId}`]: {
        time: new Date(),
        membershipEventId: "",
        reactionEventId: "",
      },
    });
  });
  expect(playSound).toBeCalledWith("raiseHand");
});

test("should not play a sound when a hand raise is retracted", () => {
  const { vm, handRaisedSubject$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
  ]);
  render(<CallEventAudioRenderer vm={vm} />);

  playSound.mockClear();
  act(() => {
    handRaisedSubject$.next({
      ["foo"]: {
        time: new Date(),
        membershipEventId: "",
        reactionEventId: "",
      },
      ["bar"]: {
        time: new Date(),
        membershipEventId: "",
        reactionEventId: "",
      },
    });
  });
  expect(playSound).toHaveBeenCalledExactlyOnceWith("raiseHand");
  act(() => {
    handRaisedSubject$.next({
      ["foo"]: {
        time: new Date(),
        membershipEventId: "",
        reactionEventId: "",
      },
    });
  });
  expect(playSound).toHaveBeenCalledExactlyOnceWith("raiseHand");
});

test("InterCom: plays one join sound when several people join at once", async () => {
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment(
    [local, alice, bob, carol],
    [localRtcMember],
  );
  render(<CallEventAudioRenderer vm={vm} />);
  await wait(OWN_JOIN_SETTLE_MS);
  playSound.mockClear();

  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember]);
  });
  await wait(300);
  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember, bobRtcMember]);
  });
  await wait(1000);
  expect(playSound).toHaveBeenCalledExactlyOnceWith("join");
  await wait(JOIN_LEAVE_SOUND_WINDOW_MS);
  act(() => {
    rtcMemberships$.next([
      localRtcMember,
      aliceRtcMember,
      bobRtcMember,
      carolRtcMember,
    ]);
  });
  await wait(ROSTER_SETTLE_MS);
  expect(playSound).toHaveBeenCalledTimes(2);
  expect(playSound).toHaveBeenLastCalledWith("join");
});

function renderWithHost(
  vm: Parameters<typeof CallEventAudioRenderer>[0]["vm"],
  bridge: HostBridge,
): void {
  render(
    <HostBridgeProvider value={bridge}>
      <CallEventAudioRenderer vm={vm} />
    </HostBridgeProvider>,
  );
}

test("InterCom: the user's own join is the host's, and the list filling up is nobody joining", async () => {
  const host = hostThatPlaysOwnCues();
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment(
    [local, alice, bob],
    [localRtcMember],
  );
  renderWithHost(vm, host.bridge);
  await wait(500);
  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember, bobRtcMember]);
  });
  await wait(10_000);
  expect(playSound).not.toBeCalled();
});

test("InterCom: tells the host of the leave sound it played for another one", async () => {
  const host = hostThatPlaysOwnCues();
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment(
    [local, alice, bob],
    [localRtcMember, aliceRtcMember, bobRtcMember],
  );
  renderWithHost(vm, host.bridge);
  await wait(OWN_JOIN_SETTLE_MS);
  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember]);
  });
  await wait(ROSTER_SETTLE_MS);
  expect(playSound).toHaveBeenCalledExactlyOnceWith("left");
  expect(host.notifyLeaveSoundPlayed).toHaveBeenCalledOnce();
});

test("InterCom: plays nothing for the call falling apart once the user hangs up", async () => {
  const host = hostThatPlaysOwnCues();
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
  ]);
  renderWithHost(vm, host.bridge);
  await wait(OWN_JOIN_SETTLE_MS);
  // The other one of a call of two leaves, and the user hangs up right after
  act(() => {
    rtcMemberships$.next([localRtcMember]);
  });
  await wait(ROSTER_SETTLE_MS - 100);
  act(() => vm.hangup());
  act(() => {
    rtcMemberships$.next([]);
  });
  await wait(10_000);
  expect(playSound).not.toBeCalled();
  expect(host.notifyLeaveSoundPlayed).not.toBeCalled();
});

test("InterCom: makes no sound for another device of the user's own, or a second one of somebody", async () => {
  const host = hostThatPlaysOwnCues();
  const ownOther = mockRtcMembership(localRtcMember.userId, "OTHERDEVICE");
  const aliceOther = mockRtcMembership(aliceRtcMember.userId, "ALICE2");
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
  ]);
  renderWithHost(vm, host.bridge);
  await wait(OWN_JOIN_SETTLE_MS);
  for (const memberships of [
    [localRtcMember, aliceRtcMember, ownOther],
    [localRtcMember, aliceRtcMember],
    [localRtcMember, aliceRtcMember, aliceOther],
    [localRtcMember, aliceRtcMember],
  ]) {
    act(() => {
      rtcMemberships$.next(memberships);
    });
    await wait(5000);
  }
  expect(playSound).not.toBeCalled();
});

test("InterCom: makes no sound for somebody who is gone and back at once", async () => {
  const host = hostThatPlaysOwnCues();
  const { vm, rtcMemberships$ } = getBasicCallViewModelEnvironment([
    local,
    alice,
  ]);
  renderWithHost(vm, host.bridge);
  await wait(OWN_JOIN_SETTLE_MS);
  act(() => {
    rtcMemberships$.next([localRtcMember]);
  });
  await wait(ROSTER_SETTLE_MS - 100);
  act(() => {
    rtcMemberships$.next([localRtcMember, aliceRtcMember]);
  });
  await wait(5000);
  expect(playSound).not.toBeCalled();
});
