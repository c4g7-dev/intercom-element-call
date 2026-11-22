/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  observeParticipantEvents,
  observeParticipantMedia,
  roomEventSelector,
} from "@livekit/components-core";
import {
  type LocalParticipant,
  LocalTrack,
  LocalVideoTrack,
  type Participant,
  ParticipantEvent,
  RemoteAudioTrack,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  type ElementInfo,
  type Room as LivekitRoom,
  RoomEvent,
  Track,
  TrackEvent,
  type TrackPublication,
} from "livekit-client";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  fromEvent,
  map,
  merge,
  type Observable,
  of,
  startWith,
  switchMap,
  timer,
} from "rxjs";

import { type Behavior } from "../../reactive/Behavior";
import { type ObservableScope } from "../../reactive/ObservableScope";
import {
  type AudioMediaTrack,
  type LocalAudioMediaTrack,
  type LocalVideoMediaTrack,
  type MediaSource,
  type MediaStreamStats,
  type MediaTrack,
  type TrackDiagnostics,
  type VideoMediaTrack,
} from "../../media-api";
import { MatrixRTCError } from "../../errors";
import { facingModeOf } from "../../utils/facingMode";
import { toLivekitProcessor, type LivekitProcessor } from "./videoProcessor";

export const mediaSources: Record<Track.Source, MediaSource> = {
  [Track.Source.Microphone]: "microphone",
  [Track.Source.Camera]: "camera",
  [Track.Source.ScreenShare]: "screenShare",
  [Track.Source.ScreenShareAudio]: "screenShareAudio",
  [Track.Source.Unknown]: "unknown",
};

export const livekitSources: Record<MediaSource, Track.Source> = {
  microphone: Track.Source.Microphone,
  camera: Track.Source.Camera,
  screenShare: Track.Source.ScreenShare,
  screenShareAudio: Track.Source.ScreenShareAudio,
  unknown: Track.Source.Unknown,
};

/**
 * One publication of a participant as a `MediaTrack`. The publication is
 * fixed; the track behind it may come and go (a remote track arrives on
 * subscription), and every attached element follows it.
 */
