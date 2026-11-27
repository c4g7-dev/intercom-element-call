/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type AudioMediaTrack,
  type ObservableScope,
  type RTCParticipation,
  type VideoMediaTrack,
} from "@element-hq/matrixrtc-sdk";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  map,
  of,
  switchMap,
} from "rxjs";

import { type Behavior } from "../state/Behavior";
import {
  type CheckResult,
  carriesSound,
  checkKey,
  evaluateChecks,
} from "./checks";
import { connLink, type ConnLink } from "./connStats";
import { describeError, diag } from "./diag";
import {
  diagSources,
  toTrackRecord,
  type TrackCounters,
  type TrackRecord,
} from "./trackStats";

export const DIAG_STATS_INTERVAL_MS = 2000;

const detailed$ = new BehaviorSubject(false);
/**
 * Whether somebody is looking at live figures (the host's connection
 * details): the readings are then taken twice as often. The log keeps its
 * pace either way.
 */
export const detailedReadings$: Behavior<boolean> = detailed$;
export function setDetailedReadings(wanted: boolean): void {
  if (detailed$.value !== wanted) detailed$.next(wanted);
}

/** The screen share we publish, as far as the call knows of it. */
export interface ShareDiagnostics {
  /** The size it should be sent at, after any scaling; undefined while unknown. */
  expected?: { width: number; height: number };
  audioExpected: boolean;
  /** The limits the egress budget last set, where there is a budget. */
  budget?: {
    mbps: number;
    viewers: number;
    maxBitrate: number;
    maxFramerate: number;
  };
}

/** One reading of the whole call, for the overlay. */
export interface DiagSample {
  t: number;
  participant: string;
  state: string;
  viewers: number;
  micEnabled: boolean;
  cameraEnabled: boolean;
  share: ShareDiagnostics | undefined;
  tracks: TrackRecord[];
  checks: CheckResult[];
  /** The candidate pair the media runs over: ours to the server where we send. */
  link?: ConnLink;
}

const sample$ = new BehaviorSubject<DiagSample | null>(null);
/** The latest reading; null outside a call. */
export const diagSample$: Behavior<DiagSample | null> = sample$;

export interface CallDiagnosticsInputs {
  participation: Pick<
    RTCParticipation,
    "state$" | "localMember$" | "remoteMembers$"
  >;
  /** `userId:deviceId` of this member. */
  participant: string;
  micEnabled$: Behavior<boolean>;
  cameraEnabled$: Behavior<boolean>;
  devices: Record<string, Behavior<Map<string, unknown>>>;
  /** Null while we share no screen. */
  share: () => ShareDiagnostics | undefined;
  intervalMs?: number;
}

type AnyTrack = AudioMediaTrack | VideoMediaTrack;
interface KnownTrack {
  participant: string;
  local: boolean;
  track: AnyTrack;
}

/**
 * Records a call for as long as the scope lives: every track's statistics
 * every two seconds, and what happens to the participation, the devices and
 * the tracks as it happens. Always on; one statistics query per track per
 * interval is all it costs.
 */
