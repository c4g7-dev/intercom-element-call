/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type MediaSource,
  type TrackDiagnostics,
} from "@element-hq/matrixrtc-sdk";

export type DiagSource =
  | "microphone"
  | "camera"
  | "screen_share"
  | "screen_share_audio"
  | "unknown";

export const diagSources: Record<MediaSource, DiagSource> = {
  microphone: "microphone",
  camera: "camera",
  screenShare: "screen_share",
  screenShareAudio: "screen_share_audio",
  unknown: "unknown",
};

export interface TrackIdentity {
  /** `userId:deviceId` of the member the track belongs to. */
  participant: string;
  local: boolean;
  source: MediaSource;
  kind: "audio" | "video";
  sid: string;
  muted: boolean;
}

/** One simulcast layer as it is sent. */
export interface LayerRecord {
  rid?: string;
  active?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  targetBitrate?: number;
  limitation?: string;
  impl?: string;
}

/** One track at one moment: a line of the diagnostics log. */
export interface TrackRecord {
  dir: "send" | "recv";
  participant: string;
  source: DiagSource;
  kind: "audio" | "video";
  sid: string;
  muted: boolean;
  codec?: string;
  /** The encoder's or decoder's own name. */
  impl?: string;
  powerEfficient?: boolean;
  /** Whether hardware does the coding; null where nothing says. */
  hw: boolean | null;
  /** The frames as sent (the largest layer) or as received. */
  width?: number;
  height?: number;
  fps?: number;
  /** Bits per second over the interval since the last reading, all layers. */
  bitrate?: number;
  targetBitrate?: number;
  limitation?: string;
  limitationDurations?: Record<string, number>;
  limitationResolutionChanges?: number;
  scalabilityMode?: string;
  contentHint?: string;
  degradationPreference?: string;
  layers?: LayerRecord[];
  encodings?: NonNullable<TrackDiagnostics["sender"]>["encodings"];
  /** What is captured, before any scaling. */
  capture?: { width?: number; height?: number; fps?: number };
  upstreamPaused?: boolean;
  /** Packets lost over the interval, in percent. */
  lossPct?: number;
  packetsLost?: number;
  jitterMs?: number;
  rttMs?: number;
  availableOutgoingBitrate?: number;
  freezeCount?: number;
  freezeDurationS?: number;
  nack?: number;
  pli?: number;
  fir?: number;
  framesDropped?: number;
  keyFrames?: number;
  audioLevel?: number;
  /** The running total, which only grows while there is sound. */
  audioEnergy?: number;
  /** How much of it was added over the interval: above 0 means sound. */
  audioEnergyDelta?: number;
  concealedPct?: number;
  concealmentEvents?: number;
  /** What the publisher announced. */
  published?: TrackDiagnostics["published"];
  requestedQuality?: number;
  streamState?: string;
  subscribed?: boolean;
  trackState?: string;
}

/** The running totals a rate is taken from at the next reading. */
export interface TrackCounters {
  t: number;
  bytes?: number;
  layerBytes: Record<string, number>;
  packetsLost?: number;
  packetsReceived?: number;
  audioEnergy?: number;
  concealedSamples?: number;
  samplesReceived?: number;
}

type Stats = Record<string, unknown>;

const HARDWARE_CODER =
  /vaapi|v4l2|nvenc|nvdec|d3d11|dxva|mediafoundation|videotoolbox|external(en|de)coder|mediacodec|vda\b|hardware/i;
const SOFTWARE_CODER =
  /libvpx|libaom|openh264|ffmpeg|dav1d|svt|rav1e|libopus|opus|fallback from/i;

/**
 * Whether a coder runs on hardware: by what it says of itself where it does,
 * by its name otherwise.
 */
