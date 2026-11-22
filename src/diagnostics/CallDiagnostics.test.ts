/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type LocalRTCMember,
  ObservableScope,
  type ParticipationState,
  type RemoteRTCMember,
  type TrackDiagnostics,
} from "@element-hq/matrixrtc-sdk";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { constant } from "../state/Behavior";
import { mockAudioTrack } from "../utils/test";
import {
  DIAG_STATS_INTERVAL_MS,
  diagSample$,
  recordCallDiagnostics,
} from "./CallDiagnostics";
import { diagBuffer, type DiagRecord, resetDiag } from "./diag";

describe("recordCallDiagnostics", () => {
  let scope: ObservableScope;
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiag();
    scope = new ObservableScope();
  });
  afterEach(() => {
    scope.end();
    vi.useRealTimers();
  });

  it("records the join, the devices and the tracks as they come and go", () => {
    const { state$, localTracks$ } = record(scope);
    state$.next({ kind: "connected" });
    const mic = microphone(() => undefined);
    localTracks$.next([mic]);
    localTracks$.next([]);

    expect(types()).toEqual([
      "call_start",
      "participation",
      "devices",
      "participation",
      "track_new",
      "track_gone",
    ]);
    expect(of("participation").map((r) => r.state)).toEqual([
      "connecting",
      "connected",
    ]);
    expect(of("devices")[0]).toMatchObject({
      kind: "audioInput",
      count: 2,
      labels: ["Headset", "#2"],
    });
    expect(of("track_new")[0]).toMatchObject({
      dir: "send",
      participant: "@me:example.org:DEV",
      source: "microphone",
      sid: "mic",
    });
  });

  it("records a track being muted, but not the state it arrived in", () => {
    const { localTracks$ } = record(scope);
    const muted$ = new BehaviorSubject(false);
    localTracks$.next([{ ...microphone(() => undefined), muted$ }]);
    expect(of("track_muted")).toEqual([]);
    muted$.next(true);
    expect(of("track_muted")[0]).toMatchObject({
      source: "microphone",
      muted: true,
    });
  });

  it("reads every track each interval and judges the reading", async () => {
    const { localTracks$, remoteMembers$ } = record(scope);
    let energy = 0;
    localTracks$.next([
      microphone(() => ({
        stats: [
          { type: "outbound-rtp", kind: "audio", bytesSent: energy * 8000 },
          { type: "media-source", kind: "audio", totalAudioEnergy: energy++ },
        ],
      })),
    ]);
    remoteMembers$.next([
      {
        userId: "@them:example.org",
        deviceId: "OTHER",
        tracks$: constant([
          {
            ...mockAudioTrack({ id: "theirs" }),
            diagnostics: async () =>
              Promise.resolve({
                stats: [{ type: "inbound-rtp", kind: "audio" }],
              }),
          },
        ]),
      } as unknown as RemoteRTCMember,
    ]);

    expect(diagSample$.value).toBeNull();
    await vi.advanceTimersByTimeAsync(DIAG_STATS_INTERVAL_MS);
    expect(of("track").map((r) => [r.dir, r.participant])).toEqual([
      ["send", "@me:example.org:DEV"],
      ["recv", "@them:example.org:OTHER"],
    ]);
    // Sound is only known from the second reading on: it is a difference
    expect(of("tick")[0]).toMatchObject({
      viewers: 1,
      micEnabled: true,
      tracks: 2,
      checks: {
        mic_audio: { status: "fail", detail: "no sound captured yet" },
      },
    });

    await vi.advanceTimersByTimeAsync(DIAG_STATS_INTERVAL_MS);
    expect(of("tick")[1]).toMatchObject({
      checks: { mic_audio: { status: "pass" } },
    });
    expect(diagSample$.value?.tracks).toHaveLength(2);
    expect(diagSample$.value?.checks[0]).toMatchObject({ status: "pass" });
  });

  it("carries on past a track that cannot be read, and ends with the scope", async () => {
    const { localTracks$ } = record(scope);
    localTracks$.next([
      {
        ...microphone(() => undefined),
        diagnostics: async () => Promise.reject(new Error("gone")),
      },
    ]);
    await vi.advanceTimersByTimeAsync(DIAG_STATS_INTERVAL_MS);
    expect(of("tick")).toHaveLength(1);
    expect(of("track")).toEqual([]);

    scope.end();
    expect(types().at(-1)).toBe("call_end");
    expect(diagSample$.value).toBeNull();
    await vi.advanceTimersByTimeAsync(DIAG_STATS_INTERVAL_MS * 3);
    expect(of("tick")).toHaveLength(1);
    scope = new ObservableScope();
  });
});

type LocalTracks = NonNullable<LocalRTCMember["tracks$"]["value"]>;

function record(scope: ObservableScope): {
  state$: BehaviorSubject<ParticipationState>;
  localTracks$: BehaviorSubject<LocalTracks>;
  remoteMembers$: BehaviorSubject<RemoteRTCMember[]>;
} {
  const state$ = new BehaviorSubject<ParticipationState>({
    kind: "connecting",
  });
  const localTracks$ = new BehaviorSubject<LocalTracks>([]);
  const remoteMembers$ = new BehaviorSubject<RemoteRTCMember[]>([]);
  recordCallDiagnostics(scope, {
    participation: {
      state$,
      localMember$: constant({
        tracks$: localTracks$,
      } as unknown as LocalRTCMember),
      remoteMembers$,
    },
    participant: "@me:example.org:DEV",
    micEnabled$: constant(true),
    cameraEnabled$: constant(false),
    devices: {
      audioInput: constant(
        new Map<string, unknown>([
          ["a", { type: "name", name: "Headset" }],
          ["b", { type: "number", number: 2 }],
        ]),
      ),
    },
    share: () => undefined,
  });
  return { state$, localTracks$, remoteMembers$ };
}

function microphone(
  read: () => TrackDiagnostics | undefined,
): LocalTracks[number] {
  return {
    ...mockAudioTrack({ id: "mic" }),
    diagnostics: async () => Promise.resolve(read()),
    setEnabled: async (enabled: boolean) => Promise.resolve(enabled),
    setDevice: async () => Promise.resolve(),
  };
}

function types(): string[] {
  return diagBuffer().map((r) => r.type);
}

function of(type: string): DiagRecord[] {
  return diagBuffer().filter((r) => r.type === type);
}