export function createLivekitMediaTrack(
  scope: ObservableScope,
  participant: Participant,
  publication: TrackPublication,
  room: LivekitRoom,
): AudioMediaTrack | VideoMediaTrack {
  const mediaChanged$ = observeParticipantMedia(participant);
  const track$ = publicationTrack$(scope, participant, publication);

  const attached = new Set<HTMLMediaElement>();
  let audioContext: AudioContext | undefined;
  let audioPlugins: AudioNode[] = [];
  let volume: number | undefined;
  const applyAudioSettings = (track: Track | undefined): void => {
    if (!(track instanceof RemoteAudioTrack)) return;
    // An element plays no louder than 1. Above that the track is played
    // through a gain node instead, on a context of our own where the host
    // gave none; at or below, it stays on the element, which is what the
    // browser's echo canceller and output device selection know best.
    const context =
      audioContext ??
      (volume !== undefined && volume > 1 ? boostContext(room) : undefined);
    const gain = Number.isFinite(volume)
      ? Math.max(0, volume as number)
      : undefined;
    // LiveKit remembers the last volume and writes it to the elements as it
    // leaves a context, so a gain above 1 has to be taken back while the
    // track is still on the context: an element given more than 1 throws
    if (context === undefined && gain !== undefined)
      track.setVolume(elementVolume(gain));
    track.setAudioContext(context);
    track.setWebAudioPlugins(audioPlugins);
    if (gain !== undefined)
      track.setVolume(context ? gain : elementVolume(gain));
  };

  // Requests for the best quality, as one element of the size of the largest
  // screen there could be: LiveKit's adaptive stream picks the layer by the
  // largest visible element a track is attached to
  let highQualityRequests = 0;
  const highQualityElement: ElementInfo = {
    element: {},
    width: () => 7680,
    height: () => 4320,
    visible: true,
    visibilityChangedAt: undefined,
    pictureInPicture: false,
    observe: () => {},
    stopObserving: () => {},
  };
  const applyHighQuality = (track: Track | undefined, on: boolean): void => {
    if (!(track instanceof RemoteVideoTrack)) return;
    try {
      if (on) track.observeElementInfo(highQualityElement);
      else track.stopObservingElementInfo(highQualityElement);
    } catch {
      // A track that is not adaptive has nothing to pin
    }
  };

  let current = track$.value;
  track$.pipe(scope.bind()).subscribe((track) => {
    for (const element of attached) current?.detach(element);
    if (highQualityRequests > 0) applyHighQuality(current, false);
    current = track;
    applyAudioSettings(track);
    for (const element of attached) track?.attach(element);
    if (highQualityRequests > 0) applyHighQuality(track, true);
  });
  scope.onEnd(() => {
    for (const element of attached) current?.detach(element);
    attached.clear();
  });

  const muted$ = scope.behavior(
    mediaChanged$.pipe(map(() => publication.isMuted)),
    publication.isMuted,
  );
  const base: MediaTrack = {
    source: mediaSources[publication.source],
    kind: publication.kind === Track.Kind.Audio ? "audio" : "video",
    id: publication.trackSid,
    muted$,
    encrypted: publication.isEncrypted,
    stats$: (intervalMs): Observable<MediaStreamStats> =>
      timer(0, intervalMs).pipe(
        switchMap(async () => rtpStreamStats(publication, participant.isLocal)),
        scope.bind(),
      ),
    diagnostics: async () => trackDiagnostics(publication),
    attach: (element) => {
      if (attached.has(element)) return;
      attached.add(element);
      current?.attach(element);
    },
    detach: (element) => {
      if (!attached.delete(element)) return;
      current?.detach(element);
    },
  };

  if (base.kind === "audio")
    return {
      ...base,
      kind: "audio",
      // LiveKit detects speakers per participant, so this is the member's
      // activity, narrowed to the tracks that can be carrying it
      isActive$: scope.behavior(
        combineLatest(
          [
            observeParticipantEvents(
              participant,
              ParticipantEvent.IsSpeakingChanged,
            ).pipe(map((p) => p.isSpeaking)),
            muted$,
          ],
          (speaking, muted) => speaking && !muted,
        ),
        participant.isSpeaking && !publication.isMuted,
      ),
      // The level has no event of its own: it is written to the participant
      // with each speaker update, which the room announces
      audioLevel$: scope.behavior(
        combineLatest(
          [
            roomEventSelector(room, RoomEvent.ActiveSpeakersChanged).pipe(
              map(() => participant.audioLevel),
              startWith(participant.audioLevel),
            ),
            muted$,
          ],
          (level, muted) => (muted ? 0 : level),
        ),
      ),
      setAudioContext: (ctx, plugins = []) => {
        audioContext = ctx;
        audioPlugins = plugins;
        applyAudioSettings(current);
      },
      setVolume: (v) => {
        // Our own audio is never played back, so there is nothing to scale
        volume = v;
        applyAudioSettings(current);
      },
    };

  // Not a scope behavior: this one says so when the publication is gone, by
  // going back to undefined as the scope ends
  const mediaStreamTrack$ = new BehaviorSubject<MediaStreamTrack | undefined>(
    current?.mediaStreamTrack,
  );
  track$
    .pipe(
      switchMap((track) =>
        track === undefined
          ? of(undefined)
          : !(track instanceof LocalTrack)
            ? of(track.mediaStreamTrack)
            : // A local track is replaced on a restart (another device, a processor)
              merge(
                fromEvent(track, TrackEvent.Restarted),
                fromEvent(track, TrackEvent.TrackProcessorUpdate),
              ).pipe(
                startWith(null),
                map(() => track.mediaStreamTrack),
              ),
      ),
      distinctUntilChanged(),
      scope.bind(),
    )
    .subscribe((track) => mediaStreamTrack$.next(track));
  scope.onEnd(() => mediaStreamTrack$.next(undefined));

  return {
    ...base,
    kind: "video",
    mediaStreamTrack$,
    requestHighQuality: () => {
      if (highQualityRequests++ === 0) applyHighQuality(current, true);
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        if (--highQualityRequests === 0) applyHighQuality(current, false);
      };
    },
  };
}

/**
 * The volume an element can be given for a playback gain: an element takes
 * [0, 1] and throws for anything else, more than 1 is the gain node's job.
 */
export function elementVolume(gain: number): number {
  return Number.isFinite(gain) ? Math.min(Math.max(gain, 0), 1) : 1;
}

let sharedBoostContext: AudioContext | undefined;
/**
 * The context tracks louder than 1 are played on: one for the page, made on
 * first use (by then the user has interacted with the page, which a context
 * needs to start) and sent to the room's output device where it has one.
 */