export function isHardwareCoder(
  impl: string | undefined,
  powerEfficient: boolean | undefined,
): boolean | null {
  if (powerEfficient === true) return true;
  if (impl === undefined || impl === "" || impl === "unknown")
    return powerEfficient === false ? false : null;
  if (HARDWARE_CODER.test(impl) && !/fallback from/i.test(impl)) return true;
  if (SOFTWARE_CODER.test(impl) || powerEfficient === false) return false;
  return null;
}

/**
 * One reading of a track as a record, with the totals the next reading's
 * rates are taken from.
 */
export function toTrackRecord(
  identity: TrackIdentity,
  diagnostics: TrackDiagnostics,
  now: number,
  previous?: TrackCounters,
): { record: TrackRecord; counters: TrackCounters } {
  const base: TrackRecord = {
    dir: identity.local ? "send" : "recv",
    participant: identity.participant,
    source: diagSources[identity.source],
    kind: identity.kind,
    sid: identity.sid,
    muted: identity.muted,
    hw: null,
    trackState: diagnostics.track?.readyState,
  };
  const counters: TrackCounters = { t: now, layerBytes: {} };
  const seconds =
    previous !== undefined && now > previous.t
      ? (now - previous.t) / 1000
      : undefined;
  const record = identity.local
    ? sendRecord(base, diagnostics, counters, previous, seconds)
    : receiveRecord(base, diagnostics, counters, previous, seconds);
  return { record: dropUndefined(record), counters };
}

function sendRecord(
  record: TrackRecord,
  { stats, track, sender, published }: TrackDiagnostics,
  counters: TrackCounters,
  previous: TrackCounters | undefined,
  seconds: number | undefined,
): TrackRecord {
  const outbound = stats.filter(
    (s) => s.type === "outbound-rtp" && (s.kind ?? record.kind) === record.kind,
  );
  const layers = outbound.map((s): LayerRecord => {
    const key = str(s.rid) ?? String(num(s.ssrc) ?? "");
    const bytes = num(s.bytesSent);
    if (bytes !== undefined) counters.layerBytes[key] = bytes;
    return {
      rid: str(s.rid),
      active: bool(s.active),
      width: num(s.frameWidth),
      height: num(s.frameHeight),
      fps: num(s.framesPerSecond),
      bitrate: rate(bytes, previous?.layerBytes[key], seconds),
      targetBitrate: num(s.targetBitrate),
      limitation: str(s.qualityLimitationReason),
      impl: str(s.encoderImplementation),
    };
  });
  // The layer the viewers of the full picture get
  const top = pickTop(outbound);
  const totalBytes = sum(outbound.map((s) => num(s.bytesSent)));
  counters.bytes = totalBytes;
  const remote = stats.filter((s) => s.type === "remote-inbound-rtp");
  const remoteOfTop =
    remote.find((s) => top !== undefined && s.localId === top.id) ?? remote[0];
  const source = stats.find(
    (s) => s.type === "media-source" && (s.kind ?? record.kind) === record.kind,
  );
  const pair = selectedPair(stats);
  const energy = num(source?.totalAudioEnergy);
  counters.audioEnergy = energy;
  const impl = str(top?.encoderImplementation);
  const powerEfficient = bool(top?.powerEfficientEncoder);

  return {
    ...record,
    codec: codecOf(stats, top),
    impl,
    powerEfficient,
    hw: record.kind === "video" ? isHardwareCoder(impl, powerEfficient) : null,
    width: num(top?.frameWidth),
    height: num(top?.frameHeight),
    fps: num(top?.framesPerSecond),
    bitrate: rate(totalBytes, previous?.bytes, seconds),
    targetBitrate: sum(outbound.map((s) => num(s.targetBitrate))),
    limitation: worstLimitation(outbound),
    limitationDurations: durations(top?.qualityLimitationDurations),
    limitationResolutionChanges: num(top?.qualityLimitationResolutionChanges),
    scalabilityMode:
      str(top?.scalabilityMode) ??
      sender?.encodings.find((e) => e.scalabilityMode)?.scalabilityMode,
    contentHint: record.kind === "video" ? track?.contentHint : undefined,
    degradationPreference: sender?.degradationPreference,
    layers:
      layers.length > 1
        ? layers.map((layer) => dropUndefined(layer))
        : undefined,
    encodings: sender?.encodings.map((e) => dropUndefined(e)),
    capture:
      record.kind === "video"
        ? nonEmpty({
            width: track?.width ?? num(source?.width),
            height: track?.height ?? num(source?.height),
            fps: num(source?.framesPerSecond) ?? track?.frameRate,
          })
        : undefined,
    upstreamPaused: sender?.upstreamPaused,
    lossPct: percent(num(remoteOfTop?.fractionLost)),
    packetsLost: num(remoteOfTop?.packetsLost),
    jitterMs: millis(num(remoteOfTop?.jitter)),
    rttMs:
      millis(num(remoteOfTop?.roundTripTime)) ??
      millis(num(pair?.currentRoundTripTime)),
    availableOutgoingBitrate: num(pair?.availableOutgoingBitrate),
    nack: sum(outbound.map((s) => num(s.nackCount))),
    pli: sum(outbound.map((s) => num(s.pliCount))),
    fir: sum(outbound.map((s) => num(s.firCount))),
    keyFrames: sum(outbound.map((s) => num(s.keyFramesEncoded))),
    audioLevel: round(num(source?.audioLevel), 4),
    audioEnergy: round(energy, 6),
    audioEnergyDelta: delta(energy, previous?.audioEnergy),
    published: record.kind === "video" ? published : undefined,
  };
}

