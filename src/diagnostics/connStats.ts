/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { diag } from "./diag";
import { selectedPair, type TrackRecord } from "./trackStats";

/** How good the connection to the call is, as the host draws it: three, two or one bar. */
export type ConnQuality = "good" | "fair" | "poor";

/**
 * Where good ends and where fair ends: round-trip time in milliseconds and
 * packets lost in percent. Both must be under the limit.
 */
export const CONN_QUALITY_LIMITS = {
  good: { rttMs: 120, lossPct: 2 },
  fair: { rttMs: 250, lossPct: 6 },
} as const;

/**
 * The quality of a connection from its round-trip time and its packet loss.
 * What is not known counts as fine: a call with nobody else in it has no loss
 * to measure.
 */
export function connQuality(
  rttMs: number | undefined,
  lossPct: number | undefined,
): ConnQuality {
  const rtt = rttMs ?? 0;
  const loss = lossPct ?? 0;
  const { good, fair } = CONN_QUALITY_LIMITS;
  if (rtt < good.rttMs && loss < good.lossPct) return "good";
  if (rtt < fair.rttMs && loss < fair.lossPct) return "fair";
  return "poor";
}

/** How the media gets to the server: straight, or by way of a TURN relay. */
export type ConnTransport =
  | "udp"
  | "tcp"
  | "turn-udp"
  | "turn-tcp"
  | "turn-tls";

/** What the selected candidate pair of a peer connection says. */
export interface ConnLink {
  transport?: ConnTransport;
  /** The round-trip time of the pair's last connectivity check. */
  rttMs?: number;
}

type Stats = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value.toLowerCase() : undefined;

/**
 * The transport and the round-trip time of the candidate pair in use, from
 * the entries of a statistics report. Nothing of the candidates themselves
 * (addresses, ports) leaves this function.
 */
export function connLink(stats: Stats[]): ConnLink {
  const pair = selectedPair(stats);
  if (pair === undefined) return {};
  const candidate = (id: unknown): Stats | undefined =>
    stats.find(
      (s) =>
        (s.type === "local-candidate" || s.type === "remote-candidate") &&
        s.id === id,
    );
  const local = candidate(pair.localCandidateId);
  const remote = candidate(pair.remoteCandidateId);
  const protocol = text(local?.protocol) ?? text(remote?.protocol);
  const relayed =
    text(local?.candidateType) === "relay" ||
    text(remote?.candidateType) === "relay";
  let transport: ConnTransport | undefined;
  if (relayed) {
    // How the relay is reached, which is what a firewall decides
    const relay = text(local?.relayProtocol) ?? protocol;
    transport =
      relay === "tls" ? "turn-tls" : relay === "tcp" ? "turn-tcp" : "turn-udp";
  } else if (protocol === "udp" || protocol === "tcp") transport = protocol;
  const rtt = pair.currentRoundTripTime;
  return {
    ...(transport && { transport }),
    ...(typeof rtt === "number" &&
      Number.isFinite(rtt) && { rttMs: Math.round(rtt * 10000) / 10 }),
  };
}

