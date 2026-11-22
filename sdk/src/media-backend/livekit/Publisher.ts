/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  LocalAudioTrack,
  type LocalTrackPublication,
  LocalVideoTrack,
  ParticipantEvent,
  type Room as LivekitRoom,
  Track,
} from "livekit-client";
import { type Logger } from "matrix-js-sdk/lib/logger";

import {
  type HandedOverTrack,
  type LocalMedia,
  type MediaSource,
  type PublishRequest,
} from "../../media-api";
import { livekitSources, mediaSources } from "./LivekitMediaTrack";
import { toLivekitProcessor } from "./videoProcessor";
import {
  audioCaptureOptions,
  screenShareAudioDeviceConstraints,
  screenShareAudioPublishOptions,
  screenShareCaptureOptions,
  screenSharePublishOptions,
  videoCaptureOptions,
  videoPublishOptions,
} from "./publishOptions";

/** What the host asked to publish, kept across publishers for a reconnection. */
export interface DesiredPublication {
  request: PublishRequest;
  enabled: boolean;
}

export type DesiredMedia = Map<MediaSource, DesiredPublication>;

/** A lobby's tracks, moved out of its media, until each is published. */
export type HandedOverTracks = ReturnType<LocalMedia["takeTracks"]>;

/**
 * Publishes the local media on one LiveKit room, following the host's
 * requests.
 *
 * LiveKit publishes a track the moment it is created, but a member must not be
 * heard before it has joined the MatrixRTC session, nor after it has left. The
 * tracks are therefore kept, and their upstream paused, while `shouldPublish`
 * is false: the local preview stays live while nothing reaches the room.
 */
export class Publisher {
  public shouldPublish = false;
  /** Whether the initial requests have been published; `publish` is immediate from then on. */
  public started = false;
  private readonly room: LivekitRoom;

  /** A lobby's tracks, taken over at `start`; each leaves the map as it is published. */
  private captured: HandedOverTracks = new Map();

  /** The screen share being started, so that a second request joins the first. */
  private screenSharePending: Promise<LocalTrackPublication> | undefined;
  /** The audio device opened to carry a screen share's audio, to be closed with it. */
  private screenShareAudioDevice: MediaStreamTrack | undefined;

  /**
   * @param media - What a lobby opened ahead of the join, published in place
   * of capturing. Taken over only at `start`, so that a publisher torn down
   * before it publishes leaves the tracks to the next one.
   */
  public constructor(
    room: LivekitRoom,
    private readonly desired: DesiredMedia,
    private readonly logger: Logger,
    private readonly media?: LocalMedia,
  ) {
    this.room = room;
    room.setE2EEEnabled(room.options.e2ee !== undefined)?.catch((e: Error) => {
      this.logger.error("Failed to enable E2EE on the room", e);
    });
    this.onLocalTrackPublished = this.onLocalTrackPublished.bind(this);
    room.localParticipant.on(
      ParticipantEvent.LocalTrackPublished,
      this.onLocalTrackPublished,
    );
    this.onLocalTrackUnpublished = this.onLocalTrackUnpublished.bind(this);
    room.localParticipant.on(
      ParticipantEvent.LocalTrackUnpublished,
      this.onLocalTrackUnpublished,
    );
  }

  public async destroy(): Promise<void> {
    this.room.localParticipant.off(
      ParticipantEvent.LocalTrackPublished,
      this.onLocalTrackPublished,
    );
    this.room.localParticipant.off(
      ParticipantEvent.LocalTrackUnpublished,
      this.onLocalTrackUnpublished,
    );
    this.stopScreenShareAudioDevice();
    try {
      for (const { track } of this.publications())
        if (track) await this.room.localParticipant.unpublishTrack(track, true);
    } catch (e) {
      this.logger.error("Failed to stop the local tracks", e);
    }
  }

  /** Publishes what the host asked for, less what it has muted since. Safe to call more than once. */
  public start(): void {
    if (this.started) return;
    this.started = true;
    this.captured = this.media?.takeTracks() ?? new Map();
    // A track muted in the lobby joins muted
    for (const [source, { muted }] of this.captured) {
      const wanted = this.desired.get(source);
      if (wanted && muted) wanted.enabled = false;
    }
    const requests = [...this.desired.values()]
      .filter(
        ({ request, enabled }) => enabled || this.hasCaptured(request.source),
      )
      .map(({ request }) => request);
    const toCapture = new Set(
      requests
        .map((request) => request.source)
        .filter((source) => !this.hasCaptured(source)),
    );
    // Microphone and camera in one call so that the browser asks for
    // permission once; the room defaults carry their options. LiveKit
    // resolves these once the track is published, which may block on the
    // connection; LocalTrackPublished is what tells us a track exists.
    const captureBoth = toCapture.has("microphone") && toCapture.has("camera");
    if (captureBoth) {
      this.takeCaptureDefaults(requests);
      void this.room.localParticipant.enableCameraAndMicrophone();
    }
    for (const request of requests)
      if (
        request.source === "screenShare" ||
        this.hasCaptured(request.source) ||
        !captureBoth
      )
        this.publish(request).catch((e) => {
          this.logger.error(`Failed to publish the ${request.source}`, e);
        });
  }

