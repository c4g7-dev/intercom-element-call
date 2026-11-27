/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type TrackDiagnostics } from "@element-hq/matrixrtc-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  CONN_STATS_MIN_INTERVAL_MS,
  connLink,
  connQuality,
  createConnReporter,
  mediaServerName,
  serverHostName,
  summarizeConnection,
} from "./connStats";
import {
  toTrackRecord,
  type TrackCounters,
  type TrackIdentity,
  type TrackRecord,
} from "./trackStats";

describe("connQuality", () => {
  it("is good under 120 ms and 2 % loss, fair under 250 ms and 6 %, poor beyond", () => {
    expect(connQuality(20, 0)).toBe("good");
    expect(connQuality(119, 1.9)).toBe("good");
    expect(connQuality(120, 0)).toBe("fair");
    expect(connQuality(20, 2)).toBe("fair");
    expect(connQuality(249, 5.9)).toBe("fair");
    expect(connQuality(250, 0)).toBe("poor");
    expect(connQuality(20, 6)).toBe("poor");
    expect(connQuality(900, 40)).toBe("poor");
  });

  it("takes what is not measured for fine", () => {
    expect(connQuality(undefined, undefined)).toBe("good");
    expect(connQuality(undefined, 3)).toBe("fair");
    expect(connQuality(300, undefined)).toBe("poor");
  });
});

/** The transport, pair and candidates of a report, as a browser gives them. */
function pairStats(
  local: Record<string, unknown>,
  remote: Record<string, unknown> = {},
  rtt = 0.031,
): Record<string, unknown>[] {
  return [
    { type: "transport", id: "T", selectedCandidatePairId: "CP2" },
    {
      type: "candidate-pair",
      id: "CP1",
      localCandidateId: "Lx",
      remoteCandidateId: "Rx",
      currentRoundTripTime: 0.9,
    },
    {
      type: "candidate-pair",
      id: "CP2",
      localCandidateId: "L",
      remoteCandidateId: "R",
      currentRoundTripTime: rtt,
    },
    {
      type: "local-candidate",
      id: "Lx",
      candidateType: "relay",
      protocol: "udp",
    },
    {
      type: "local-candidate",
      id: "L",
      candidateType: "srflx",
      protocol: "udp",
      address: "203.0.113.7",
      port: 50000,
      ...local,
    },
    {
      type: "remote-candidate",
      id: "R",
      candidateType: "host",
      protocol: "udp",
      address: "198.51.100.2",
      port: 7882,
      ...remote,
    },
  ];
}

describe("connLink", () => {
  it("reads the transport and the round trip of the pair in use", () => {
    expect(connLink(pairStats({}))).toEqual({ transport: "udp", rttMs: 31 });
    expect(
      connLink(pairStats({ protocol: "tcp" }, { protocol: "tcp" })),
    ).toEqual({ transport: "tcp", rttMs: 31 });
  });

  it("says a relay, and how it is reached", () => {
    const relay = { candidateType: "relay" };
    expect(
      connLink(pairStats({ ...relay, relayProtocol: "udp" })).transport,
    ).toBe("turn-udp");
    expect(
      connLink(pairStats({ ...relay, relayProtocol: "tcp" })).transport,
    ).toBe("turn-tcp");
    expect(
      connLink(pairStats({ ...relay, relayProtocol: "tls" })).transport,
    ).toBe("turn-tls");
    // A relay on the far side, with nothing said about how
    expect(connLink(pairStats({}, relay)).transport).toBe("turn-udp");
  });

  it("carries no address of a candidate", () => {
    expect(JSON.stringify(connLink(pairStats({})))).not.toMatch(
      /203\.0|198\.51|50000|7882/,
    );
  });

  it("is empty for a report without a pair", () => {
    expect(connLink([])).toEqual({});
    expect(connLink([{ type: "outbound-rtp" }])).toEqual({});
  });
});

