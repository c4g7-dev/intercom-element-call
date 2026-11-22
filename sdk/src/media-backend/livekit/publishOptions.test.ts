/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  audioCaptureOptions,
  screenShareCaptureOptions,
  screenSharePublishOptions,
  screenShareScale,
  videoCaptureOptions,
  videoPublishOptions,
} from "./publishOptions";

describe("audioCaptureOptions", () => {
  it("leaves a bare request to the room defaults", () => {
    expect(audioCaptureOptions({ source: "microphone" })).toBeUndefined();
  });

  it("carries the device and the processing flags", () => {
    expect(
      audioCaptureOptions({
        source: "microphone",
        deviceId: "mic-1",
        capture: { echoCancellation: false, noiseSuppression: true },
      }),
    ).toEqual({
      deviceId: "mic-1",
      echoCancellation: false,
      noiseSuppression: true,
    });
  });

  it("drops an empty device id", () => {
    expect(
      audioCaptureOptions({
        source: "microphone",
        deviceId: "",
        capture: { autoGainControl: false },
      }),
    ).toEqual({ autoGainControl: false });
  });
});

describe("videoCaptureOptions", () => {
  it("leaves a request without device, processor or resolution to the room defaults", () => {
    expect(
      videoCaptureOptions({
        source: "camera",
        capture: { maxBitrate: 1_000_000 },
      }),
    ).toBeUndefined();
  });

  it("carries the device and the resolution, but not the encoding", () => {
    expect(
      videoCaptureOptions({
        source: "camera",
        deviceId: "cam-1",
        capture: {
          resolution: { width: 1920, height: 1080, frameRate: 60 },
          maxBitrate: 4_000_000,
        },
      }),
    ).toEqual({
      deviceId: "cam-1",
      resolution: { width: 1920, height: 1080, frameRate: 60 },
    });
  });
});

describe("videoPublishOptions", () => {
  it("is nothing without capture settings", () => {
    expect(videoPublishOptions(undefined)).toBeUndefined();
  });

  it("is empty for settings that only set the resolution", () => {
    expect(
      videoPublishOptions({ resolution: { width: 640, height: 360 } }),
    ).toEqual({});
  });

  it("maps the bitrate, framerate and codec to the encoding", () => {
    expect(
      videoPublishOptions({
        maxBitrate: 4_000_000,
        maxFramerate: 60,
        codec: "vp9",
      }),
    ).toEqual({
      videoEncoding: { maxBitrate: 4_000_000, maxFramerate: 60 },
      videoCodec: "vp9",
    });
  });
});

describe("screenShareCaptureOptions", () => {
  it("captures the audio without processing by default", () => {
    expect(screenShareCaptureOptions({ source: "screenShare" })).toEqual({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false,
        voiceIsolation: false,
        channelCount: 2,
      },
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "include",
    });
  });

  it("leaves the audio out on request and carries the resolution", () => {
    expect(
      screenShareCaptureOptions({
        source: "screenShare",
        audio: false,
        capture: { resolution: { width: 1280, height: 720 } },
      }),
    ).toMatchObject({
      audio: false,
      resolution: { width: 1280, height: 720 },
    });
  });
});

describe("screenSharePublishOptions", () => {
  it("is nothing without capture settings", () => {
    expect(screenSharePublishOptions(undefined)).toBeUndefined();
  });

  it("maps the bitrate, framerate and codec to the screen share encoding", () => {
    expect(
      screenSharePublishOptions({
        maxBitrate: 5_000_000,
        maxFramerate: 15,
        codec: "av1",
      }),
    ).toEqual({
      screenShareEncoding: {
        maxBitrate: 5_000_000,
        maxFramerate: 15,
        priority: "high",
      },
      videoCodec: "av1",
    });
  });

  it("follows the captured size with the bitrate and scales by a whole number", () => {
    const settings = {
      autoBitrate: {
        base: 4_000_000,
        bitsPerPixel: 3,
        min: 6_000_000,
        max: 30_000_000,
      },
      fitWithin: { width: 5120, height: 1440, integer: true },
      simulcast: false,
      degradationPreference: "maintain-resolution",
    } as const;
    // 1440p is sent as it is, at about 15 Mbps
    expect(
      screenSharePublishOptions(settings, { width: 2560, height: 1440 }),
    ).toEqual({
      screenShareEncoding: {
        maxBitrate: 15_059_200,
        maxFramerate: undefined,
        priority: "high",
      },
      simulcast: false,
      degradationPreference: "maintain-resolution",
    });
    // 4K is halved to 1080p, at about 10 Mbps
    expect(
      screenSharePublishOptions(settings, { width: 3840, height: 2160 })
        ?.screenShareEncoding,
    ).toEqual({
      maxBitrate: 10_220_800,
      maxFramerate: undefined,
      priority: "high",
      scaleResolutionDownBy: 2,
    });
    expect(screenShareScale(settings, { width: 5120, height: 2880 })).toBe(2);
    expect(screenShareScale(settings, { width: 3440, height: 1440 })).toBe(1);
    expect(screenShareScale(settings, { width: 1920, height: 1080 })).toBe(1);
  });

  it("captures at the source's own size with the frame rate as a constraint", () => {
    expect(
      screenShareCaptureOptions({
        source: "screenShare",
        audio: { kind: "device", deviceId: "monitor" },
        capture: {
          resolution: { width: 0, height: 0, frameRate: 30 },
          contentHint: "detail",
        },
      }),
    ).toEqual({
      audio: false,
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "exclude",
      resolution: { width: 0, height: 0 },
      video: { frameRate: { ideal: 30, max: 30 } },
      contentHint: "detail",
    });
  });
});
