/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type TrackDiagnostics } from "@element-hq/matrixrtc-sdk";
import { describe, expect, it } from "vitest";

import {
  isHardwareCoder,
  toTrackRecord,
  type TrackIdentity,
} from "./trackStats";

describe("toTrackRecord", () => {
  it("maps a sent screen share: size, codec, coder, limitation, hint and limits", () => {
    const first = toTrackRecord(share, shareDiagnostics(1_000_000), 10_000);
    const { record } = toTrackRecord(
      share,
      shareDiagnostics(2_000_000),
      12_000,
      first.counters,
    );
    expect(record).toMatchObject({
      dir: "send",
      participant: "@me:example.org:DEV",
      source: "screen_share",
      kind: "video",
      codec: "AV1",
      impl: "libaom",
      powerEfficient: false,
      hw: false,
      width: 2560,
      height: 1440,
      fps: 30,
      // A million bytes in two seconds
      bitrate: 4_000_000,
      targetBitrate: 6_000_000,
      limitation: "bandwidth",
      limitationDurations: { none: 10, bandwidth: 2.5, cpu: 0, other: 0 },
      scalabilityMode: "L1T3",
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
      capture: { width: 5120, height: 2880, fps: 30 },
      encodings: [
        { active: true, maxBitrate: 8_000_000, scaleResolutionDownBy: 2 },
      ],
      lossPct: 1.5,
      jitterMs: 4,
      rttMs: 23,
      nack: 3,
      pli: 1,
      fir: 0,
      upstreamPaused: false,
    });
    expect(record.layers).toBeUndefined();
  });

  it("has no rate on the first reading, nor across a counter that was reset", () => {
    const first = toTrackRecord(share, shareDiagnostics(5_000_000), 10_000);
    expect(first.record.bitrate).toBeUndefined();
    const reset = toTrackRecord(
      share,
      shareDiagnostics(100),
      12_000,
      first.counters,
    );
    expect(reset.record.bitrate).toBeUndefined();
  });

  it("lists every simulcast layer and takes the size from the largest", () => {
    const { record } = toTrackRecord(
      { ...share, source: "camera" },
      {
        stats: [
          outbound({
            id: "q",
            rid: "q",
            frameWidth: 320,
            frameHeight: 180,
            qualityLimitationReason: "none",
          }),
          outbound({
            id: "f",
            rid: "f",
            frameWidth: 1280,
            frameHeight: 720,
            qualityLimitationReason: "cpu",
            encoderImplementation: "VaapiVideoEncoder",
            powerEfficientEncoder: true,
          }),
        ],
      },
      1,
    );
    expect(record.width).toBe(1280);
    expect(record.limitation).toBe("cpu");
    expect(record.hw).toBe(true);
    expect(record.layers?.map((layer) => layer.rid)).toEqual(["q", "f"]);
  });

  it("maps a sent microphone: its level and whether energy was added", () => {
    const mic: TrackIdentity = {
      ...share,
      source: "microphone",
      kind: "audio",
    };
    const reading = (energy: number, bytes: number): TrackDiagnostics => ({
      stats: [
        {
          type: "outbound-rtp",
          kind: "audio",
          id: "o",
          bytesSent: bytes,
          codecId: "c",
        },
        { type: "codec", id: "c", mimeType: "audio/opus" },
        {
          type: "media-source",
          kind: "audio",
          audioLevel: 0.25,
          totalAudioEnergy: energy,
        },
      ],
    });
    const first = toTrackRecord(mic, reading(1, 1000), 0);
    const loud = toTrackRecord(mic, reading(1.5, 9000), 2000, first.counters);
    expect(loud.record).toMatchObject({
      codec: "opus",
      hw: null,
      audioLevel: 0.25,
      audioEnergy: 1.5,
      audioEnergyDelta: 0.5,
      bitrate: 32_000,
    });
    const silent = toTrackRecord(mic, reading(1.5, 9100), 4000, loud.counters);
    expect(silent.record.audioEnergyDelta).toBe(0);
    expect(loud.record.contentHint).toBeUndefined();
  });

  it("maps a received screen share: decoder, freezes, loss over the interval, what was published", () => {
    const remote: TrackIdentity = {
      ...share,
      local: false,
      participant: "@them:example.org:OTHER",
    };
    const reading = (
      bytes: number,
      lost: number,
      received: number,
    ): TrackDiagnostics => ({
      stats: [
        {
          type: "inbound-rtp",
          kind: "video",
          codecId: "c",
          bytesReceived: bytes,
          packetsLost: lost,
          packetsReceived: received,
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 29,
          decoderImplementation: "VaapiVideoDecoder",
          powerEfficientDecoder: true,
          jitter: 0.012,
          freezeCount: 2,
          totalFreezesDuration: 1.2345,
          nackCount: 7,
          pliCount: 2,
          firCount: 0,
          framesDropped: 4,
        },
        { type: "codec", id: "c", mimeType: "video/VP9" },
        { type: "transport", selectedCandidatePairId: "p" },
        { type: "candidate-pair", id: "other", currentRoundTripTime: 9 },
        { type: "candidate-pair", id: "p", currentRoundTripTime: 0.041 },
      ],
      published: {
        simulcast: false,
        width: 1920,
        height: 1080,
        layers: [{ quality: 2, width: 1920, height: 1080, bitrate: 5_000_000 }],
      },
      subscription: {
        subscribed: true,
        enabled: true,
        requestedQuality: 2,
        streamState: "active",
      },
    });
    const first = toTrackRecord(remote, reading(0, 10, 1000), 0);
    const { record } = toTrackRecord(
      remote,
      reading(500_000, 15, 1095),
      2000,
      first.counters,
    );
    expect(record).toMatchObject({
      dir: "recv",
      participant: "@them:example.org:OTHER",
      codec: "VP9",
      impl: "VaapiVideoDecoder",
      hw: true,
      width: 1920,
      height: 1080,
      fps: 29,
      bitrate: 2_000_000,
      // 5 lost of 100 over the interval, whatever was lost before it
      lossPct: 5,
      packetsLost: 15,
      jitterMs: 12,
      rttMs: 41,
      freezeCount: 2,
      freezeDurationS: 1.235,
      nack: 7,
      pli: 2,
      framesDropped: 4,
      requestedQuality: 2,
      streamState: "active",
      subscribed: true,
    });
    expect(record.published?.layers[0].height).toBe(1080);
  });

  it("measures concealment of received audio over the interval", () => {
    const remote: TrackIdentity = {
      ...share,
      local: false,
      source: "screenShareAudio",
      kind: "audio",
    };
    const reading = (concealed: number, samples: number): TrackDiagnostics => ({
      stats: [
        {
          type: "inbound-rtp",
          kind: "audio",
          concealedSamples: concealed,
          totalSamplesReceived: samples,
          totalAudioEnergy: samples / 1e6,
          concealmentEvents: 3,
        },
      ],
    });
    const first = toTrackRecord(remote, reading(0, 0), 0);
    const { record } = toTrackRecord(
      remote,
      reading(9600, 96_000),
      2000,
      first.counters,
    );
    expect(record).toMatchObject({
      source: "screen_share_audio",
      concealedPct: 10,
      concealmentEvents: 3,
      audioEnergyDelta: 0.096,
    });
  });

  it("copes with a report that says nothing", () => {
    const { record } = toTrackRecord(share, { stats: [] }, 0);
    expect(record).toEqual({
      dir: "send",
      participant: "@me:example.org:DEV",
      source: "screen_share",
      kind: "video",
      sid: "TR_share",
      muted: false,
      hw: null,
    });
  });
});

