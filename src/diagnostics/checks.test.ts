/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  type CheckContext,
  type CheckId,
  type CheckResult,
  carriesSound,
  checkKey,
  evaluateChecks,
  MIC_SOUND_WINDOW_MS,
  topPublishedLayer,
} from "./checks";
import { type TrackRecord } from "./trackStats";

describe("evaluateChecks", () => {
  it("has nothing to judge in a call with no media", () => {
    const results = evaluateChecks([], { ...context, micWanted: false });
    // Nothing per remote member either: nobody is sharing
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["mic_audio", "na"],
      ["share_resolution", "na"],
      ["share_audio_send", "na"],
      ["no_limitation", "na"],
    ]);
  });

  describe("mic publishing with audio", () => {
    it("passes while the microphone sends and was heard lately", () => {
      expect(
        check("mic_audio", [mic()], { lastSoundAt: { mic: NOW - 5000 } }),
      ).toMatchObject({ status: "pass" });
    });

    it.each<[string, TrackRecord[], Partial<CheckContext>, string]>([
      ["no track", [], {}, "no microphone track published"],
      ["a muted track", [mic({ muted: true })], {}, "track is muted"],
      [
        "a paused upstream",
        [mic({ upstreamPaused: true })],
        {},
        "upstream paused",
      ],
      ["no bytes", [mic({ bitrate: 0 })], {}, "no bytes sent"],
      ["no sound ever", [mic()], {}, "no sound captured yet"],
      [
        "a long silence",
        [mic()],
        { lastSoundAt: { mic: NOW - MIC_SOUND_WINDOW_MS - 1000 } },
        "silent for 31 s",
      ],
    ])(
      "fails with %s while the switch is on",
      (_name, tracks, more, detail) => {
        expect(check("mic_audio", tracks, more)).toEqual({
          id: "mic_audio",
          status: "fail",
          detail,
        });
      },
    );

    it("is not judged while the switch is off", () => {
      expect(check("mic_audio", [], { micWanted: false }).status).toBe("na");
    });
  });

  describe("screen share at expected resolution", () => {
    it("passes at the expected size, give or take the encoder's rounding", () => {
      expect(
        check("share_resolution", [share({ width: 2560, height: 1438 })], {
          shareExpected: { width: 2560, height: 1440 },
        }),
      ).toMatchObject({ status: "pass", detail: "2560x1438" });
    });

    it("fails where the encoder has scaled the share down", () => {
      expect(
        check("share_resolution", [share({ width: 1280, height: 720 })], {
          shareExpected: { width: 2560, height: 1440 },
        }),
      ).toEqual({
        id: "share_resolution",
        status: "fail",
        detail: "1280x720, expected 2560x1440",
      });
    });

    it("expects the capture's size less the scaling asked of the sender", () => {
      const scaled = share({
        width: 1920,
        height: 1080,
        capture: { width: 3840, height: 2160 },
        encodings: [{ scaleResolutionDownBy: 2 }],
      });
      expect(check("share_resolution", [scaled]).status).toBe("pass");
      expect(
        check("share_resolution", [{ ...scaled, width: 960, height: 540 }])
          .status,
      ).toBe("fail");
    });

    it("fails before the first frame", () => {
      expect(
        check("share_resolution", [share({ width: undefined })]).detail,
      ).toBe("no frames sent yet");
    });
  });

  describe("my share audio sending", () => {
    it("passes while our share's audio carries sound, with its level and bitrate", () => {
      expect(
        check("share_audio_send", [share(), shareAudio({ audioLevel: 0.15 })], {
          lastSoundAt: { audio: NOW - 1000 },
        }),
      ).toEqual({
        id: "share_audio_send",
        status: "pass",
        detail: "128 kbps, level 0.15",
      });
    });

    it("is not failed by a remote member who shares nothing", () => {
      // What was seen in a call: we share with sound, the other member has
      // an audio track for a share that is not on, and silent
      const tracks = [
        share(),
        shareAudio({ audioLevel: 0.15, bitrate: 200_000 }),
        shareAudio({ dir: "recv", participant: "@other:x:D", sid: "theirs" }),
      ];
      const results = evaluateChecks(tracks, {
        ...context,
        micWanted: false,
        shareAudioExpected: true,
        lastSoundAt: { audio: NOW },
      });
      expect(results.find((r) => r.id === "share_audio_send")).toMatchObject({
        status: "pass",
        detail: "200 kbps, level 0.15",
      });
      expect(results.some((r) => r.id === "share_audio_recv")).toBe(false);
      expect(results.some((r) => r.id === "top_layer")).toBe(false);
      expect(results.some((r) => r.status === "fail")).toBe(false);
    });

    it("fails for a share's audio that stays silent", () => {
      expect(check("share_audio_send", [shareAudio()])).toMatchObject({
        status: "fail",
        detail: "no sound yet",
      });
      expect(
        check("share_audio_send", [shareAudio()], {
          lastSoundAt: { audio: NOW - 60_000 },
        }).detail,
      ).toBe("silent for 60 s");
      expect(
        check("share_audio_send", [shareAudio({ muted: true })]).detail,
      ).toBe("muted");
      expect(
        check("share_audio_send", [shareAudio({ bitrate: 0 })]).detail,
      ).toBe("no bytes");
    });

    it("fails where a share asked for audio and published none", () => {
      expect(
        check("share_audio_send", [share()], { shareAudioExpected: true }),
      ).toMatchObject({
        status: "fail",
        detail: "no screen share audio track published",
      });
      expect(check("share_audio_send", [share()]).status).toBe("na");
    });

    it("is not judged by what is received", () => {
      const tracks = [
        share({ dir: "recv", participant: "@a:x:D", sid: "v" }),
        shareAudio({ dir: "recv", participant: "@a:x:D", sid: "theirs" }),
      ];
      expect(check("share_audio_send", tracks).status).toBe("na");
    });
  });

  describe("share audio received", () => {
    const theirShare = (participant: string): TrackRecord[] => [
      share({ dir: "recv", participant, sid: `v-${participant}` }),
      shareAudio({ dir: "recv", participant, sid: `a-${participant}` }),
    ];

    it("has a verdict per remote member sharing with audio", () => {
      const results = evaluateChecks(
        [...theirShare("@a:x:D"), ...theirShare("@b:x:D")],
        { ...context, lastSoundAt: { "a-@a:x:D": NOW - 1000 } },
      ).filter((r) => r.id === "share_audio_recv");
      expect(results).toEqual([
        {
          id: "share_audio_recv",
          participant: "@a:x:D",
          status: "pass",
          detail: "128 kbps, level 0.20",
        },
        {
          id: "share_audio_recv",
          participant: "@b:x:D",
          status: "fail",
          detail: "no sound yet",
        },
      ]);
      expect(results.map(checkKey)).toEqual([
        "share_audio_recv:@a:x:D",
        "share_audio_recv:@b:x:D",
      ]);
    });

    it("has none for a member whose share is off, muted or without audio", () => {
      const none = (tracks: TrackRecord[]): boolean =>
        !evaluateChecks(tracks, context).some(
          (r) => r.id === "share_audio_recv",
        );
      // An audio track left without a share
      expect(none([shareAudio({ dir: "recv", participant: "@a:x:D" })])).toBe(
        true,
      );
      // A share that is paused
      expect(
        none([
          share({ dir: "recv", participant: "@a:x:D", muted: true }),
          shareAudio({ dir: "recv", participant: "@a:x:D" }),
        ]),
      ).toBe(true);
      // A share without sound
      expect(none([share({ dir: "recv", participant: "@a:x:D" })])).toBe(true);
      // Another member's share says nothing of this one's audio
      expect(
        none([
          share({ dir: "recv", participant: "@b:x:D" }),
          shareAudio({ dir: "recv", participant: "@a:x:D" }),
        ]),
      ).toBe(true);
      // Our own share is not a remote one
      expect(none([share(), shareAudio()])).toBe(true);
    });
  });

  describe("no quality limitation", () => {
    it("passes while no sent video is limited", () => {
      expect(check("no_limitation", [share()]).status).toBe("pass");
    });

    it("names what limits which track", () => {
      expect(
        check("no_limitation", [
          share({ limitation: "cpu" }),
          share({ source: "camera", limitation: "bandwidth", sid: "cam" }),
        ]),
      ).toMatchObject({
        status: "fail",
        detail: "screen_share: cpu, camera: bandwidth",
      });
    });
  });

  describe("receiving top layer", () => {
    const published = {
      simulcast: true,
      layers: [
        { quality: 0, width: 640, height: 360, bitrate: 1 },
        { quality: 2, width: 2560, height: 1440, bitrate: 1 },
      ],
    };

    it("passes while a received share is at the largest size on offer", () => {
      expect(
        check("top_layer", [
          share({ dir: "recv", width: 2560, height: 1440, published }),
        ]),
      ).toMatchObject({ status: "pass", detail: "2560x1440" });
    });

    it("fails for a share received at a lower layer", () => {
      expect(
        check("top_layer", [
          share({
            dir: "recv",
            participant: "@a:x:D",
            width: 640,
            height: 360,
            published,
          }),
        ]),
      ).toEqual({
        id: "top_layer",
        participant: "@a:x:D",
        status: "fail",
        detail: "640x360 of 2560x1440",
      });
    });

    it("has a verdict per remote member sharing, none for the others", () => {
      const results = evaluateChecks(
        [
          share({ published }),
          share({ dir: "recv", participant: "@a:x:D", sid: "a", published }),
          share({
            dir: "recv",
            participant: "@b:x:D",
            sid: "b",
            width: undefined,
            published,
          }),
          share({
            dir: "recv",
            participant: "@c:x:D",
            sid: "c",
            muted: true,
            published,
          }),
          share({ dir: "recv", participant: "@d:x:D", source: "camera" }),
        ],
        context,
      ).filter((r) => r.id === "top_layer");
      expect(results.map((r) => [r.participant, r.status, r.detail])).toEqual([
        ["@a:x:D", "pass", "2560x1440"],
        ["@b:x:D", "fail", "no frames"],
      ]);
    });

    it("does not judge cameras, which are sized to their tiles", () => {
      expect(
        check("top_layer", [
          share({
            dir: "recv",
            source: "camera",
            width: 320,
            height: 180,
            published,
          }),
        ]),
      ).toBeUndefined();
    });
  });
});

