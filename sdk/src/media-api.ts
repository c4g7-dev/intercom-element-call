/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * The public media types of the SDK: what a member publishes, the tracks it
 * arrives as and how a host renders them. The client and member types are in
 * `api.ts`.
 */

import { type Observable } from "rxjs";

import { type Behavior } from "./reactive/Behavior";

export interface AudioCaptureSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

export type VideoCodec = "vp8" | "h264" | "vp9" | "av1" | "h265";

export interface VideoCaptureSettings {
  /**
   * The size to capture at. For a screen share, a width and height of 0 mean
   * the source's own size, uncapped; `frameRate` still applies.
   */
  resolution?: { width: number; height: number; frameRate?: number };
  maxBitrate?: number;
  maxFramerate?: number;
  codec?: VideoCodec;
  /**
   * In place of `maxBitrate`, a bitrate that follows the size actually
   * captured, which for a screen share is only known once the user has picked
   * a source: `base` plus `bitsPerPixel` times the pixels of one frame as it
   * is sent, kept within `min` and `max`.
   */
  autoBitrate?: {
    base?: number;
    bitsPerPixel: number;
    min: number;
    max: number;
  };
  /**
   * Sends a capture larger than this scaled down, the capture itself staying
   * as it is. With `integer` the factor is a whole number (2, 3, ...), which
   * averages whole blocks of pixels and keeps text crisp where a fractional
   * factor would smear it across the pixel grid. Screen shares only.
   */
  fitWithin?: { width: number; height: number; integer?: boolean };
  /**
   * What the encoder should favour: `detail` and `text` keep text sharp,
   * `motion` keeps movement smooth. Screen shares only.
   */
  contentHint?: "detail" | "text" | "motion";
  /** Whether to publish lower-quality layers beside the full one. Default: the backend's choice. */
  simulcast?: boolean;
  /** What gives way when the encoder or the uplink cannot keep up. */
  degradationPreference?:
    | "maintain-resolution"
    | "maintain-framerate"
    | "balanced";
}

/** Where a screen share's audio comes from. */
export type ScreenShareAudioSource =
  /** Whatever the browser's screen picker offers (system or tab audio). */
  | { kind: "system" }
  /**
   * An audio input device, opened without any voice processing and published
   * as the screen share's audio: on Linux, the monitor of an output device.
   */
  | { kind: "device"; deviceId: string }
  /**
   * A track the application made itself, a mix of several sources for one,
   * published as it is. It is the application's to stop; unpublishing the
   * share ends it like any other published track.
   */
  | { kind: "track"; track: MediaStreamTrack };

/** How a published video track is encoded from now on, without republishing. */
export interface VideoEncodingLimits {
  maxBitrate?: number;
  maxFramerate?: number;
}

/**
 * Transforms a camera track before it is published: background blur and the
 * like. `init` resolves with the track to publish in place of the captured
 * one; `restart` does the same for a new capture, where the camera changes.
 */
export interface VideoProcessor {
  name: string;
  init(
    track: MediaStreamTrack,
    element?: HTMLMediaElement,
  ): Promise<MediaStreamTrack>;
  restart(
    track: MediaStreamTrack,
    element?: HTMLMediaElement,
  ): Promise<MediaStreamTrack>;
  destroy(): Promise<void>;
}

/**
 * One thing to publish: a source, where to capture it from and how to encode
 * it. Where the device and the settings are left out, the browser's and
 * LiveKit's defaults apply.
 */
export type PublishRequest =
  | { source: "microphone"; deviceId?: string; capture?: AudioCaptureSettings }
  | {
      source: "camera";
      deviceId?: string;
      /** Background blur and the like, applied before the first frame is published. */
      processor?: VideoProcessor;
      capture?: VideoCaptureSettings;
    }
  | {
      source: "screenShare";
      /**
       * Whether to capture the screen's audio too, as the browser offers it,
       * or the source to take it from. Default true.
       */
      audio?: boolean | ScreenShareAudioSource;
      capture?: VideoCaptureSettings;
    };

export type MediaSource =
  | "microphone"
  | "camera"
  | "screenShare"
  | "screenShareAudio"
  /** Published without a source; the application knows what it is. */
  | "unknown";

export type MediaStreamStats =
  | RTCInboundRtpStreamStats
  | RTCOutboundRtpStreamStats
  | undefined;