describe("isHardwareCoder", () => {
  it.each([
    ["libvpx", undefined, false],
    ["libaom", false, false],
    ["OpenH264", undefined, false],
    ["FFmpeg", undefined, false],
    ["dav1d", undefined, false],
    ["VaapiVideoEncoder", undefined, true],
    ["ExternalDecoder (VaapiVideoDecoder)", undefined, true],
    ["MediaFoundationVideoEncodeAccelerator", undefined, true],
    ["D3D11VideoDecoder", undefined, true],
    ["libvpx (fallback from: VaapiVideoEncoder)", false, false],
    ["SomethingNew", true, true],
    ["SomethingNew", false, false],
    ["SomethingNew", undefined, null],
    [undefined, undefined, null],
    ["unknown", undefined, null],
  ])("%s, power efficient %s: %s", (impl, powerEfficient, expected) => {
    expect(isHardwareCoder(impl, powerEfficient)).toBe(expected);
  });
});

const share: TrackIdentity = {
  participant: "@me:example.org:DEV",
  local: true,
  source: "screenShare",
  kind: "video",
  sid: "TR_share",
  muted: false,
};

function outbound(more: Record<string, unknown>): Record<string, unknown> {
  return { type: "outbound-rtp", kind: "video", ...more };
}

function shareDiagnostics(bytesSent: number): TrackDiagnostics {
  return {
    stats: [
      outbound({
        id: "out",
        codecId: "codec",
        bytesSent,
        targetBitrate: 6_000_000,
        frameWidth: 2560,
        frameHeight: 1440,
        framesPerSecond: 30,
        encoderImplementation: "libaom",
        powerEfficientEncoder: false,
        qualityLimitationReason: "bandwidth",
        qualityLimitationDurations: {
          none: 10,
          bandwidth: 2.52,
          cpu: 0,
          other: 0,
        },
        scalabilityMode: "L1T3",
        nackCount: 3,
        pliCount: 1,
        firCount: 0,
      }),
      { type: "codec", id: "codec", mimeType: "video/AV1" },
      // The one for another stream is not ours
      {
        type: "remote-inbound-rtp",
        localId: "other",
        fractionLost: 0.5,
        roundTripTime: 1,
      },
      {
        type: "remote-inbound-rtp",
        localId: "out",
        fractionLost: 0.015,
        jitter: 0.004,
        roundTripTime: 0.023,
      },
      {
        type: "media-source",
        kind: "video",
        width: 5120,
        height: 2880,
        framesPerSecond: 30,
      },
    ],
    track: {
      contentHint: "detail",
      readyState: "live",
      enabled: true,
      muted: false,
      label: "screen",
      width: 5120,
      height: 2880,
    },
    sender: {
      degradationPreference: "maintain-resolution",
      encodings: [
        { active: true, maxBitrate: 8_000_000, scaleResolutionDownBy: 2 },
      ],
      upstreamPaused: false,
    },
  };
}