describe("carriesSound", () => {
  it("takes energy added over the interval, on an unmuted audio track", () => {
    expect(carriesSound(mic({ audioEnergyDelta: 0.01 }))).toBe(true);
    expect(carriesSound(mic({ audioEnergyDelta: 0 }))).toBe(false);
    expect(carriesSound(mic({ audioEnergyDelta: 0.01, muted: true }))).toBe(
      false,
    );
    expect(carriesSound(mic())).toBe(false);
  });
});

describe("topPublishedLayer", () => {
  it("falls back to the announced size where no layers are listed", () => {
    expect(
      topPublishedLayer(
        share({
          published: { simulcast: false, width: 800, height: 600, layers: [] },
        }),
      ),
    ).toEqual({ width: 800, height: 600 });
    expect(topPublishedLayer(share())).toBeUndefined();
  });
});

const NOW = 1_000_000;
const context: CheckContext = {
  now: NOW,
  micWanted: true,
  shareAudioExpected: false,
  lastSoundAt: {},
};

function check(
  id: CheckId,
  tracks: TrackRecord[],
  more: Partial<CheckContext> = {},
): CheckResult {
  // The per-member checks are not there where no member is sharing
  return evaluateChecks(tracks, { ...context, ...more }).find(
    (r) => r.id === id,
  ) as CheckResult;
}

function mic(more: Partial<TrackRecord> = {}): TrackRecord {
  return {
    dir: "send",
    participant: "@me:x:D",
    source: "microphone",
    kind: "audio",
    sid: "mic",
    muted: false,
    hw: null,
    bitrate: 32_000,
    audioLevel: 0.2,
    ...more,
  };
}

function share(more: Partial<TrackRecord> = {}): TrackRecord {
  return {
    dir: "send",
    participant: "@me:x:D",
    source: "screen_share",
    kind: "video",
    sid: "share",
    muted: false,
    hw: false,
    width: 2560,
    height: 1440,
    limitation: "none",
    ...more,
  };
}

function shareAudio(more: Partial<TrackRecord> = {}): TrackRecord {
  return {
    ...mic(),
    source: "screen_share_audio",
    sid: "audio",
    bitrate: 128_000,
    ...more,
  };
}