function boostContext(room: LivekitRoom): AudioContext | undefined {
  if (typeof AudioContext === "undefined") return undefined;
  if (sharedBoostContext === undefined || sharedBoostContext.state === "closed")
    sharedBoostContext = new AudioContext({ latencyHint: "interactive" });
  const context = sharedBoostContext;
  if (context.state === "suspended") context.resume().catch(() => undefined);
  const sink = room.getActiveDevice("audiooutput");
  const withSink = context as AudioContext & {
    sinkId?: string;
    setSinkId?: (id: string) => Promise<void>;
  };
  if (sink && sink !== "default" && withSink.sinkId !== sink)
    withSink.setSinkId?.(sink).catch(() => undefined);
  return context;
}

/**
 * One of our own publications, with the controls over it. `setEnabled` goes
 * through the local member so that what it remembers for a reconnection
 * stays in step.
 */
export function createLocalLivekitMediaTrack(
  scope: ObservableScope,
  participant: LocalParticipant,
  publication: TrackPublication,
  room: LivekitRoom,
  setEnabled: (source: MediaSource, enabled: boolean) => Promise<boolean>,
): LocalAudioMediaTrack | LocalVideoMediaTrack {
  const base = createLivekitMediaTrack(scope, participant, publication, room);
  const local = {
    setEnabled: async (enabled: boolean) => setEnabled(base.source, enabled),
    setDevice: async (deviceId: string): Promise<void> => {
      if (base.source !== "microphone" && base.source !== "camera")
        throw new MatrixRTCError(`A ${base.source} track has no device`);
      // LiveKit decides whether to restart by the constraints it keeps, which
      // a browser that does not echo the device id back (Firefox) leaves
      // without one; a track already on the device is left alone here. Asked
      // of the camera track itself: with a processor on, LiveKit's media
      // stream track is the processed one, which names no device
      const current = publication.track;
      if (
        current instanceof LocalTrack &&
        (await current.getDeviceId(false)) === deviceId
      )
        return;
      // THE FIX for "cannot switch cameras in Chrome" (#4479), switching in
      // the call. No third argument: LiveKit then asks for the device with
      // `exact`. Passing `false` there made it a wish, which Chromium ignores
      // by reopening its default device.
      await room.switchActiveDevice(
        base.kind === "audio" ? "audioinput" : "videoinput",
        deviceId,
      );
      // A check that the switch really happened, so that a failure is an
      // error and not silence. Asked of the track again rather than taken
      // from LiveKit's answer, which compares against the processed track
      // too. A muted track is stopped and takes the device on turning on again
      const now = publication.track;
      const deviceNow =
        now instanceof LocalTrack && !now.isMuted
          ? await now.getDeviceId(false)
          : undefined;
      if (deviceNow !== undefined && deviceNow !== deviceId)
        throw new MatrixRTCError(
          `The ${base.source} is on another device than the one asked for`,
        );
    },
  };
  if (base.kind === "audio") return { ...base, ...local };

  const videoTrack = (): LocalVideoTrack | undefined =>
    publication.track instanceof LocalVideoTrack
      ? publication.track
      : undefined;
  return {
    ...base,
    ...local,
    facingMode$: facingMode$(
      scope,
      publicationTrack$(scope, participant, publication),
    ),
    switchFacingMode: async () => {
      const track = videoTrack();
      if (!track) return;
      await track.restartTrack({
        facingMode:
          facingModeOf(sourceTrack(track)) === "user" ? "environment" : "user",
      });
      return track.mediaStreamTrack.getSettings().deviceId;
    },
    setEncodingLimits: async ({ maxBitrate, maxFramerate }) => {
      const sender = videoTrack()?.sender;
      if (!sender) return false;
      const params = sender.getParameters();
      if (!params.encodings?.length) return false;
      // The full layer is the last one; a screen share has only the one
      const encoding = params.encodings[params.encodings.length - 1];
      if (
        (maxBitrate === undefined || encoding.maxBitrate === maxBitrate) &&
        (maxFramerate === undefined || encoding.maxFramerate === maxFramerate)
      )
        return true;
      if (maxBitrate !== undefined) encoding.maxBitrate = maxBitrate;
      if (maxFramerate !== undefined) encoding.maxFramerate = maxFramerate;
      await sender.setParameters(params);
      return true;
    },
    dimensions: () => {
      const settings = videoTrack()?.mediaStreamTrack.getSettings();
      return settings?.width && settings.height
        ? { width: settings.width, height: settings.height }
        : undefined;
    },
    setProcessor: async (processor) => {
      const track = videoTrack();
      // A camera that is off has a stopped track and takes the processor on
      // turning on again; one stopped for good takes none
      if (
        !track ||
        (track.mediaStreamTrack.readyState === "ended" && !track.isMuted)
      )
        return;
      const current = track.getProcessor() as LivekitProcessor | undefined;
      if (processor === current?.source) return;
      if (processor) await track.setProcessor(toLivekitProcessor(processor));
      else if (current) await track.stopProcessor();
    },
  };
}

