/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type TrackRecord } from "./trackStats";

export type CheckId =
  | "mic_audio"
  | "share_resolution"
  | "share_audio_send"
  | "share_audio_recv"
  | "no_limitation"
  | "top_layer";

export interface CheckResult {
  id: CheckId;
  /**
   * Whose share the verdict is on, for the checks there is one of per remote
   * member sharing (`share_audio_recv`, `top_layer`).
   */
  participant?: string;
  /** `na` where there is nothing to judge: no share, a microphone muted on purpose. */
  status: "pass" | "fail" | "na";
  detail: string;
}

export interface CheckContext {
  now: number;
  /** Whether the microphone's switch is on. */
  micWanted: boolean;
  /** The size our screen share should be sent at, once known. */
  shareExpected?: { width: number; height: number };
  /** Whether our screen share was started with an audio source. */
  shareAudioExpected: boolean;
  /** When each track last carried sound, by its id. */
  lastSoundAt: Readonly<Record<string, number>>;
}

/** An energy gain over one interval below this is a silent track. */
export const SOUND_ENERGY_THRESHOLD = 1e-7;
/** How long a track may be quiet and still count as carrying sound. */
export const MIC_SOUND_WINDOW_MS = 30_000;
export const SHARE_SOUND_WINDOW_MS = 15_000;
/** Encoders round sizes to what they can code, hence not 1. */
const SIZE_TOLERANCE = 0.97;

export function carriesSound(record: TrackRecord): boolean {
  return (
    record.kind === "audio" &&
    !record.muted &&
    (record.audioEnergyDelta ?? 0) > SOUND_ENERGY_THRESHOLD
  );
}

/** The verdicts on one reading of all tracks. */
export function evaluateChecks(
  tracks: readonly TrackRecord[],
  context: CheckContext,
): CheckResult[] {
  return [
    micCheck(tracks, context),
    shareResolutionCheck(tracks, context),
    shareAudioSendCheck(tracks, context),
    ...shareAudioRecvChecks(tracks, context),
    limitationCheck(tracks),
    ...topLayerChecks(tracks),
  ];
}

/**
 * What a check is filed under in the log: its id, and the member for the
 * checks there is one of per member.
 */
export function checkKey(check: CheckResult): string {
  return check.participant === undefined
    ? check.id
    : `${check.id}:${check.participant}`;
}

/** The remote members whose screen share is being received, in track order. */
function remoteSharers(tracks: readonly TrackRecord[]): string[] {
  return [
    ...new Set(
      tracks
        .filter(
          (t) => t.dir === "recv" && t.source === "screen_share" && !t.muted,
        )
        .map((t) => t.participant),
    ),
  ];
}

function micCheck(
  tracks: readonly TrackRecord[],
  context: CheckContext,
): CheckResult {
  const id = "mic_audio";
  if (!context.micWanted)
    return { id, status: "na", detail: "microphone switched off" };
  const mic = tracks.find((t) => t.dir === "send" && t.source === "microphone");
  if (mic === undefined)
    return { id, status: "fail", detail: "no microphone track published" };
  if (mic.muted) return { id, status: "fail", detail: "track is muted" };
  if (mic.upstreamPaused)
    return { id, status: "fail", detail: "upstream paused" };
  if (mic.trackState === "ended")
    return { id, status: "fail", detail: "capture ended" };
  if (mic.bitrate === 0) return { id, status: "fail", detail: "no bytes sent" };
  const quiet = quietFor(mic, context);
  if (quiet === undefined)
    return { id, status: "fail", detail: "no sound captured yet" };
  if (quiet > MIC_SOUND_WINDOW_MS)
    return {
      id,
      status: "fail",
      detail: `silent for ${Math.round(quiet / 1000)} s`,
    };
  return {
    id,
    status: "pass",
    detail: `${kbps(mic.bitrate)}, level ${(mic.audioLevel ?? 0).toFixed(2)}`,
  };
}

function shareResolutionCheck(
  tracks: readonly TrackRecord[],
  context: CheckContext,
): CheckResult {
  const id = "share_resolution";
  const share = tracks.find(
    (t) => t.dir === "send" && t.source === "screen_share",
  );
  if (share === undefined)
    return { id, status: "na", detail: "not sharing a screen" };
  const expected = context.shareExpected ?? expectedFromCapture(share);
  if (share.width === undefined || share.height === undefined)
    return { id, status: "fail", detail: "no frames sent yet" };
  const sent = `${share.width}x${share.height}`;
  if (expected === undefined)
    return { id, status: "na", detail: `${sent}, capture size unknown` };
  const ok =
    share.width >= expected.width * SIZE_TOLERANCE &&
    share.height >= expected.height * SIZE_TOLERANCE;
  return {
    id,
    status: ok ? "pass" : "fail",
    detail: ok
      ? sent
      : `${sent}, expected ${Math.round(expected.width)}x${Math.round(expected.height)}`,
  };
}

function expectedFromCapture(
  share: TrackRecord,
): { width: number; height: number } | undefined {
  const { width, height } = share.capture ?? {};
  if (!width || !height) return undefined;
  const scale = share.encodings?.at(-1)?.scaleResolutionDownBy ?? 1;
  return { width: width / scale, height: height / scale };
}

/** What is wrong with a share's audio track, if anything. */
function shareAudioProblem(
  track: TrackRecord,
  context: CheckContext,
): string | undefined {
  const quiet = quietFor(track, context);
  if (track.muted) return "muted";
  if (track.bitrate === 0) return "no bytes";
  if (quiet === undefined) return "no sound yet";
  if (quiet > SHARE_SOUND_WINDOW_MS)
    return `silent for ${Math.round(quiet / 1000)} s`;
  return undefined;
}