/** The name of the host of a URL, and nothing else of it; undefined if it is none. */
export function serverHostName(url: unknown): string | undefined {
  if (typeof url !== "string" || url === "") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The media server of a member's transport, by name: the server the media
 * goes to once that is known, the service that hands out its address before.
 */
export function mediaServerName(
  transport: { raw?: unknown; resolved$?: { value: unknown } } | undefined,
): string | undefined {
  const raw = transport?.raw as
    | { url?: unknown; livekit_service_url?: unknown }
    | undefined;
  const resolved = transport?.resolved$?.value as { url?: unknown } | undefined;
  return (
    serverHostName(resolved?.url) ??
    serverHostName(raw?.url) ??
    serverHostName(raw?.livekit_service_url)
  );
}

/** One reading of the connection, from the tracks' records. */
export interface ConnSummary {
  rttMs?: number;
  /** Of what we send, lost on the way to the server, in percent. */
  lossOutPct?: number;
  /** Of what we are sent, lost on the way here, in percent. */
  lossInPct?: number;
  jitterMs?: number;
  transport?: ConnTransport;
  audio?: { codec?: string; bitrate?: number };
  share?: { width?: number; height?: number; fps?: number; bitrate?: number };
}

const known = (value: number | undefined): value is number =>
  value !== undefined;

const flows = (track: TrackRecord): boolean =>
  !track.muted && (track.bitrate ?? 0) > 0;

/** The mean of the tracks' values, each counted by how much it carries. */
function weighted(
  tracks: TrackRecord[],
  value: (track: TrackRecord) => number | undefined,
): number | undefined {
  let sum = 0;
  let weight = 0;
  for (const track of tracks) {
    const v = value(track);
    if (v === undefined) continue;
    sum += v * (track.bitrate ?? 0);
    weight += track.bitrate ?? 0;
  }
  return weight > 0 ? sum / weight : undefined;
}

/**
 * The connection as one reading of the call shows it. Loss is only taken
 * from tracks that carry something: a muted track's last report stays as it
 * was and says nothing about now.
 */
export function summarizeConnection({
  tracks,
  link,
}: {
  tracks: TrackRecord[];
  link?: ConnLink;
}): ConnSummary {
  const sent = tracks.filter((track) => track.dir === "send");
  const received = tracks.filter((track) => track.dir === "recv");
  const microphone = sent.find((track) => track.source === "microphone");
  const share = sent.find((track) => track.source === "screen_share");
  const heard = received.filter((track) => track.kind === "audio");
  const jitters = (heard.some(flows) ? heard.filter(flows) : sent.filter(flows))
    .map((track) => track.jitterMs)
    .filter(known);
  return dropUndefined({
    rttMs:
      link?.rttMs ??
      microphone?.rttMs ??
      [...sent, ...received].map((track) => track.rttMs).find(known),
    lossOutPct: weighted(sent.filter(flows), (track) => track.lossPct),
    lossInPct: weighted(received.filter(flows), (track) => track.lossPct),
    jitterMs: jitters.length > 0 ? Math.max(...jitters) : undefined,
    transport: link?.transport,
    audio:
      microphone &&
      dropUndefined({
        codec: microphone.codec,
        bitrate: microphone.muted ? 0 : microphone.bitrate,
      }),
    share:
      share &&
      dropUndefined({
        width: share.width,
        height: share.height,
        fps: share.fps,
        bitrate: share.bitrate,
      }),
  });
}

// Type aliases rather than interfaces, so that they satisfy the widget API's
// index-signature payload types.

/** The details of the connection, which the host asks for while it shows them. */
export type HostConnDetail = {
  loss_out_pct?: number;
  loss_in_pct?: number;
  jitter_ms?: number;
  /** The media server's host name: no path, no port, no query */
  server?: string;
  transport?: ConnTransport;
  /** Whether the media is end-to-end encrypted */
  encrypted: boolean;
  /** The microphone as it is sent; bits per second */
  audio?: { codec?: string; bitrate?: number };
  /** The screen share as it is sent, while there is one */
  share?: { width?: number; height?: number; fps?: number; bitrate?: number };
};

/**
 * What the host is told about the connection. Numbers and names only: no
 * identifiers, no addresses, no tokens.
 */
export type HostConnStats = {
  quality: ConnQuality;
  /** Round-trip time to the media server, milliseconds */
  rtt_ms?: number;
  /** Packets lost, percent: the worse of the two directions */
  loss_pct?: number;
  detail?: HostConnDetail;
};

/** Over how long the quality is taken, so that one bad reading does not flip it. */
export const CONN_QUALITY_WINDOW_MS = 6000;
/** How often at most the host is told while it does not ask for details. */
export const CONN_STATS_MIN_INTERVAL_MS = 4000;

const round = (value: number | undefined, to: number): number | undefined =>
  value === undefined ? undefined : Math.round(value / to) * to;
const tenth = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.round(value * 10) / 10;
const mean = (values: number[]): number | undefined =>
  values.length === 0
    ? undefined
    : values.reduce((a, b) => a + b, 0) / values.length;

export interface ConnReportContext {
  now: number;
  /** Whether the host shows the details right now */
  detailed: boolean;
  server?: string;
  encrypted: boolean;
}

/**
 * Decides what the host is told of each reading, and records the quality
 * when it changes. While the host shows no details: the quality with rounded
 * figures, when they change and not more often than every
 * {@link CONN_STATS_MIN_INTERVAL_MS} (a change of the quality at once). While
 * it shows them: every reading, in full.
 * @returns a function that takes a reading and gives the message, if one is due
 */
export function createConnReporter(
  record: typeof diag = diag,
): (
  summary: ConnSummary,
  context: ConnReportContext,
) => HostConnStats | undefined {
  let recent: { t: number; rttMs?: number; lossPct?: number }[] = [];
  let quality: ConnQuality | undefined;
  let lastSent: { at: number; json: string } | undefined;

  return (summary, { now, detailed, server, encrypted }) => {
    const losses = [summary.lossOutPct, summary.lossInPct].filter(known);
    const lossPct = losses.length > 0 ? Math.max(...losses) : undefined;
    // Nothing measured yet: the host keeps showing what it knows without us
    if (summary.rttMs === undefined && lossPct === undefined) return undefined;

    recent = recent.filter(({ t }) => now - t < CONN_QUALITY_WINDOW_MS);
    recent.push({ t: now, rttMs: summary.rttMs, lossPct });
    const rttMs = mean(recent.map((r) => r.rttMs).filter(known));
    const smoothedLoss = mean(recent.map((r) => r.lossPct).filter(known));
    const next = connQuality(rttMs, smoothedLoss);
    const changed = next !== quality;
    if (changed) {
      record("conn_quality", {
        level: next,
        ...(quality && { from: quality }),
        rttMs: round(rttMs, 1),
        lossPct: tenth(smoothedLoss),
      });
      quality = next;
    }

    const stats: HostConnStats = detailed
      ? dropUndefined({
          quality: next,
          rtt_ms: round(summary.rttMs, 1),
          loss_pct: tenth(lossPct),
          detail: dropUndefined({
            loss_out_pct: tenth(summary.lossOutPct),
            loss_in_pct: tenth(summary.lossInPct),
            jitter_ms: round(summary.jitterMs, 1),
            server,
            transport: summary.transport,
            encrypted,
            audio: summary.audio,
            share: summary.share && {
              ...summary.share,
              fps: round(summary.share.fps, 1),
            },
          }),
        })
      : dropUndefined({
          quality: next,
          rtt_ms: round(rttMs, 10),
          loss_pct: round(smoothedLoss, 1),
        });
    const json = JSON.stringify(stats);
    if (
      !detailed &&
      !changed &&
      lastSent !== undefined &&
      (json === lastSent.json || now - lastSent.at < CONN_STATS_MIN_INTERVAL_MS)
    )
      return undefined;
    lastSent = { at: now, json };
    return stats;
  };
}

function dropUndefined<T extends object>(value: T): T {
  const out = {} as Record<string, unknown>;
  for (const [key, item] of Object.entries(value))
    if (item !== undefined) out[key] = item;
  return out as T;
}
