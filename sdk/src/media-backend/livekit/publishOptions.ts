/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  Track,
  type AudioCaptureOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoEncoding,
  type VideoCaptureOptions,
} from "livekit-client";

import {
  type PublishRequest,
  type VideoCaptureSettings,
} from "../../media-api";
import { toLivekitProcessor } from "./videoProcessor";

export type PublishRequestFor<S extends PublishRequest["source"]> = Extract<
  PublishRequest,
  { source: S }
>;

/** LiveKit fills in the room defaults for whatever a request leaves out. */
export function audioCaptureOptions({
  deviceId,
  capture,
}: PublishRequestFor<"microphone">): AudioCaptureOptions | undefined {
  if (deviceId === undefined && capture === undefined) return undefined;
  return { ...(deviceId && { deviceId }), ...capture };
}

export function videoCaptureOptions({
  deviceId,
  processor,
  capture,
}: PublishRequestFor<"camera">): VideoCaptureOptions | undefined {
  if (!deviceId && !processor && !capture?.resolution) return undefined;
  return {
    ...(deviceId && { deviceId }),
    ...(processor && { processor: toLivekitProcessor(processor) }),
    ...(capture?.resolution && { resolution: capture.resolution }),
  };
}

export function videoPublishOptions(
  settings: VideoCaptureSettings | undefined,
): TrackPublishOptions | undefined {
  if (settings === undefined) return undefined;
  return {
    ...(settings.maxBitrate !== undefined && {
      videoEncoding: {
        maxBitrate: settings.maxBitrate,
        maxFramerate: settings.maxFramerate,
      },
    }),
    ...(settings.codec && { videoCodec: settings.codec }),
  };
}

/** The processing a browser applies to a voice, all of which would mangle shared audio. */
const rawAudio = {
  // No echo cancellation: it would cancel the other members' voices out of
  // the shared audio
  echoCancellation: false,
  autoGainControl: false,
  noiseSuppression: false,
  voiceIsolation: false,
  channelCount: 2,
} as const;

export function screenShareCaptureOptions({
  audio = true,
  capture,
}: PublishRequestFor<"screenShare">): ScreenShareCaptureOptions {
  const resolution = capture?.resolution;
  // A size of 0 is LiveKit's "uncapped": the source's own size. It drops the
  // frame rate along with the size, so that goes in as a constraint instead
  const native =
    resolution !== undefined &&
    (resolution.width === 0 || resolution.height === 0);
  // An audio device stands in for the picker's audio, which is then not asked for
  const systemAudio =
    audio === true || (typeof audio === "object" && audio.kind === "system");
  return {
    audio: systemAudio && rawAudio,
    selfBrowserSurface: "include",
    surfaceSwitching: "include",
    systemAudio: systemAudio ? "include" : "exclude",
    ...(resolution &&
      (native
        ? {
            resolution: { width: 0, height: 0 },
            ...(resolution.frameRate !== undefined && {
              // LiveKit types only the display surface here, but hands the
              // whole object to getDisplayMedia as the video constraints
              video: {
                frameRate: {
                  ideal: resolution.frameRate,
                  max: resolution.frameRate,
                },
              } as ScreenShareCaptureOptions["video"],
            }),
          }
        : { resolution })),
    ...(capture?.contentHint && { contentHint: capture.contentHint }),
  };
}

/** The constraints a device is opened with to carry a screen share's audio. */
export function screenShareAudioDeviceConstraints(
  deviceId: string,
): MediaTrackConstraints {
  return { deviceId: { exact: deviceId }, sampleRate: 48000, ...rawAudio };
}

/** A screen share's audio is anything but a voice: stereo, at a music bitrate, never gated. */
export const screenShareAudioPublishOptions: TrackPublishOptions = {
  source: Track.Source.ScreenShareAudio,
  audioPreset: { maxBitrate: 192_000 },
  dtx: false,
  red: false,
  forceStereo: true,
};

/** The factor a capture of this size is scaled down by before it is sent; 1 for none. */
export function screenShareScale(
  settings: Pick<VideoCaptureSettings, "fitWithin">,
  size: { width?: number; height?: number } | undefined,
): number {
  const fit = settings.fitWithin;
  if (fit === undefined || !size?.width || !size.height) return 1;
  const factor = Math.max(size.width / fit.width, size.height / fit.height);
  if (factor <= 1) return 1;
  return fit.integer ? Math.ceil(factor) : factor;
}

/** The bitrate a screen share of this size is sent at. */
export function screenShareBitrate(
  settings: VideoCaptureSettings,
  size: { width?: number; height?: number } | undefined,
): number | undefined {
  if (settings.maxBitrate !== undefined) return settings.maxBitrate;
  const auto = settings.autoBitrate;
  if (auto === undefined) return undefined;
  if (!size?.width || !size.height) return auto.min;
  const scale = screenShareScale(settings, size);
  const pixels = (size.width * size.height) / (scale * scale);
  return Math.round(
    Math.min(
      auto.max,
      Math.max(auto.min, (auto.base ?? 0) + pixels * auto.bitsPerPixel),
    ),
  );
}

/**
 * @param size - What is being captured, once known, for a bitrate that follows it.
 */
export function screenSharePublishOptions(
  settings: VideoCaptureSettings | undefined,
  size?: { width?: number; height?: number },
): TrackPublishOptions | undefined {
  if (settings === undefined) return undefined;
  const maxBitrate = screenShareBitrate(settings, size);
  const scale = screenShareScale(settings, size);
  return {
    ...(maxBitrate !== undefined && {
      screenShareEncoding: {
        maxBitrate,
        maxFramerate: settings.maxFramerate,
        // A screen share is what the viewers came for: it goes ahead of the
        // cameras where the uplink is short
        priority: "high",
        // Without simulcast LiveKit hands this object to the sender as its
        // one encoding, so the scale rides along
        ...(scale > 1 && { scaleResolutionDownBy: scale }),
      } as VideoEncoding,
    }),
    ...(settings.codec && { videoCodec: settings.codec }),
    ...(settings.simulcast !== undefined && { simulcast: settings.simulcast }),
    ...(settings.degradationPreference && {
      degradationPreference: settings.degradationPreference,
    }),
  };
}