function receiveRecord(
  record: TrackRecord,
  { stats, track, published, subscription }: TrackDiagnostics,
  counters: TrackCounters,
  previous: TrackCounters | undefined,
  seconds: number | undefined,
): TrackRecord {
  const inbound = stats.find(
    (s) => s.type === "inbound-rtp" && (s.kind ?? record.kind) === record.kind,
  );
  const pair = selectedPair(stats);
  const bytes = num(inbound?.bytesReceived);
  const lost = num(inbound?.packetsLost);
  const received = num(inbound?.packetsReceived);
  const energy = num(inbound?.totalAudioEnergy);
  const concealed = num(inbound?.concealedSamples);
  const samples = num(inbound?.totalSamplesReceived);
  Object.assign(counters, {
    bytes,
    packetsLost: lost,
    packetsReceived: received,
    audioEnergy: energy,
    concealedSamples: concealed,
    samplesReceived: samples,
  });
  const impl = str(inbound?.decoderImplementation);
  const powerEfficient = bool(inbound?.powerEfficientDecoder);

  return {
    ...record,
    codec: codecOf(stats, inbound),
    impl,
    powerEfficient,
    hw: record.kind === "video" ? isHardwareCoder(impl, powerEfficient) : null,
    width: num(inbound?.frameWidth),
    height: num(inbound?.frameHeight),
    fps: num(inbound?.framesPerSecond),
    bitrate: rate(bytes, previous?.bytes, seconds),
    lossPct: share(
      delta(lost, previous?.packetsLost),
      delta(received, previous?.packetsReceived),
    ),
    packetsLost: lost,
    jitterMs: millis(num(inbound?.jitter)),
    rttMs: millis(num(pair?.currentRoundTripTime)),
    freezeCount: num(inbound?.freezeCount),
    freezeDurationS: round(num(inbound?.totalFreezesDuration), 3),
    nack: num(inbound?.nackCount),
    pli: num(inbound?.pliCount),
    fir: num(inbound?.firCount),
    framesDropped: num(inbound?.framesDropped),
    keyFrames: num(inbound?.keyFramesDecoded),
    audioLevel: round(num(inbound?.audioLevel), 4),
    audioEnergy: round(energy, 6),
    audioEnergyDelta: delta(energy, previous?.audioEnergy),
    concealedPct: share(
      delta(concealed, previous?.concealedSamples),
      nonConcealed(
        delta(samples, previous?.samplesReceived),
        delta(concealed, previous?.concealedSamples),
      ),
    ),
    concealmentEvents: num(inbound?.concealmentEvents),
    contentHint: undefined,
    published: record.kind === "video" ? published : undefined,
    requestedQuality:
      record.kind === "video" ? subscription?.requestedQuality : undefined,
    streamState: subscription?.streamState,
    subscribed: subscription?.subscribed,
    trackState: track?.readyState,
  };
}