  /**
   * Makes the requests the room's capture defaults. The room took its defaults
   * from the requests at the join, but one made since, such as a camera turned
   * on before the start, has options of its own: a video processor dropped
   * here would let the room see the camera before it is applied.
   */
  private takeCaptureDefaults(requests: PublishRequest[]): void {
    const options = this.room.options;
    for (const request of requests)
      if (request.source === "microphone")
        options.audioCaptureDefaults = {
          ...options.audioCaptureDefaults,
          ...audioCaptureOptions(request),
        };
      else if (request.source === "camera")
        options.videoCaptureDefaults = {
          ...options.videoCaptureDefaults,
          ...videoCaptureOptions(request),
        };
  }

  private hasCaptured(source: MediaSource): boolean {
    return (
      (source === "microphone" || source === "camera") &&
      this.captured.has(source)
    );
  }

  private takeCaptured(request: PublishRequest): HandedOverTrack | undefined {
    if (request.source === "screenShare") return undefined;
    const track = this.captured.get(request.source);
    this.captured.delete(request.source);
    return track;
  }

  /** A lobby's track as if this participant had captured it: LiveKit restarts and stops it as its own. */
  private async adopt(
    { track, constraints, muted, processor }: HandedOverTrack,
    request: PublishRequest,
  ): Promise<LocalTrackPublication> {
    const local =
      track.kind === "audio"
        ? new LocalAudioTrack(track, constraints, false)
        : new LocalVideoTrack(track, constraints, false);
    if (muted) await local.mute();
    if (processor && local instanceof LocalVideoTrack)
      await local.setProcessor(
        toLivekitProcessor(processor.processor, processor.processedTrack),
      );
    return this.room.localParticipant.publishTrack(local, {
      source: livekitSources[request.source],
      ...(request.source === "camera" && videoPublishOptions(request.capture)),
    });
  }

  /** Publishes one request and resolves with its publication once LiveKit has it. */
  public async publish(
    request: PublishRequest,
  ): Promise<LocalTrackPublication | undefined> {
    const participant = this.room.localParticipant;
    let publication: LocalTrackPublication | undefined;
    const captured = this.takeCaptured(request);
    if (captured) publication = await this.adopt(captured, request);
    else if (request.source === "microphone")
      publication = await participant.setMicrophoneEnabled(
        true,
        audioCaptureOptions(request),
      );
    else if (request.source === "camera")
      publication = await participant.setCameraEnabled(
        true,
        videoCaptureOptions(request),
        videoPublishOptions(request.capture),
      );
    else publication = await this.publishScreenShare(request);
    // Until the member has joined, the upstream has to stay paused
    if (!this.shouldPublish) await this.pauseUpstreams();
    return publication;
  }

  /**
   * Captures and publishes a screen share. Done in two steps rather than
   * with LiveKit's `setScreenShareEnabled` so that the encoding can follow
   * the size the user picked, which is unknown until the capture, and so that
   * the audio can come from a device of its own.
   */
  private async publishScreenShare(
    request: Extract<PublishRequest, { source: "screenShare" }>,
  ): Promise<LocalTrackPublication> {
    this.screenSharePending ??= this.captureAndPublishScreenShare(
      request,
    ).finally(() => (this.screenSharePending = undefined));
    return this.screenSharePending;
  }

