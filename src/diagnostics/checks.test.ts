/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  type CheckContext,
  type CheckId,
  carriesSound,
  evaluateChecks,
  MIC_SOUND_WINDOW_MS,
  topPublishedLayer,
} from "./checks";
import { type TrackRecord } from "./trackStats";

describe("evaluateChecks", () => {
  it("has nothing to judge in a call with no media", () => {
    const results = evaluateChecks([], { ...context, micWanted: false });
    expect(results.map((r) => r.status)).toEqual([
      "na",
      "na",
      "na",
      "na",
      "na",
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

  describe("share audio flowing", () => {
    it("passes while the share's audio carries sound, sent or received", () => {
      const tracks = [shareAudio(), shareAudio({ dir: "recv", sid: "theirs" })];
      expect(
        check("share_audio", tracks, {
          lastSoundAt: { audio: NOW - 1000, theirs: NOW },
        }).status,
      ).toBe("pass");
    });

    it("fails for a share's audio that stays silent", () => {
      expect(check("share_audio", [shareAudio()])).toMatchObject({
        status: "fail",
        detail: "ours: no sound yet",
      });
      expect(
        check("share_audio", [shareAudio()], {
          lastSoundAt: { audio: NOW - 60_000 },
        }).detail,
      ).toBe("ours: silent for 60 s");
    });

    it("fails where a share asked for audio and published none", () => {
      expect(
        check("share_audio", [share()], { shareAudioExpected: true }),
      ).toMatchObject({
        status: "fail",
        detail: "no screen share audio track published",
      });
      expect(check("share_audio", [share()]).status).toBe("na");
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
      ).toMatchObject({
        status: "fail",
        detail: "@a:x:D: 640x360 of 2560x1440",
      });
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
        ]).status,
      ).toBe("na");
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
): { id: CheckId; status: string; detail: string } {
  const result = evaluateChecks(tracks, { ...context, ...more }).find(
    (r) => r.id === id,
  );
  if (result === undefined) throw new Error(`No ${id} check`);
  return result;
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