/**
 * Everything a backend can say about how a track is being sent or received
 * right now, for a diagnostics recorder. Carries numbers and names only:
 * never media, keys or tokens.
 */
export interface TrackDiagnostics {
  /** Every entry of the statistics report of the track's sender or receiver. */
  stats: Record<string, unknown>[];
  /**
   * Remote audio: the volume the track was last asked to be played at here
   * (0 is "muted for me"), where one was set. Says nothing about what is
   * received: a browser stops measuring the level of audio it does not play.
   */
  playbackVolume?: number;
  /** The browser's track, as it is now. */
  track?: {
    contentHint?: string;
    readyState: string;
    enabled: boolean;
    muted: boolean;
    label: string;
    width?: number;
    height?: number;
    frameRate?: number;
    sampleRate?: number;
    channelCount?: number;
  };
  /** Local tracks: what the sender was last told to encode. */
  sender?: {
    degradationPreference?: string;
    encodings: {
      rid?: string;
      active?: boolean;
      maxBitrate?: number;
      maxFramerate?: number;
      scaleResolutionDownBy?: number;
      scalabilityMode?: string;
      priority?: string;
    }[];
    upstreamPaused: boolean;
  };
  /** What the publisher announced: the layers on offer and the full size. */
  published?: {
    simulcast: boolean;
    width?: number;
    height?: number;
    layers: {
      quality: number;
      width: number;
      height: number;
      bitrate: number;
    }[];
  };
  /** Remote tracks: the state of our subscription. */
  subscription?: {
    subscribed: boolean;
    enabled: boolean;
    /** The quality asked of the SFU: 0 low, 1 medium, 2 high. */
    requestedQuality?: number;
    streamState?: string;
  };
}

/** One published track of a member. */
export interface MediaTrack {
  source: MediaSource;
  kind: "audio" | "video";
  /** Stable for the life of the track. */
  id: string;
  muted$: Behavior<boolean>;
  /**
   * False when the SFU reports the track as unencrypted. Fixed for the life
   * of the track: a publisher that changes its encryption publishes anew.
   */
  encrypted: boolean;
  /**
   * Inbound statistics for a remote track, outbound for a local one, polled
   * every `intervalMs` while the observable is subscribed and not at all
   * otherwise. Each subscription runs its own poll, so a view shares one.
   */
  stats$(intervalMs: number): Observable<MediaStreamStats>;
  /**
   * One reading of all there is to know about the track's transmission.
   * Undefined while there is no track behind the publication.
   */
  diagnostics(): Promise<TrackDiagnostics | undefined>;
  /**
   * Rendering. The view hands its `<video>` or `<audio>` element over; the SDK
   * sets its stream and, for video, registers the size and on-screen observers
   * that pick a simulcast layer and pause the subscription while the element is
   * hidden. `attach` is idempotent per element; `detach` has to be called
   * before the element leaves the DOM so those observers are released.
   */
  attach(element: HTMLMediaElement): void;
  detach(element: HTMLMediaElement): void;
}

export interface AudioMediaTrack extends MediaTrack {
  kind: "audio";
  /**
   * Whether the track carries sound right now, as the backend measures it.
   * False while muted. A call reads this on the microphone track and calls it
   * "speaking".
   * This is different to audioLevel = 0. The backend might run some hysteresis on it.
   */
  isActive$: Behavior<boolean>;
  /**
   * How loud the track is right now, 0 to 1, as the backend measures it. 0
   * while muted. Not what decides `isActive$`: the backend applies its own
   * threshold and hysteresis to that, so a level above 0 may not be active and
   * an active track may briefly sit at 0.
   */
  audioLevel$: Behavior<number>;
  /** Route playback through Web Audio, for earpiece pan and gain. Undefined resets. */
  setAudioContext(ctx: AudioContext | undefined, plugins?: AudioNode[]): void;
  setVolume(volume: number): void;
}

export interface VideoMediaTrack extends MediaTrack {
  kind: "video";
  /**
   * The browser's own track, for rendering where `attach` cannot reach: a
   * `<video>` in another window. Undefined while there is none (a remote
   * track before subscription).
   */
  mediaStreamTrack$: Behavior<MediaStreamTrack | undefined>;
  /**
   * Asks for the best quality the publisher sends, whatever the size of the
   * elements the track is attached to, and keeps it flowing while no element
   * is visible. For a tile shown fullscreen or in another window, and for
   * screen shares. Returns the function that withdraws the request.
   */
  requestHighQuality(): () => void;
}