  private async captureAndPublishScreenShare(
    request: Extract<PublishRequest, { source: "screenShare" }>,
  ): Promise<LocalTrackPublication> {
    const participant = this.room.localParticipant;
    const tracks = await participant.createScreenTracks(
      screenShareCaptureOptions(request),
    );
    const video = tracks.find(
      (track): track is LocalVideoTrack => track.kind === Track.Kind.Video,
    );
    const systemAudio = tracks.find((track) => track.kind === Track.Kind.Audio);
    if (video === undefined) {
      for (const track of tracks) track.stop();
      throw new Error("The screen capture has no video");
    }
    let publication: LocalTrackPublication;
    try {
      publication = await participant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        ...screenSharePublishOptions(
          request.capture,
          video.mediaStreamTrack.getSettings(),
        ),
      });
    } catch (e) {
      for (const track of tracks) track.stop();
      throw e;
    }
    // LiveKit replaces the hint with `motion` for the codecs it publishes
    // with SVC (VP9, AV1), as a workaround for a frame rate limit in Chrome.
    // For the others, whatever it was set to is put back.
    const hint = request.capture?.contentHint;
    const codec = request.capture?.codec;
    if (
      hint !== undefined &&
      codec !== "vp9" &&
      codec !== "av1" &&
      "contentHint" in video.mediaStreamTrack &&
      video.mediaStreamTrack.contentHint !== hint
    )
      video.mediaStreamTrack.contentHint = hint;

    // The audio is an extra: the share goes ahead without it
    try {
      if (
        typeof request.audio === "object" &&
        request.audio.kind === "device"
      ) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: screenShareAudioDeviceConstraints(request.audio.deviceId),
        });
        const [device] = stream.getAudioTracks();
        this.screenShareAudioDevice = device;
        // The share may have been stopped while the device was opened
        if (participant.getTrackPublication(Track.Source.ScreenShare))
          await participant.publishTrack(
            device,
            screenShareAudioPublishOptions,
          );
        else this.stopScreenShareAudioDevice();
      } else if (systemAudio !== undefined)
        await participant.publishTrack(
          systemAudio,
          screenShareAudioPublishOptions,
        );
    } catch (e) {
      this.logger.error("Failed to publish the screen share's audio", e);
      systemAudio?.stop();
      this.stopScreenShareAudioDevice();
    }
    return publication;
  }

  private stopScreenShareAudioDevice(): void {
    this.screenShareAudioDevice?.stop();
    this.screenShareAudioDevice = undefined;
  }

  /**
   * A screen share ends without us where the user stops it from the
   * browser's or the desktop's own controls. Its audio, which LiveKit only
   * takes down with a share it stopped itself, must not outlive it.
   */
  private onLocalTrackUnpublished(publication: LocalTrackPublication): void {
    if (publication.source !== Track.Source.ScreenShare) return;
    const participant = this.room.localParticipant;
    const audio = participant.getTrackPublication(
      Track.Source.ScreenShareAudio,
    )?.track;
    if (audio)
      participant.unpublishTrack(audio, true).catch((e) => {
        this.logger.error("Failed to stop the screen share's audio", e);
      });
    this.stopScreenShareAudioDevice();
  }

  public async unpublish(source: MediaSource): Promise<void> {
    const participant = this.room.localParticipant;
    // Takes the screen share audio with it
    if (source === "screenShare") {
      await participant.setScreenShareEnabled(false);
      this.stopScreenShareAudioDevice();
      return;
    }
    const track = participant.getTrackPublication(
      livekitSources[source],
    )?.track;
    if (track) await participant.unpublishTrack(track, true);
  }

  /**
   * Mutes or unmutes a source and reports what resulted: the request where
   * it succeeded, the state LiveKit is left in where it did not (a denied
   * permission, a missing device).
   */
  public async setEnabled(
    source: MediaSource,
    enabled: boolean,
  ): Promise<boolean> {
    const participant = this.room.localParticipant;
    const livekitSource = livekitSources[source];
    try {
      if (source === "microphone")
        await participant.setMicrophoneEnabled(enabled);
      else if (source === "camera") await participant.setCameraEnabled(enabled);
      else {
        const publication = participant.getTrackPublication(livekitSource);
        if (!publication) return false;
        if (enabled) await publication.unmute();
        else await publication.mute();
      }
      // Unmuting restarts the upstream; until the member has joined, it has
      // to stay paused
      if (enabled && !this.shouldPublish) await this.pauseUpstreams();
      return enabled;
    } catch (e) {
      this.logger.error(`Failed to set ${source} enabled=${enabled}`, e);
      return !(participant.getTrackPublication(livekitSource)?.isMuted ?? true);
    }
  }

  public async startPublishing(): Promise<void> {
    if (this.shouldPublish) return;
    this.shouldPublish = true;
    // Enabling a track does not resume an upstream that was paused while it
    // was already enabled, so it is done explicitly
    for (const { track } of this.publications())
      if (track?.isUpstreamPaused) await track.resumeUpstream();
  }

  public async stopPublishing(): Promise<void> {
    this.shouldPublish = false;
    await this.pauseUpstreams();
  }

  private onLocalTrackPublished(publication: LocalTrackPublication): void {
    this.logger.info(`Local ${publication.source} track published`);
    if (!this.shouldPublish)
      this.pauseUpstreams().catch((e) => {
        this.logger.error("Failed to pause the upstream", e);
      });
    // The host may have changed its mind while the track was being created
    const source = mediaSources[publication.source as Track.Source];
    if (this.desired.get(source)?.enabled === false)
      void this.setEnabled(source, false);
  }

  private async pauseUpstreams(): Promise<void> {
    for (const { track } of this.publications())
      if (track && !track.isUpstreamPaused) await track.pauseUpstream();
  }

  private publications(): LocalTrackPublication[] {
    return [...this.room.localParticipant.trackPublications.values()];
  }

  /**
   * Works on a room that is still connecting too: LiveKit keeps the device
   * in the room's options and gives it to every participant that arrives.
   */
  public async setAudioOutputDevice(deviceId: string): Promise<void> {
    if (this.room.getActiveDevice("audiooutput") === deviceId) return;
    await this.room.switchActiveDevice("audiooutput", deviceId);
  }
}