describe("serverHostName", () => {
  it("keeps the host and drops everything else", () => {
    expect(
      serverHostName(
        "wss://user:pw@sfu.example.org:7880/rtc/room?access_token=secret#x",
      ),
    ).toBe("sfu.example.org");
    expect(serverHostName("https://lk-jwt.example.org/sfu/get")).toBe(
      "lk-jwt.example.org",
    );
  });

  it("is nothing for what is no URL", () => {
    for (const value of ["", "sfu", "/rtc?token=x", undefined, null, 5, {}])
      expect(serverHostName(value)).toBeUndefined();
  });
});

describe("mediaServerName", () => {
  it("is the server the media goes to, and the service before that is known", () => {
    const raw = {
      type: "livekit",
      livekit_service_url: "https://jwt.example.org/path",
    };
    expect(
      mediaServerName({
        raw,
        resolved$: {
          value: { url: "wss://sfu.example.org/rtc", token: "secret" },
        },
      }),
    ).toBe("sfu.example.org");
    expect(mediaServerName({ raw, resolved$: { value: undefined } })).toBe(
      "jwt.example.org",
    );
    expect(mediaServerName(undefined)).toBeUndefined();
  });
});

const me = "@me:example.org:DEV";
const identity = (
  source: TrackIdentity["source"],
  local: boolean,
  muted = false,
): TrackIdentity => ({
  participant: local ? me : "@them:example.org:OTHER",
  local,
  source,
  kind: source === "screenShare" ? "video" : "audio",
  sid: `${source}-${local}`,
  muted,
});

/** A microphone as it is sent: `n` seconds into the call. */
const micSent = (n: number, fractionLost = 0.01): TrackDiagnostics => ({
  stats: [
    {
      type: "outbound-rtp",
      id: "O",
      kind: "audio",
      codecId: "C",
      // 4000 bytes a second: 32 kbit/s
      bytesSent: n * 4000,
    },
    { type: "codec", id: "C", mimeType: "audio/opus" },
    {
      type: "remote-inbound-rtp",
      localId: "O",
      fractionLost,
      jitter: 0.004,
      roundTripTime: 0.05,
    },
    ...pairStats({}),
  ],
});

const shareSent = (n: number): TrackDiagnostics => ({
  stats: [
    {
      type: "outbound-rtp",
      id: "V",
      kind: "video",
      codecId: "C",
      frameWidth: 2560,
      frameHeight: 1440,
      framesPerSecond: 29.97,
      // 400 kbyte a second: 3.2 Mbit/s
      bytesSent: n * 400_000,
    },
    { type: "codec", id: "C", mimeType: "video/AV1" },
    { type: "remote-inbound-rtp", localId: "V", fractionLost: 0.03 },
  ],
});

/** Somebody's microphone as it is received: 50 packets a second, `lost` of them lost. */
const micReceived = (n: number, lost: number): TrackDiagnostics => ({
  stats: [
    {
      type: "inbound-rtp",
      kind: "audio",
      bytesReceived: n * 5000,
      packetsReceived: n * (50 - lost),
      packetsLost: n * lost,
      jitter: 0.012,
    },
  ],
});

/** Two readings a second apart, as the diagnostics take them. */
function records(
  tracks: [TrackIdentity, (n: number) => TrackDiagnostics][],
): TrackRecord[] {
  return tracks.map(([id, at]) => {
    const first: { counters: TrackCounters } = toTrackRecord(id, at(1), 1000);
    return toTrackRecord(id, at(2), 2000, first.counters).record;
  });
}

describe("summarizeConnection", () => {
  it("maps the reports of a call to the summary", () => {
    const link = connLink(micSent(2).stats);
    const summary = summarizeConnection({
      tracks: records([
        [identity("microphone", true), micSent],
        [identity("screenShare", true), shareSent],
        [identity("microphone", false), (n) => micReceived(n, 5)],
      ]),
      link,
    });
    expect(summary).toEqual({
      // The pair's own, not the microphone's 50 ms
      rttMs: 31,
      // 1 % of 32 kbit/s and 3 % of 3.2 Mbit/s, by what each carries
      lossOutPct: expect.closeTo(2.98, 2),
      // 5 of 50 packets a second
      lossInPct: 10,
      // What is heard
      jitterMs: 12,
      transport: "udp",
      audio: { codec: "opus", bitrate: 32_000 },
      share: { width: 2560, height: 1440, fps: 29.97, bitrate: 3_200_000 },
    });
  });

  it("has no share while there is none, and no loss from a muted microphone", () => {
    const summary = summarizeConnection({
      tracks: records([
        [identity("microphone", true, true), (n) => micSent(n, 0.4)],
      ]),
    });
    expect(summary).toEqual({
      rttMs: 50,
      audio: { codec: "opus", bitrate: 0 },
    });
  });

  it("is empty for a call that has nothing to read", () => {
    expect(summarizeConnection({ tracks: [] })).toEqual({});
  });
});

