/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type PublishRequest,
  type ScreenShareAudioSource,
  type VideoCaptureSettings,
  type VideoCodec,
  type VideoEncodingLimits,
} from "@element-hq/matrixrtc-sdk";

import {
  type ScreenSharePreset,
  type ScreenShareResolutionMode,
  screenShareAudioSource,
  screenShareCodecChoice,
  screenShareCustomBitrate,
  screenShareCustomFramerate,
  screenSharePreset,
  screenShareResolutionMode,
} from "../settings/settings";

/**
 * The codec a screen share is sent with unless the user picks another.
 *
 * VP8, with the `detail` content hint. VP9 and AV1 would need fewer bits for
 * the same text (AV1's screen content tools most of all), but LiveKit
 * publishes both with SVC and, as a workaround for a Chrome limit of 5 fps on
 * SVC screen shares, forces their content hint to `motion`: the screen
 * content mode that makes them efficient is switched off, and what is left of
 * the saving is not worth software AV1/VP9 at 1440p on every share. VP8 keeps
 * `detail` (the encoder holds the resolution and spends its bits on sharp
 * edges), is the one codec every LiveKit deployment and every viewer has,
 * and is the best-trodden path through LiveKit's end-to-end encryption. With
 * the bitrates the presets ask for it is visually clean. VP9 and AV1 stay one
 * click away for when bits are scarce.
 */
export const DEFAULT_SCREEN_SHARE_CODEC: VideoCodec = "vp8";

export const MAX_CUSTOM_BITRATE_MBPS = 80;

/**
 * The size a share is sent within where the user leaves it to us: 1440 rows,
 * and wide enough that an ultrawide 1440p screen is not scaled for its width.
 */
const AUTO_MAX_SIZE = { width: 5120, height: 1440 };

interface PresetDefinition {
  framerate: number;
  contentHint: NonNullable<VideoCaptureSettings["contentHint"]>;
  degradationPreference: NonNullable<
    VideoCaptureSettings["degradationPreference"]
  >;
  /**
   * The bitrate by the size sent: about 10 Mbps at 1080p and 15 Mbps at
   * 1440p for 30 frames a second, 1.6 times that for 60.
   */
  autoBitrate: NonNullable<VideoCaptureSettings["autoBitrate"]>;
  /** Overrides the user's resolution choice. */
  resolution?: { width: number; height: number };
}

export const screenSharePresets: Record<ScreenSharePreset, PresetDefinition> = {
  // Text and interfaces: every frame sharp, the resolution never given up
  sharp: {
    framerate: 30,
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
    autoBitrate: {
      base: 4_000_000,
      bitsPerPixel: 3,
      min: 6_000_000,
      max: 30_000_000,
    },
  },
  // Video and games: 60 frames a second
  motion: {
    framerate: 60,
    contentHint: "motion",
    degradationPreference: "balanced",
    autoBitrate: {
      base: 6_400_000,
      bitsPerPixel: 4.8,
      min: 10_000_000,
      max: 50_000_000,
    },
  },
  // A thin uplink: small and slow, but still legible
  low: {
    framerate: 15,
    contentHint: "detail",
    degradationPreference: "maintain-resolution",
    autoBitrate: {
      bitsPerPixel: 1.6,
      min: 1_000_000,
      max: 2_500_000,
    },
    resolution: { width: 1280, height: 720 },
  },
};

export interface ScreenShareChoices {
  preset: ScreenSharePreset;
  resolution: ScreenShareResolutionMode;
  codec: VideoCodec | "auto";
  /** `none`, `system` or the id of an audio input. */
  audio: string;
  /** In Mbps; 0 for the preset's. */
  customBitrate: number;
  /** 0 for the preset's. */
  customFramerate: number;
}

export function screenShareChoices(): ScreenShareChoices {
  return {
    preset: screenSharePreset.getValue(),
    resolution: screenShareResolutionMode.getValue(),
    codec: screenShareCodecChoice.getValue(),
    audio: screenShareAudioSource.getValue(),
    customBitrate: screenShareCustomBitrate.getValue(),
    customFramerate: screenShareCustomFramerate.getValue(),
  };
}

function captureSize(mode: ScreenShareResolutionMode): Pick<
  VideoCaptureSettings,
  "fitWithin"