/**
 * Whether the user has turned a received track all the way down here ("mute
 * for me", volume 0, deafened). The browser measures the level of a track as
 * it plays it, so such a track reads as silent although it arrives.
 */
export function mutedHere(track: TrackRecord): boolean {
  return track.dir === "recv" && track.playbackVolume === 0;
}

/**
 * What is wrong with a track that is muted here: only what does not depend
 * on its sound, which is not measured while it is not played.
 */
function mutedHereProblem(track: TrackRecord): string | undefined {
  if (track.muted) return "muted";
  if (track.bitrate === 0) return "no bytes";
  return undefined;
}

function shareAudioDetail(track: TrackRecord): string {
  return `${kbps(track.bitrate)}, level ${(track.audioLevel ?? 0).toFixed(2)}`;
}

/** The audio of our own screen share, whatever the others are sharing. */
function shareAudioSendCheck(
  tracks: readonly TrackRecord[],
  context: CheckContext,
): CheckResult {
  const id = "share_audio_send";
  const audio = tracks.find(
    (t) => t.dir === "send" && t.source === "screen_share_audio",
  );
  if (audio === undefined)
    return context.shareAudioExpected &&
      tracks.some((t) => t.dir === "send" && t.source === "screen_share")
      ? { id, status: "fail", detail: "no screen share audio track published" }
      : { id, status: "na", detail: "not sharing audio" };
  const problem = shareAudioProblem(audio, context);
  return problem === undefined
    ? { id, status: "pass", detail: shareAudioDetail(audio) }
    : { id, status: "fail", detail: problem };
}

/**
 * The audio received with a remote member's screen share: one verdict per
 * member who is sharing a screen and publishes audio with it. A member who is
 * not sharing has nothing to be heard, so there is none for them.
 */
function shareAudioRecvChecks(
  tracks: readonly TrackRecord[],
  context: CheckContext,
): CheckResult[] {
  const id = "share_audio_recv";
  const results: CheckResult[] = [];
  for (const participant of remoteSharers(tracks)) {
    const audio = tracks.filter(
      (t) =>
        t.dir === "recv" &&
        t.source === "screen_share_audio" &&
        t.participant === participant,
    );
    if (audio.length === 0) continue;
    const problems = audio
      .map((t) =>
        mutedHere(t) ? mutedHereProblem(t) : shareAudioProblem(t, context),
      )
      .filter((p) => p !== undefined);
    const silenced = audio.filter(mutedHere);
    results.push(
      problems.length > 0
        ? { id, participant, status: "fail", detail: problems.join("; ") }
        : silenced.length > 0
          ? {
              // Neither a pass nor a failure: it arrives, and whether it has
              // sound cannot be told while it is not played
              id,
              participant,
              status: "na",
              detail: audio
                .map((t) =>
                  mutedHere(t)
                    ? `receiving ${kbps(t.bitrate)} · muted by you`
                    : shareAudioDetail(t),
                )
                .join("; "),
            }
          : {
              id,
              participant,
              status: "pass",
              detail: audio.map(shareAudioDetail).join("; "),
            },
    );
  }
  return results;
}

function limitationCheck(tracks: readonly TrackRecord[]): CheckResult {
  const id = "no_limitation";
  const video = tracks.filter(
    (t) => t.dir === "send" && t.kind === "video" && !t.muted,
  );
  if (video.length === 0) return { id, status: "na", detail: "no video sent" };
  const limited = video.filter(
    (t) => t.limitation !== undefined && t.limitation !== "none",
  );
  if (limited.length === 0) return { id, status: "pass", detail: "none" };
  return {
    id,
    status: "fail",
    detail: limited.map((t) => `${t.source}: ${t.limitation}`).join(", "),
  };
}

/**
 * Whether a remote member's screen share arrives at the largest size on
 * offer: one verdict per member sharing, none where nobody is.
 */
function topLayerChecks(tracks: readonly TrackRecord[]): CheckResult[] {
  const id = "top_layer";
  return remoteSharers(tracks).map((participant) => {
    const problems: string[] = [];
    const fine: string[] = [];
    for (const share of tracks) {
      if (
        share.dir !== "recv" ||
        share.source !== "screen_share" ||
        share.muted ||
        share.participant !== participant
      )
        continue;
      const top = topPublishedLayer(share);
      if (share.height === undefined || share.width === undefined)
        problems.push("no frames");
      else if (top !== undefined && share.height < top.height * 0.9)
        problems.push(
          `${share.width}x${share.height} of ${top.width}x${top.height}`,
        );
      else fine.push(`${share.width}x${share.height}`);
    }
    return problems.length > 0
      ? { id, participant, status: "fail", detail: problems.join("; ") }
      : { id, participant, status: "pass", detail: fine.join(", ") };
  });
}

/** The largest size the publisher offers. */
export function topPublishedLayer(
  track: TrackRecord,
): { width: number; height: number } | undefined {
  const published = track.published;
  if (published === undefined) return undefined;
  let top: { width: number; height: number } | undefined;
  for (const layer of published.layers)
    if (layer.height > 0 && (top === undefined || layer.height > top.height))
      top = { width: layer.width, height: layer.height };
  if (top === undefined && published.width && published.height)
    top = { width: published.width, height: published.height };
  return top;
}

function quietFor(
  track: TrackRecord,
  context: CheckContext,
): number | undefined {
  const last = context.lastSoundAt[track.sid];
  return last === undefined ? undefined : Math.max(0, context.now - last);
}

function kbps(bitrate: number | undefined): string {
  return bitrate === undefined
    ? "? kbps"
    : `${Math.round(bitrate / 1000)} kbps`;
}