describe("createConnReporter", () => {
  const context = {
    detailed: false,
    encrypted: true,
    server: "sfu.example.org",
  };

  it("tells the quality with rounded figures, and little while nothing changes", () => {
    const record = vi.fn();
    const report = createConnReporter(record);
    expect(
      report({ rttMs: 33, lossOutPct: 0.2 }, { ...context, now: 0 }),
    ).toEqual({
      quality: "good",
      rtt_ms: 30,
      loss_pct: 0,
    });
    // The same after rounding: nothing
    expect(report({ rttMs: 31 }, { ...context, now: 2000 })).toBeUndefined();
    // Other figures, but too soon
    expect(report({ rttMs: 80 }, { ...context, now: 3000 })).toBeUndefined();
    expect(
      report({ rttMs: 80 }, { ...context, now: CONN_STATS_MIN_INTERVAL_MS }),
    ).toMatchObject({ quality: "good", rtt_ms: 60 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("conn_quality", {
      level: "good",
      rttMs: 33,
      lossPct: 0.2,
    });
  });

  it("tells a change of the quality at once, and records it", () => {
    const record = vi.fn();
    const report = createConnReporter(record);
    report({ rttMs: 30, lossInPct: 0 }, { ...context, now: 0 });
    expect(
      report({ rttMs: 30, lossInPct: 30 }, { ...context, now: 1000 }),
    ).toEqual({ quality: "poor", rtt_ms: 30, loss_pct: 15 });
    expect(record).toHaveBeenLastCalledWith("conn_quality", {
      level: "poor",
      from: "good",
      rttMs: 30,
      lossPct: 15,
    });
  });

  it("does not let one bad reading flip the quality", () => {
    const report = createConnReporter(vi.fn());
    report({ rttMs: 30, lossInPct: 0 }, { ...context, now: 0 });
    report({ rttMs: 30, lossInPct: 0 }, { ...context, now: 2000 });
    // 3 % once, among readings of none: 1 % over the window
    expect(
      report({ rttMs: 30, lossInPct: 3 }, { ...context, now: 4000 }),
    ).toMatchObject({ quality: "good", loss_pct: 1 });
  });

  it("tells every reading in full while the host shows the details", () => {
    const report = createConnReporter(vi.fn());
    const summary = {
      rttMs: 41.4,
      lossOutPct: 0.26,
      lossInPct: 1.04,
      jitterMs: 7.6,
      transport: "turn-tls" as const,
      audio: { codec: "opus", bitrate: 32_000 },
      share: { width: 1920, height: 1080, fps: 29.97, bitrate: 2_500_000 },
    };
    const detailed = { ...context, detailed: true };
    const first = report(summary, { ...detailed, now: 0 });
    expect(first).toEqual({
      quality: "good",
      rtt_ms: 41,
      loss_pct: 1,
      detail: {
        loss_out_pct: 0.3,
        loss_in_pct: 1,
        jitter_ms: 8,
        server: "sfu.example.org",
        transport: "turn-tls",
        encrypted: true,
        audio: { codec: "opus", bitrate: 32_000 },
        share: { width: 1920, height: 1080, fps: 30, bitrate: 2_500_000 },
      },
    });
    // The same again a second later: told all the same, the host draws a graph of it
    expect(report(summary, { ...detailed, now: 1000 })).toEqual(first);
  });

  it("tells nothing while nothing is measured", () => {
    const record = vi.fn();
    const report = createConnReporter(record);
    expect(report({}, { ...context, now: 0 })).toBeUndefined();
    expect(
      report(
        { audio: { codec: "opus" } },
        { ...context, detailed: true, now: 1 },
      ),
    ).toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });
});