> & {
  size: { width: number; height: number };
} {
  switch (mode) {
    case "1080p":
      return { size: { width: 1920, height: 1080 } };
    case "1440p":
      return { size: { width: 2560, height: 1440 } };
    case "native":
      return { size: { width: 0, height: 0 } };
    case "auto":
      // The source's own size, and where that is larger than 1440p, scaled
      // down by a whole number: a 4K screen is sent at exactly half, 1080p.
      // Halving averages 2x2 blocks of pixels, which leaves text as crisp as
      // the same desktop rendered at 1080p, where the 1.5 it would take to
      // land on 1440p smears every glyph edge across the pixel grid. A 4K
      // desktop is almost always run at 200% scale, so nothing is lost that
      // was meant to be read.
      return {
        size: { width: 0, height: 0 },
        fitWithin: { ...AUTO_MAX_SIZE, integer: true },
      };
  }
}

/** How a screen share is captured and encoded for the user's choices. */
export function screenShareCaptureSettings(
  choices: ScreenShareChoices,
): VideoCaptureSettings {
  const preset = screenSharePresets[choices.preset];
  const framerate =
    choices.customFramerate > 0 ? choices.customFramerate : preset.framerate;
  const { size, fitWithin } = preset.resolution
    ? { size: preset.resolution, fitWithin: undefined }
    : captureSize(choices.resolution);
  return {
    resolution: { ...size, frameRate: framerate },
    maxFramerate: framerate,
    ...(choices.customBitrate > 0
      ? {
          maxBitrate:
            Math.min(choices.customBitrate, MAX_CUSTOM_BITRATE_MBPS) *
            1_000_000,
        }
      : { autoBitrate: preset.autoBitrate }),
    ...(fitWithin && { fitWithin }),
    codec:
      choices.codec === "auto" ? DEFAULT_SCREEN_SHARE_CODEC : choices.codec,
    contentHint: preset.contentHint,
    degradationPreference: preset.degradationPreference,
    // One layer, the sharp one: a second, half-size layer is what viewers
    // with a small tile were given, and it is unreadable
    simulcast: false,
  };
}

export function screenShareAudio(
  choice: string,
): boolean | ScreenShareAudioSource {
  if (choice === "none") return false;
  if (choice === "system") return { kind: "system" };
  return { kind: "device", deviceId: choice };
}

export function screenShareRequest(
  choices: ScreenShareChoices = screenShareChoices(),
): Extract<PublishRequest, { source: "screenShare" }> {
  return {
    source: "screenShare",
    audio: screenShareAudio(choices.audio),
    capture: screenShareCaptureSettings(choices),
  };
}

/** About 4 Mbps at 1440p: below this text stops being clean at any frame rate. */
const FLOOR_BITS_PER_PIXEL = 1.085;
const MIN_FRAMERATE = 5;

export interface EgressBudgetInputs {
  /** What the share would be sent at with no budget. */
  bitrate: number;
  framerate: number;
  /** The size sent, after any scaling. */
  pixels: number;
  /** The members the SFU sends a copy to. */
  viewers: number;
  /** `media_quality.server_egress_budget_mbps`; 0 for none. */
  budgetMbps: number;
  /** Whether the user set the bitrate themselves, which the budget does not touch. */
  custom: boolean;
}

/**
 * The limits a screen share is encoded within so that the SFU, which sends
 * one copy to every viewer, stays inside its uplink: 80% of the budget shared
 * between the viewers. The bitrate does not go below a floor at which the
 * picture is still clean; from there on the frame rate gives way instead.
 */
export function screenShareLimitsForBudget({
  bitrate,
  framerate,
  pixels,
  viewers,
  budgetMbps,
  custom,
}: EgressBudgetInputs): Required<VideoEncodingLimits> & {
  /** Whether a custom bitrate takes the SFU over its budget. */
  overBudget: boolean;
} {
  if (budgetMbps <= 0)
    return { maxBitrate: bitrate, maxFramerate: framerate, overBudget: false };
  const perViewer = (budgetMbps * 1_000_000 * 0.8) / Math.max(1, viewers);
  if (custom || bitrate <= perViewer)
    return {
      maxBitrate: bitrate,
      maxFramerate: framerate,
      overBudget: bitrate > perViewer,
    };
  const floor = Math.min(bitrate, Math.round(pixels * FLOOR_BITS_PER_PIXEL));
  if (perViewer >= floor)
    return {
      maxBitrate: Math.round(perViewer),
      maxFramerate: framerate,
      overBudget: false,
    };
  return {
    maxBitrate: floor,
    maxFramerate: Math.max(
      MIN_FRAMERATE,
      Math.min(framerate, Math.floor((framerate * perViewer) / floor)),
    ),
    overBudget: false,
  };
}