/** The track behind a publication; a remote one arrives on subscription. */
function publicationTrack$(
  scope: ObservableScope,
  participant: Participant,
  publication: TrackPublication,
): Behavior<Track | undefined> {
  return scope.behavior(
    merge(
      observeParticipantMedia(participant),
      fromEvent(publication, TrackEvent.Subscribed),
      fromEvent(publication, TrackEvent.Unsubscribed),
    ).pipe(
      map(() => publication.track),
      startWith(publication.track),
      distinctUntilChanged(),
    ),
  );
}

async function rtpStreamStats(
  publication: TrackPublication,
  local: boolean,
): Promise<MediaStreamStats> {
  const track = publication.track;
  if (!(track instanceof RemoteTrack || track instanceof LocalTrack))
    return undefined;
  const report = await track.getRTCStatsReport();
  if (!report) return undefined;
  const type = local ? "outbound-rtp" : "inbound-rtp";
  for (const stats of report.values()) if (stats.type === type) return stats;
  return undefined;
}

async function trackDiagnostics(
  publication: TrackPublication,
): Promise<TrackDiagnostics | undefined> {
  const track = publication.track;
  if (!(track instanceof RemoteTrack || track instanceof LocalTrack))
    return undefined;
  const report = await track.getRTCStatsReport();
  const mediaTrack = track.mediaStreamTrack;
  const settings = mediaTrack.getSettings?.() ?? {};
  const info = publication.trackInfo;
  return {
    stats: report
      ? Array.from(report.values() as Iterable<Record<string, unknown>>)
      : [],
    track: {
      contentHint: mediaTrack.contentHint,
      readyState: mediaTrack.readyState,
      enabled: mediaTrack.enabled,
      muted: mediaTrack.muted,
      label: mediaTrack.label,
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      sampleRate: settings.sampleRate,
      channelCount: settings.channelCount,
    },
    ...(track instanceof LocalTrack && { sender: senderDiagnostics(track) }),
    published: {
      simulcast: publication.simulcasted ?? false,
      width: publication.dimensions?.width,
      height: publication.dimensions?.height,
      layers: (info?.layers ?? []).map((layer) => ({
        quality: layer.quality,
        width: layer.width,
        height: layer.height,
        bitrate: layer.bitrate,
      })),
    },
    ...(publication instanceof RemoteTrackPublication && {
      subscription: {
        subscribed: publication.isSubscribed,
        enabled: publication.isEnabled,
        requestedQuality: publication.videoQuality,
        streamState:
          track instanceof RemoteTrack ? track.streamState : undefined,
      },
    }),
  };
}

function senderDiagnostics(track: LocalTrack): TrackDiagnostics["sender"] {
  let params: RTCRtpSendParameters | undefined;
  try {
    params = track.sender?.getParameters();
  } catch {
    // A sender that is being torn down has nothing to say
  }
  return {
    degradationPreference: params?.degradationPreference,
    encodings: (params?.encodings ?? []).map((encoding) => ({
      rid: encoding.rid,
      active: encoding.active,
      maxBitrate: encoding.maxBitrate,
      maxFramerate: encoding.maxFramerate,
      scaleResolutionDownBy: encoding.scaleResolutionDownBy,
      scalabilityMode: (encoding as { scalabilityMode?: string })
        .scalabilityMode,
      priority: encoding.priority,
    })),
    upstreamPaused: track.isUpstreamPaused,
  };
}

/**
 * The camera's own track. While a processor runs LiveKit's media stream track
 * is the processed one, which says nothing of the camera.
 */
function sourceTrack(track: LocalVideoTrack): MediaStreamTrack {
  return track.mediaStream?.getVideoTracks()[0] ?? track.mediaStreamTrack;
}

function facingMode$(
  scope: ObservableScope,
  track$: Behavior<Track | undefined>,
): Behavior<"user" | "environment" | undefined> {
  return scope.behavior(
    track$.pipe(
      switchMap((track) => {
        if (!(track instanceof LocalVideoTrack)) return of(undefined);
        return fromEvent(track, TrackEvent.Restarted).pipe(
          startWith(null),
          map(() => facingModeOf(sourceTrack(track))),
        );
      }),
    ),
  );
}
