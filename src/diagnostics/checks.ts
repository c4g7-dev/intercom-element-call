/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type TrackRecord } from "./trackStats";

export type CheckId =
  | "mic_audio"
  | "share_resolution"
  | "share_audio"
  | "no_limitation"
  | "top_layer";

export interface CheckResult {
  id: CheckId;
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
    shareAudioCheck(tracks, context),
    limitationCheck(tracks),
    topLayerCheck(tracks),
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

function shareAudioCheck(
  tracks: readonly TrackRecord[],
  context: CheckContext,
): CheckResult {
  const id = "share_audio";
  const audio = tracks.filter((t) => t.source === "screen_share_audio");
  if (audio.length === 0)
    return context.shareAudioExpected &&
      tracks.some((t) => t.dir === "send" && t.source === "screen_share")
      ? { id, status: "fail", detail: "no screen share audio track published" }
      : { id, status: "na", detail: "no screen share audio" };
  const problems: string[] = [];
  for (const track of audio) {
    const quiet = quietFor(track, context);
    const whose = track.dir === "send" ? "ours" : track.participant;
    if (track.muted) problems.push(`${whose}: muted`);
    else if (track.bitrate === 0) problems.push(`${whose}: no bytes`);
    else if (quiet === undefined) problems.push(`${whose}: no sound yet`);
    else if (quiet > SHARE_SOUND_WINDOW_MS)
      problems.push(`${whose}: silent for ${Math.round(quiet / 1000)} s`);
  }
  if (problems.length > 0)
    return { id, status: "fail", detail: problems.join("; ") };
  return {
    id,
    status: "pass",
    detail: audio.map((t) => `${t.dir} ${kbps(t.bitrate)}`).join(", "),
  };
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

function topLayerCheck(tracks: readonly TrackRecord[]): CheckResult {
  const id = "top_layer";
  const shares = tracks.filter(
    (t) => t.dir === "recv" && t.source === "screen_share" && !t.muted,
  );
  if (shares.length === 0)
    return { id, status: "na", detail: "no screen share received" };
  const problems: string[] = [];
  const fine: string[] = [];
  for (const share of shares) {
    const top = topPublishedLayer(share);
    if (share.height === undefined || share.width === undefined)
      problems.push(`${share.participant}: no frames`);
    else if (top !== undefined && share.height < top.height * 0.9)
      problems.push(
        `${share.participant}: ${share.width}x${share.height} of ${top.width}x${top.height}`,
      );
    else fine.push(`${share.width}x${share.height}`);
  }
  return problems.length > 0
    ? { id, status: "fail", detail: problems.join("; ") }
    : { id, status: "pass", detail: fine.join(", ") };
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
