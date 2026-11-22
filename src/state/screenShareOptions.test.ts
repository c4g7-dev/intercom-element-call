/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, test } from "vitest";
import {
  screenShareBitrate,
  screenShareScale,
} from "@element-hq/matrixrtc-sdk";

import {
  type ScreenShareChoices,
  screenShareCaptureSettings,
  screenShareLimitsForBudget,
  screenShareRequest,
} from "./screenShareOptions";

const defaults: ScreenShareChoices = {
  preset: "sharp",
  resolution: "auto",
  codec: "auto",
  audio: "system",
  customBitrate: 0,
  customFramerate: 0,
};

describe("screenShareCaptureSettings", () => {
  test("is sharp by default: native size, one layer, the resolution held", () => {
    const settings = screenShareCaptureSettings(defaults);
    expect(settings).toMatchObject({
      resolution: { width: 0, height: 0, frameRate: 30 },
      maxFramerate: 30,
      codec: "vp8",
      contentHint: "detail",
      degradationPreference: "maintain-resolution",
      simulcast: false,
    });
    expect(settings.maxBitrate).toBeUndefined();
  });

  test("sends about 10 Mbps at 1080p, 15 at 1440p and halves 4K", () => {
    const settings = screenShareCaptureSettings(defaults);
    const mbps = (width: number, height: number): number =>
      Math.round(screenShareBitrate(settings, { width, height })! / 1_000_000);
    expect(mbps(1920, 1080)).toBe(10);
    expect(mbps(2560, 1440)).toBe(15);
    expect(screenShareScale(settings, { width: 3840, height: 2160 })).toBe(2);
    expect(mbps(3840, 2160)).toBe(10);
    // Uncapped, a 4K screen stays 4K
    const native = screenShareCaptureSettings({
      ...defaults,
      resolution: "native",
    });
    expect(screenShareScale(native, { width: 3840, height: 2160 })).toBe(1);
    expect(
      Math.round(
        screenShareBitrate(native, { width: 3840, height: 2160 })! / 1_000_000,
      ),
    ).toBe(29);
  });

  test("motion asks for 60 frames a second and more bits", () => {
    const settings = screenShareCaptureSettings({
      ...defaults,
      preset: "motion",
      resolution: "1440p",
    });
    expect(settings).toMatchObject({
      resolution: { width: 2560, height: 1440, frameRate: 60 },
      contentHint: "motion",
    });
    expect(
      Math.round(
        screenShareBitrate(settings, { width: 2560, height: 1440 })! /
          1_000_000,
      ),
    ).toBe(24);
  });

  test("low bandwidth is 720p whatever the resolution choice", () => {
    expect(
      screenShareCaptureSettings({ ...defaults, preset: "low" }).resolution,
    ).toEqual({ width: 1280, height: 720, frameRate: 15 });
  });

  test("a custom bitrate and frame rate override the preset", () => {
    expect(
      screenShareCaptureSettings({
        ...defaults,
        customBitrate: 500,
        customFramerate: 24,
        codec: "av1",
      }),
    ).toMatchObject({ maxBitrate: 80_000_000, maxFramerate: 24, codec: "av1" });
  });
});

describe("screenShareRequest", () => {
  test("takes the audio from the picker, or leaves it to a mix made elsewhere", () => {
    expect(screenShareRequest(defaults).audio).toEqual({ kind: "system" });
    for (const audio of ["none", "mix", "abc", "sink:virtual-music"])
      expect(screenShareRequest({ ...defaults, audio }).audio).toBe(false);
  });
});

describe("screenShareLimitsForBudget", () => {
  const share = {
    bitrate: 15_000_000,
    framerate: 30,
    pixels: 2560 * 1440,
    custom: false,
  };

  test("leaves the share alone without a budget or within it", () => {
    expect(
      screenShareLimitsForBudget({ ...share, viewers: 50, budgetMbps: 0 }),
    ).toEqual({ maxBitrate: 15_000_000, maxFramerate: 30, overBudget: false });
    expect(
      screenShareLimitsForBudget({ ...share, viewers: 10, budgetMbps: 400 }),
    ).toEqual({ maxBitrate: 15_000_000, maxFramerate: 30, overBudget: false });
  });

  test("shares 80% of the budget between the viewers", () => {
    expect(
      screenShareLimitsForBudget({ ...share, viewers: 4, budgetMbps: 40 }),
    ).toEqual({ maxBitrate: 8_000_000, maxFramerate: 30, overBudget: false });
    // Nobody watching counts as one viewer
    expect(
      screenShareLimitsForBudget({ ...share, viewers: 0, budgetMbps: 10 }),
    ).toEqual({ maxBitrate: 8_000_000, maxFramerate: 30, overBudget: false });
  });

  test("holds the bitrate at the floor and gives up frames instead", () => {
    const limits = screenShareLimitsForBudget({
      ...share,
      viewers: 16,
      budgetMbps: 40,
    });
    expect(limits.maxBitrate).toBe(3_999_744);
    expect(limits.maxFramerate).toBe(15);
    expect(
      screenShareLimitsForBudget({ ...share, viewers: 500, budgetMbps: 40 })
        .maxFramerate,
    ).toBe(5);
  });

  test("lets a custom bitrate through and says so", () => {
    expect(
      screenShareLimitsForBudget({
        ...share,
        bitrate: 60_000_000,
        custom: true,
        viewers: 4,
        budgetMbps: 40,
      }),
    ).toEqual({ maxBitrate: 60_000_000, maxFramerate: 30, overBudget: true });
  });
});