/** The controls a member has over a track it publishes itself. */
export interface LocalMediaTrack {
  /**
   * Mutes or unmutes. Resolves with the state that resulted, which differs
   * from the request where the device could not be used.
   */
  setEnabled(enabled: boolean): Promise<boolean>;
  /**
   * Captures from another device. Rejects where that device cannot be opened,
   * leaving the track on the one it had, and for a screen share, which has none.
   */
  setDevice(deviceId: string): Promise<void>;
}

export interface LocalAudioMediaTrack
  extends AudioMediaTrack, LocalMediaTrack {}

export interface LocalVideoMediaTrack extends VideoMediaTrack, LocalMediaTrack {
  /**
   * For mirroring. A camera that does not say which way it faces is taken to
   * face the user, unless it is known to film the room, as a phone used as a
   * webcam. Undefined while there is no camera track.
   */
  facingMode$: Behavior<"user" | "environment" | undefined>;
  /**
   * Restarts the camera facing the other way, on devices with a front and a
   * back camera, and resolves with the id of the device now in use. Does
   * nothing while there is no camera track.
   */
  switchFacingMode(): Promise<string | undefined>;
  /** Background blur and the like; undefined removes the processor. */
  setProcessor(processor: VideoProcessor | undefined): Promise<void>;
  /**
   * Changes the limits the track is encoded within, on the live sender.
   * Resolves false where there is no sender to change yet.
   */
  setEncodingLimits(limits: VideoEncodingLimits): Promise<boolean>;
  /** The size being captured right now; undefined while unknown. */
  dimensions(): { width: number; height: number } | undefined;
}

export type EncryptionError = "MissingKey" | "InvalidKey";

/**
 * What a member sends, once it has arrived on its transport: its tracks, null
 * while nothing has arrived for it, and the key errors beside them. The media
 * backend supplies exactly these two fields per member.
 */
export interface MemberMedia {
  /**
   * The member's tracks, in publication order, once it has shown up on its
   * transport; null until then ("waiting for media"). An entry stays the same
   * object for as long as the same publication is behind it. Which track is
   * which is in its `source`; `trackBySource$` picks one out.
   */
  tracks$: Behavior<(AudioMediaTrack | VideoMediaTrack)[] | null>;
  /** Emits when the SFU reports a key problem for this member. */
  encryptionError$: Observable<EncryptionError>;
}

export interface LocalMemberMedia extends MemberMedia {
  tracks$: Behavior<(LocalAudioMediaTrack | LocalVideoMediaTrack)[] | null>;
}

/**
 * Tracks captured ahead of a join, for a lobby: the same local tracks a
 * participation hands out, on nothing but the browser's devices, so they fit
 * whichever backend joins. Handed to `join` as `publish`, they are moved once
 * the participation publishes them: they leave `tracks$`, their objects are
 * finished (controls reject, elements detached), and the same devices come
 * back under `localMember$.tracks$` as new objects. `stop` releases only what
 * was not moved; `capture` works again afterwards.
 */
export interface LocalMedia {
  /** What was captured with, one per source; a join reads its defaults from here. */
  readonly requests: PublishRequest[];
  tracks$: Behavior<(LocalAudioMediaTrack | LocalVideoMediaTrack)[]>;
  /**
   * Opens the devices, in one permission prompt where the browser asks for
   * one. Rejects where a device cannot be opened, having opened none of them.
   * A source captured already is replaced.
   */
  capture(
    requests: PublishRequest[],
  ): Promise<(LocalAudioMediaTrack | LocalVideoMediaTrack)[]>;
  /** Closes the device behind a source; nothing where it was not captured. */
  release(source: MediaSource): void;
  /** Closes every device still held. */
  stop(): void;
  /**
   * For a media backend, as it starts publishing: moves every track out,
   * finishing its object here. Not for a host; the participation calls it.
   */
  takeTracks(): Map<"microphone" | "camera", HandedOverTrack>;
}

/** One track as a backend receives it: the device's own track and what runs on it. */
export interface HandedOverTrack {
  track: MediaStreamTrack;
  /** What it was opened with, for a backend that restarts it. */
  constraints: MediaTrackConstraints;
  muted: boolean;
  /** Where a processor runs: it and its output, to adopt rather than initialise again. */
  processor?: { processor: VideoProcessor; processedTrack: MediaStreamTrack };
}