export function recordCallDiagnostics(
  scope: ObservableScope,
  {
    participation,
    participant,
    micEnabled$,
    cameraEnabled$,
    devices,
    share,
    intervalMs = DIAG_STATS_INTERVAL_MS,
  }: CallDiagnosticsInputs,
): void {
  const joinedAt = Date.now();
  diag("call_start", { participant });

  participation.state$.pipe(scope.bind()).subscribe((state) => {
    diag("participation", {
      state: state.kind,
      sinceStartMs: Date.now() - joinedAt,
      ...(state.kind === "reconnecting" && { reason: state.reason }),
      ...(state.kind === "failed" && { error: describeError(state.error) }),
    });
  });

  for (const [kind, available$] of Object.entries(devices))
    available$
      .pipe(
        map((available) => [...available.values()].map(deviceLabel)),
        distinctUntilChanged((a, b) => a.join("\n") === b.join("\n")),
        scope.bind(),
      )
      .subscribe((labels) => {
        diag("devices", { kind, count: labels.length, labels });
      });

  const tracks$ = scope.behavior<KnownTrack[]>(
    combineLatest([
      participation.localMember$.pipe(
        switchMap((member) => member?.tracks$ ?? of(null)),
        map((tracks) =>
          (tracks ?? []).map((track) => ({ participant, local: true, track })),
        ),
      ),
      participation.remoteMembers$.pipe(
        switchMap((members) =>
          members.length === 0
            ? of([])
            : combineLatest(
                members.map((member) =>
                  member.tracks$.pipe(
                    map((tracks) =>
                      (tracks ?? []).map((track) => ({
                        participant: `${member.userId}:${member.deviceId}`,
                        local: false,
                        track,
                      })),
                    ),
                  ),
                ),
              ).pipe(map((perMember) => perMember.flat())),
        ),
      ),
    ]).pipe(map(([local, remote]) => [...local, ...remote])),
    [],
  );

  // Tracks coming, going and being muted, as it happens
  const watched = new Map<string, { known: KnownTrack; stop: () => void }>();
  tracks$.pipe(scope.bind()).subscribe((tracks) => {
    const present = new Set(tracks.map(({ track }) => track.id));
    for (const [id, { known, stop }] of watched)
      if (!present.has(id)) {
        stop();
        watched.delete(id);
        diag("track_gone", describe(known));
      }
    for (const known of tracks) {
      if (watched.has(known.track.id)) continue;
      diag("track_new", {
        ...describe(known),
        muted: known.track.muted$.value,
        sinceStartMs: Date.now() - joinedAt,
      });
      let first = true;
      const subscription = known.track.muted$.subscribe((muted) => {
        if (first) first = false;
        else diag("track_muted", { ...describe(known), muted });
      });
      watched.set(known.track.id, {
        known,
        stop: () => subscription.unsubscribe(),
      });
    }
  });
  scope.onEnd(() => {
    for (const { stop } of watched.values()) stop();
    watched.clear();
  });

  const counters = new Map<string, TrackCounters>();
  const lastSoundAt: Record<string, number> = {};
  let reading = false;
  let loggedAt = 0;
  const read = async (): Promise<void> => {
    const now = Date.now();
    const records: TrackRecord[] = [];
    const links: { local: boolean; link: ConnLink }[] = [];
    await Promise.all(
      tracks$.value.map(async ({ participant: owner, local, track }) => {
        const diagnostics = await track.diagnostics().catch(() => undefined);
        if (diagnostics === undefined) return;
        links.push({ local, link: connLink(diagnostics.stats) });
        const { record, counters: next } = toTrackRecord(
          {
            participant: owner,
            local,
            source: track.source,
            kind: track.kind,
            sid: track.id,
            muted: track.muted$.value,
          },
          diagnostics,
          now,
          counters.get(track.id),
        );
        counters.set(track.id, next);
        if (carriesSound(record)) lastSoundAt[track.id] = now;
        records.push(record);
      }),
    );
    for (const id of counters.keys())
      if (!watched.has(id)) {
        counters.delete(id);
        delete lastSoundAt[id];
      }
    const shareNow = share();
    const checks = evaluateChecks(records, {
      now,
      micWanted: micEnabled$.value,
      shareExpected: shareNow?.expected,
      shareAudioExpected: shareNow?.audioExpected ?? false,
      lastSoundAt,
    });
    const viewers = participation.remoteMembers$.value.length;
    const link = (
      links.find((l) => l.local && l.link.transport) ??
      links.find((l) => l.link.transport) ??
      links[0]
    )?.link;
    // Readings taken in between for somebody who watches are not written down
    const log = now - loggedAt >= intervalMs * 0.9;
    if (log) loggedAt = now;
    if (log) for (const record of records) diag("track", { ...record });
    if (log)
      diag("tick", {
        participant,
        state: participation.state$.value.kind,
        viewers,
        micEnabled: micEnabled$.value,
        cameraEnabled: cameraEnabled$.value,
        tracks: records.length,
        ...(shareNow && { share: shareNow }),
        checks: Object.fromEntries(
          checks.map((check) => [
            checkKey(check),
            { status: check.status, detail: check.detail },
          ]),
        ),
      });
    sample$.next({
      t: now,
      participant,
      state: participation.state$.value.kind,
      viewers,
      micEnabled: micEnabled$.value,
      cameraEnabled: cameraEnabled$.value,
      share: shareNow,
      tracks: records,
      checks,
      link,
    });
  };
  // The browser's own timer rather than a scheduled observable: the readings
  // are wall-clock work on the side, not part of the call's reactive state
  const tick = (): void => {
    // A reading that outlasts the interval is not piled upon
    if (reading) return;
    reading = true;
    read()
      .catch((e) => diag("error", { where: "stats", ...describeError(e) }))
      .finally(() => (reading = false));
  };
  let polling: ReturnType<typeof setInterval> | undefined;
  let paced = false;
  // Twice as often while somebody watches, and at once when they start to
  const pace = detailed$.subscribe((detailed) => {
    clearInterval(polling);
    polling = setInterval(tick, detailed ? intervalMs / 2 : intervalMs);
    if (detailed && paced) tick();
    paced = true;
  });
  scope.onEnd(() => {
    pace.unsubscribe();
    clearInterval(polling);
    detailed$.next(false);
    diag("call_end", { durationMs: Date.now() - joinedAt });
    sample$.next(null);
  });
}

function describe({ participant, local, track }: KnownTrack): {
  dir: "send" | "recv";
  participant: string;
  source: string;
  kind: string;
  sid: string;
} {
  return {
    dir: local ? "send" : "recv",
    participant,
    source: diagSources[track.source],
    kind: track.kind,
    sid: track.id,
  };
}

function deviceLabel(label: unknown): string {
  if (typeof label !== "object" || label === null) return String(label);
  const { type, name, number } = label as {
    type?: string;
    name?: string | null;
    number?: number;
  };
  if (typeof name === "string")
    return type === "default" ? `default: ${name}` : name;
  if (typeof number === "number") return `#${number}`;
  return type ?? "unknown";
}