function pickTop(outbound: Stats[]): Stats | undefined {
  let top: Stats | undefined;
  let topArea = -1;
  for (const s of outbound) {
    const area = (num(s.frameWidth) ?? 0) * (num(s.frameHeight) ?? 0);
    if (area > topArea) {
      top = s;
      topArea = area;
    }
  }
  return top;
}

const LIMITATION_ORDER = ["none", "other", "bandwidth", "cpu"];

function worstLimitation(outbound: Stats[]): string | undefined {
  let worst: string | undefined;
  for (const s of outbound) {
    const reason = str(s.qualityLimitationReason);
    if (reason === undefined) continue;
    if (
      worst === undefined ||
      LIMITATION_ORDER.indexOf(reason) > LIMITATION_ORDER.indexOf(worst)
    )
      worst = reason;
  }
  return worst;
}

function codecOf(stats: Stats[], rtp: Stats | undefined): string | undefined {
  if (rtp?.codecId === undefined) return undefined;
  const codec = stats.find((s) => s.type === "codec" && s.id === rtp.codecId);
  return str(codec?.mimeType)?.replace(/^(audio|video)\//i, "");
}

function selectedPair(stats: Stats[]): Stats | undefined {
  const transport = stats.find((s) => s.type === "transport");
  const pairs = stats.filter((s) => s.type === "candidate-pair");
  return (
    pairs.find((s) => s.id === transport?.selectedCandidatePairId) ??
    pairs.find((s) => s.nominated === true && s.state === "succeeded") ??
    pairs[0]
  );
}

function durations(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, number> = {};
  for (const [reason, seconds] of Object.entries(value))
    if (typeof seconds === "number") out[reason] = round(seconds, 1) as number;
  return out;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sum(values: (number | undefined)[]): number | undefined {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length === 0 ? undefined : known.reduce((a, b) => a + b, 0);
}

/** A counter that went backwards was reset: there is no rate to take from it. */
function delta(
  current: number | undefined,
  previous: number | undefined,
): number | undefined {
  if (current === undefined || previous === undefined || current < previous)
    return undefined;
  return round(current - previous, 6);
}

function rate(
  bytes: number | undefined,
  previousBytes: number | undefined,
  seconds: number | undefined,
): number | undefined {
  const d = delta(bytes, previousBytes);
  if (d === undefined || seconds === undefined) return undefined;
  return Math.round((d * 8) / seconds);
}

function share(
  part: number | undefined,
  rest: number | undefined,
): number | undefined {
  if (part === undefined || rest === undefined) return undefined;
  const total = part + rest;
  return total <= 0 ? 0 : round((part / total) * 100, 2);
}

function nonConcealed(
  samples: number | undefined,
  concealed: number | undefined,
): number | undefined {
  if (samples === undefined || concealed === undefined) return undefined;
  return Math.max(0, samples - concealed);
}

function percent(fraction: number | undefined): number | undefined {
  return fraction === undefined ? undefined : round(fraction * 100, 2);
}

function millis(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : round(seconds * 1000, 1);
}

function round(value: number | undefined, digits: number): number | undefined {
  if (value === undefined) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nonEmpty<T extends object>(value: T): T | undefined {
  const known = dropUndefined(value);
  return Object.keys(known).length === 0 ? undefined : known;
}

function dropUndefined<T extends object>(value: T): T {
  const out = {} as Record<string, unknown>;
  for (const [key, item] of Object.entries(value))
    if (item !== undefined) out[key] = item;
  return out as T;
}
