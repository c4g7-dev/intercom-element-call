/*
Copyright 2025 Element Creations Ltd.
Copyright 2023, 2024, 2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  type AudioCaptureSettings,
  type Behavior,
  constant,
  type DisconnectReason,
  type EncryptionSystem,
  generateItems,
  type LocalAudioMediaTrack,
  type LocalRTCMember,
  type LocalVideoMediaTrack,
  type RTCParticipation,
  type ObservableScope,
  pauseWhen,
  type PublishRequest,
  type RemoteRTCMember,
  screenShareBitrate,
  screenShareScale,
  trackBySource$,
  type TransportMetadata,
  type VideoCaptureSettings,
  type VideoProcessor,
} from "@element-hq/matrixrtc-sdk";
import {
  KnownMembership,
  type Room as MatrixRoom,
  type RoomMember,
  RoomStateEvent,
} from "matrix-js-sdk";
import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  filter,
  firstValueFrom,
  fromEvent,
  map,
  merge,
  NEVER,
  type Observable,
  of,
  pairwise,
  race,
  scan,
  startWith,
  Subject,
  switchMap,
  switchScan,
  take,
  tap,
  throttleTime,
  timer,
  takeUntil,
} from "rxjs";
import { logger as rootLogger } from "matrix-js-sdk/lib/logger";

import { createToggle$ } from "../../utils/observable";
import {
  duplicateTiles,
  playReactionsSound,
  showReactions,
  screenShareAudioMix,
} from "../../settings/settings";
import { isFirefox, platform } from "../../Platform";
import { setPipEnabled$ } from "../../controls";
import { TileStore } from "../TileStore";
import { gridLikeLayout } from "../GridLikeLayout";
import { spotlightExpandedLayout } from "../SpotlightExpandedLayout";
import { oneOnOneDesktopLayout } from "../OneOnOneDesktopLayout";
import { oneOnOneMobileLayout } from "../OneOnOneMobileLayout";
import { pipLayout } from "../PipLayout";
import { equalGridLayout, type EqualGridShareTiles } from "../EqualGridLayout";
import {
  type RaisedHandInfo,
  type ReactionInfo,
  type ReactionOption,
} from "../../reactions";
import { type BackgroundEffectsState } from "../BackgroundEffects";
import { shallowEquals as arrayShallowEquals } from "../../utils/array";
import { type MediaDevices } from "../MediaDevices";
import {
  screenShareChoices,
  screenShareLimitsForBudget,
  screenShareRequest,
} from "../screenShareOptions";
import { type HostParticipantState, hostParticipants$ } from "../hostCallState";
import { type SoundRoster, soundRoster } from "../callEventSounds";
import { shareAudioMix, shareAudioMode } from "../shareAudioSink";
import { createShareAudioMix, mixSourceKinds } from "../shareAudioMixer";
import { type MuteStates } from "../MuteStates";
import {
  recordCallDiagnostics,
  type ShareDiagnostics,
} from "../../diagnostics/CallDiagnostics";
import { describeError, diag } from "../../diagnostics/diag";
import {
  followDevice,
  followMuteState,
  followProcessor,
  type TrackSupply,
} from "../localMediaControls";
import { HeaderStyle, type UrlParams } from "../../UrlParams";
import { type HostBridge, nullHostBridge } from "../../HostBridge";
import {
  layoutShallowEquals,
  type Layout,
  type LayoutMedia,
  type WindowMode,
} from "../layout-types.ts";
import {
  chooseSpotlightSpeaker,
  computeLayoutMedia,
  findFocusedMedia,
  computeSpotlight,
  type OneOnOneMedia,
} from "../layoutMedia.ts";
import {
  type ElementCallError,
  fromMatrixRTCError,
  UnknownCallError,
} from "../../utils/errors.ts";
import { PosthogAnalytics } from "../../analytics/PosthogAnalytics.ts";
import {
  type AutoLeaveReason,
  type CallNotificationWrapper,
  createCallNotificationLifecycle$,
  createReceivedDecline$,
} from "./CallNotificationLifecycle.ts";
import {
  type LayoutSwitchViewModel,
  createLayoutSwitchViewModel,
} from "../LayoutSwitchViewModel.ts";
import {
  createWrappedUserMedia,
  type WrappedUserMediaViewModel,
} from "../media/WrappedUserMediaViewModel.ts";
import { type ScreenShareViewModel } from "../media/ScreenShareViewModel.ts";
import { type UserMediaViewModel } from "../media/UserMediaViewModel.ts";
import { type MediaViewModel } from "../media/MediaViewModel.ts";
import { type LocalUserMediaViewModel } from "../media/LocalUserMediaViewModel.ts";
import { type RemoteUserMediaViewModel } from "../media/RemoteUserMediaViewModel.ts";
import {
  createRingingMedia,
  type RingingMediaViewModel,
} from "../media/RingingMediaViewModel.ts";
import { type GridTileViewModel } from "../TileViewModel.ts";
import { createFloatingTile } from "../FloatingTile.ts";

/** How a call captures and encodes the tracks it publishes. */
export interface CaptureSettings {
  audio?: AudioCaptureSettings;
  camera?: VideoCaptureSettings;
  screenShare?: VideoCaptureSettings;
}

/**
 * What to publish for a microphone or camera: the device the user picked, the
 * host's capture settings and, for the camera, the video processor, so that
 * the track starts with it rather than letting the room through while it is
 * built.
 */
export function publishRequest(
  source: "microphone" | "camera",
  mediaDevices: MediaDevices,
  capture: CaptureSettings,
  processor?: VideoProcessor,
): PublishRequest {
  return source === "microphone"
    ? {
        source,
        deviceId: mediaDevices.audioInput.selected$.value?.id,
        capture: capture.audio,
      }
    : {
        source,
        deviceId: mediaDevices.videoInput.selected$.value?.id,
        capture: capture.camera,
        ...(processor && { processor }),
      };
}

/** What the participation publishes at the join: the sources whose mute switch is on. */
export function initialPublishRequests(
  muteStates: MuteStates,
  mediaDevices: MediaDevices,
  capture: CaptureSettings,
  effects?: BackgroundEffectsState,
): PublishRequest[] {
  const requests: PublishRequest[] = [];
  if (muteStates.audio.enabled$.value)
    requests.push(publishRequest("microphone", mediaDevices, capture));
  // Left out while the processor is prepared; the call publishes it after
  if (muteStates.video.enabled$.value && effects?.wait !== "preparing")
    requests.push(
      publishRequest("camera", mediaDevices, capture, effects?.processor),
    );
  return requests;
}

/**
 * What the call is made of: the room, the participation, the devices, the
 * things with no sensible default. How the host wants it to behave is in
 * {@link CallViewModelOptions} instead.
 */
export interface CallViewModelProps {
  rtcParticipation: RTCParticipation;
  /** A call is permanently tied to a single Matrix room. */
  matrixRoom: MatrixRoom;
  mediaDevices: MediaDevices;
  muteStates: MuteStates;
  encryptionSystem: EncryptionSystem;
  /**
   * The size of the space the call is drawn in: the page when Element Call
   * owns it, or the container a host mounted it in when it is a component.
   * The layout — whether the call is shown full size, flat, narrow or as a
   * picture-in-picture — follows this rather than the size of the window, so
   * that a component shrunk by its host adapts even though the window has not
   * changed.
   */
  viewSize$: Behavior<{ width: number; height: number }>;
  handsRaisedSubject$: Observable<Record<string, RaisedHandInfo>>;
  reactionsSubject$: Observable<Record<string, ReactionInfo>>;
}

/**
 * How the host wants the call to behave. Every field is optional and defaults
 * to what standalone Element Call does, so `{}` is a working standalone call.
 * What the call is made of is in {@link CallViewModelProps} instead. A test
 * that wants to replace behaviour mocks the dependency it comes from rather
 * than adding an option here.
 */
export interface CallViewModelOptions {
  /**
   * How our tracks are captured and encoded; the browser's and LiveKit's
   * defaults otherwise.
   */
  capture?: CaptureSettings;
  /**
   * How much the media server may send for screen shares, in Mbit/s, shared
   * between the viewers of ours; 0 or nothing for no budget.
   */
  screenShareEgressBudgetMbps?: number;
  /** The background effects state (preparing, supported...) including the processor itself. */
  backgroundEffectsState$?: Behavior<BackgroundEffectsState>;
  /**
   * The application hosting Element Call, which can ask it to hang up and wants
   * to know when the user joins or leaves. Defaults to no host.
   */
  hostBridge?: HostBridge;
  /** The style of header to show. Defaults to {@link HeaderStyle.Standard}. */
  header?: HeaderStyle;
  /** Whether the call controls should be shown. Defaults to true. */
  showControls?: boolean;
  /** Whether to hide the screen-sharing button. Defaults to false. */
  hideScreensharing?: boolean;
  /**
   * Whether the host routes the audio itself, outside the browser, so that
   * the selected output device is never handed to the client. Defaults to
   * false.
   */
  controlledAudioDevices?: boolean;
  autoLeaveWhenOthersLeft?: boolean;
  /**
   * If the call is started in a way where we want it to behave like a telephone usecase
   * If we sent a notification event, we want the ui to show a ringing state
   */
  waitForCallPickup?: boolean;
  /**
   * The call notification the client sent with its join, for the ringing UI.
   * Defaults to none sent.
   */
  sentCallNotification$?: Observable<CallNotificationWrapper | null>;
}

/**
 * The options {@link createCallViewModel$} takes from the parameters Element
 * Call was started with.
 *
 * Callers share this rather than picking the fields out themselves. The
 * defaults on {@link CallViewModelOptions} describe a standalone Element Call,
 * so a widget or component caller that misses one does not get an error — it
 * quietly gets standalone behaviour instead.
 *
 * Note `autoLeaveWhenOthersLeft` and `waitForCallPickup` are deliberately not
 * here: unlike these, the view model never read them from the parameters
 * itself, so they remain the caller's decision.
 */
export function callViewModelOptionsFromParams(
  params: UrlParams,
): Pick<
  CallViewModelOptions,
  "header" | "showControls" | "hideScreensharing" | "controlledAudioDevices"
> {
  return {
    header: params.header,
    showControls: params.showControls,
    hideScreensharing: params.hideScreensharing,
    controlledAudioDevices: params.controlledAudioDevices,
  };
}

// Do not play any sounds if the participant count has exceeded this
// number.
export const MAX_PARTICIPANT_COUNT_FOR_SOUND = 8;
export const THROTTLE_SOUND_EFFECT_MS = 500;

// How long the footer should be shown for when hovering over or interacting
// with the interface
const showFooterMs = 4000;

interface LayoutScanState {
  layout: Layout | null;
  overflowing: boolean;
  tiles: TileStore;
}

/**
 * The return of createCallViewModel$
 * this interface represents the root source of data for the call view.
 * They are a list of observables and objects containing observables to allow for a very granular update mechanism.
 *
 * This allows to have one huge call view model that represents the entire view without a unnecessary amount of updates.
 *
 * (Mocking this interface should allow building a full view in all states.)
 */
export interface CallViewModel {
  // lifecycle
  autoLeave$: Observable<AutoLeaveReason>;
  /**
   * View model for info relating to ringing, timing out, calling back, etc.
   */
  ringingVm$: Behavior<RingingMediaViewModel | null>;
  /**
   * Which visual element the ringing status should be shown in.
   */
  ringingStatusLocation: "app_bar" | "tile";
  /** Observable that emits when the user should leave the call (hangup pressed, widget action, error).
   * THIS DOES NOT LEAVE THE CALL YET. The only way to leave the call (send the hangup event) is
   *  - by ending the scope
   *  - or calling requestDisconnect
   *
   * TODO: it seems more reasonable to add a leave() method (that calls requestDisconnect) that will then update leave$ and remove the hangup pattern
   */
  leave$: Observable<"user" | AutoLeaveReason>;
  /** Call to initiate hangup. Use in conbination with reconnection state track the async hangup process. */
  hangup: () => void;

  /** Leaves the participation. The leave can then be observed via `leave$`. */
  leave: () => void;
  // screen sharing
  /**
   * Callback to toggle screen sharing. If null, screen sharing is not possible.
   */
  toggleScreenSharing: (() => void) | null;
  /**
   * Whether we are sharing our screen.
   */
  sharingScreen$: Behavior<boolean>;
  /**
   * The last error from toggling screen sharing, until dismissed.
   */
  screenShareError$: Behavior<Error | null>;
  dismissScreenShareError: () => void;

  // UI interactions
  /**
   * Callback for when the user taps the call view.
   */
  tapScreen: () => void;
  /**
   * Callback for when the user taps the call's controls.
   */
  tapControls: () => void;
  /**
   * Callback for when the user hovers over the call view.
   */
  hoverScreen: () => void;
  /**
   * Callback for when the user stops hovering over the call view.
   */
  unhoverScreen: () => void;

  // errors
  /**
   * If there is a configuration error with the call (e.g. misconfigured E2EE).
   * This is a fatal error that prevents the call from being created/joined.
   * Should render a blocking error screen.
   */
  fatalError$: Behavior<ElementCallError | null>;

  // participants and counts
  /**
   * The number of participants currently in the call.
   *
   *  - Each participant has a corresponding MatrixRTC membership state event
   *  - There can be multiple participants for one Matrix user if they join from
   *    multiple devices.
   */
  participantCount$: Behavior<number>;
  /**
   * Whether the call has grown large enough that MatrixRTC has stopped rotating the media
   * encryption key. While this is true the key in use is still shared with new joiners, but no new
   * key is generated when someone joins or leaves.
   */
  keyRotationSuppressed$: Behavior<boolean>;
  /** The local member, once our membership has been seen in the room. */
  localMember$: Behavior<LocalRTCMember | null>;
  /** Our own camera track, while one is published. */
  camera$: Behavior<LocalVideoMediaTrack | undefined>;
  remoteMembers$: Behavior<RemoteRTCMember[]>;
  /**
   * InterCom: the members of the call as the host lists them: one entry per
   * user, with whether they speak, are muted or share a screen.
   */
  hostParticipants$: Observable<HostParticipantState[]>;
  /** The transports the client holds a connection to, for the developer panel. */
  connectedTransports$: Behavior<TransportMetadata[]>;
  /** List of participants raising their hand */
  handsRaised$: Behavior<Record<string, RaisedHandInfo>>;
  /** List of reactions. Keys are: membership.membershipId (currently predefined as: `${membershipEvent.userId}:${membershipEvent.deviceId}`)*/
  reactions$: Behavior<Record<string, ReactionOption>>;

  // sounds and events
  joinSoundEffect$: Observable<void>;
  leaveSoundEffect$: Observable<void>;
  /**
   * InterCom: who is in the call beside the user, by user. What the sounds of
   * coming and going are worked out from (see `RosterCueGate`), in place of
   * the two above, which count tiles: the user's own, those of the user's
   * other devices and those of a membership that is there twice among them.
   */
  soundRoster$: Observable<SoundRoster>;
  /**
   * Emits an event every time a new hand is raised in
   * the call.
   */
  newHandRaised$: Observable<{ value: number; playSounds: boolean }>;
  /**
   * Emits an event every time a new screenshare is started in
   * the call.
   */
  newScreenShare$: Observable<{ value: number; playSounds: boolean }>;
  /**
   * Emits an array of reactions that should be played.
   */
  audibleReactions$: Observable<string[]>;
  /**
   * Emits an array of reactions that should be visible on the screen.
   */
  // DISCUSSION move this into a reaction file
  visibleReactions$: Behavior<
    { sender: string; emoji: string; startX: number }[]
  >;

  /**
   * The layout of tiles in the call interface.
   */
  layout$: Behavior<Layout>;
  /**
   * The current generation of the tile store, exposed for debugging purposes.
   */
  tileStoreGeneration$: Behavior<number>;
  showSpotlightIndicators$: Behavior<boolean>;
  showSpeakingIndicators$: Behavior<boolean>;
  showNameTags$: Behavior<boolean>;
  spotlightExpanded$: Behavior<boolean>;
  toggleSpotlightExpanded$: Behavior<(() => void) | null>;
  /**
   * The media (its kind and ID) that the user clicked to see large, with the
   * others in a strip beside it; null when none is.
   */
  focusedMedia$: Behavior<string | null>;
  /** Focuses the media of that key, or lets go of it when it is the focused one. */
  toggleFocusedMedia: (key: string) => void;
  clearFocusedMedia: () => void;
  layoutSwitchVm$: Behavior<LayoutSwitchViewModel | null>;

  // header/footer visibility
  showHeader$: Behavior<boolean>;
  showFooter$: Behavior<boolean>;
  /**
   * Whether the call layout should be displayed edge-to-edge, with the footer
   * and header as overlays.
   */
  edgeToEdge$: Behavior<boolean>;
  /**
   * Whether the call layout is overflowing the interface (causing it to scroll).
   */
  overflowing$: Behavior<boolean>;

  /**
   * Whether modals such as settings and reactions should be accessible at all.
   */
  showModals$: Behavior<boolean>;

  settingsOpen$: Behavior<boolean>;
  setSettingsOpen$: Behavior<(open: boolean) => void>;

  // audio routing
  /**
   * Whether audio is currently being output through the earpiece.
   */
  earpieceMode$: Behavior<boolean>;
  /**
   * Callback to toggle between the earpiece and the loudspeaker.
   *
   * This will be `null` in case the target does not exist in the list
   * of available audio outputs.
   */
  audioOutputSwitcher$: Behavior<{
    targetOutput: "earpiece" | "speaker";
    switch: () => void;
  } | null>;

  /** Connected once, and currently not: to the homeserver, the session or the media transport. */
  reconnecting$: Behavior<boolean>;
}

/**
 * A view model providing all the application logic needed to show the in-call
 * UI (may eventually be expanded to cover the lobby and feedback screens in the
 * future).
 *
 * The slot and the participation — memberships, transports, media — are the
 * SDK's; this adds everything that makes it a call.
 */
export function createCallViewModel$(
  scope: ObservableScope,
  {
    rtcParticipation,
    matrixRoom,
    mediaDevices,
    muteStates,
    encryptionSystem,
    viewSize$,
    handsRaisedSubject$,
    reactionsSubject$,
  }: CallViewModelProps,
  options: CallViewModelOptions = {},
): CallViewModel {
  const logger = rootLogger.getChild("[CallViewModel]");
  const client = matrixRoom.client;
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  if (!(userId && deviceId))
    throw new UnknownCallError(new Error("userId and deviceId are required"));

  // Defaults match what the URL parameters resolve to outside of widget mode,
  // so that callers which don't care (chiefly tests) behave as they always have.
  const {
    hostBridge = nullHostBridge,
    header = HeaderStyle.Standard,
    showControls = true,
    hideScreensharing = false,
    sentCallNotification$ = of(null),
  } = options;

  const {
    capture = {},
    backgroundEffectsState$ = constant<BackgroundEffectsState>({
      supported: false,
      processor: undefined,
    }),
  } = options;
  const videoProcessor$ = scope.behavior(
    backgroundEffectsState$.pipe(map(({ processor }) => processor)),
  );
  // Resolves once it is known whether the processor builds
  const processorKnown = async (): Promise<unknown> =>
    firstValueFrom(
      backgroundEffectsState$.pipe(filter(({ wait }) => wait !== "preparing")),
    );
  const localTracks$ = scope.behavior<
    (LocalAudioMediaTrack | LocalVideoMediaTrack)[]
  >(
    rtcParticipation.localMember$.pipe(
      switchMap((member) => member?.tracks$ ?? of(null)),
      map((tracks) => tracks ?? []),
    ),
  );
  // Our own tracks, which carry the controls remote ones lack
  const microphone$ = trackBySource$(
    scope,
    localTracks$,
    "microphone",
  ) as Behavior<LocalAudioMediaTrack | undefined>;
  const camera$ = trackBySource$(scope, localTracks$, "camera") as Behavior<
    LocalVideoMediaTrack | undefined
  >;
  const screenShare$ = trackBySource$(
    scope,
    localTracks$,
    "screenShare",
  ) as Behavior<LocalVideoMediaTrack | undefined>;

  const processorAttached = followProcessor(
    scope,
    camera$,
    videoProcessor$,
    logger,
  );

  // A camera turned on waits for its processor to be known, then to be on
  // the track: LiveKit restarts the track with whatever processor it has then.
  const cameraReady = async (): Promise<void> => {
    await processorKnown();
    await processorAttached();
  };
  const supply = (source: "microphone" | "camera"): TrackSupply => ({
    publish: async () =>
      rtcParticipation.publish(
        publishRequest(
          source,
          mediaDevices,
          capture,
          source === "camera" ? videoProcessor$.value : undefined,
        ),
      ),
    ready: source === "camera" ? cameraReady : undefined,
  });
  // A publication that failed while the participation was still connecting
  // is attempted again the moment it is connected
  const publishRetry$ = rtcParticipation.state$.pipe(
    map((state) => state.kind),
    distinctUntilChanged(),
    filter((kind) => kind === "connected"),
  );
  followMuteState(
    scope,
    muteStates.audio,
    microphone$,
    supply("microphone"),
    "microphone",
    logger,
    publishRetry$,
  );
  followMuteState(
    scope,
    muteStates.video,
    camera$,
    supply("camera"),
    "camera",
    logger,
    publishRetry$,
  );
  followDevice(
    scope,
    microphone$,
    mediaDevices.audioInput,
    "microphone",
    logger,
  );
  followDevice(scope, camera$, mediaDevices.videoInput, "camera", logger);

  // A camera wanted at the join was left out of it while the processor was
  // prepared (see initialPublishRequests), and is published once that is known
  if (
    backgroundEffectsState$.value.wait === "preparing" &&
    muteStates.video.enabled$.value
  )
    processorKnown()
      .then(async () => {
        if (camera$.value !== undefined || !muteStates.video.enabled$.value)
          return;
        await rtcParticipation.publish(
          publishRequest(
            "camera",
            mediaDevices,
            capture,
            videoProcessor$.value,
          ),
        );
      })
      .catch((e) => {
        logger.error("Failed to publish the camera", e);
      });

  // The output device follows the selection onto the client the same way. A
  // host that routes audio itself picks the output outside the browser, so the
  // client is left alone
  if (!options.controlledAudioDevices)
    mediaDevices.audioOutput.selected$
      .pipe(scope.bind())
      .subscribe((selected) => {
        if (selected === undefined) return;
        rtcParticipation.setAudioOutputDeviceId(selected.id).catch((e) => {
          logger.error("Failed to switch the audio output device", e);
        });
      });

  const members$ = scope.behavior<(LocalRTCMember | RemoteRTCMember)[]>(
    combineLatest(
      [rtcParticipation.localMember$, rtcParticipation.remoteMembers$],
      (local, remote) => (local === null ? remote : [local, ...remote]),
    ),
  );

  const matrixRoomMembers$ = scope.behavior(
    fromEvent(matrixRoom, RoomStateEvent.Members).pipe(
      map(() => roomMembers(matrixRoom)),
    ),
    roomMembers(matrixRoom),
  );

  // TODO if we are in "unknown" state we need a loading rendering (or empty screen)
  // Otherwise it looks like we already connected and only than the ringing starts which is weird.
  const { ringAttempts$, autoLeave$ } = createCallNotificationLifecycle$({
    scope,
    memberUserIds$: scope.behavior(
      members$.pipe(map((members) => members.map((m) => m.userId))),
    ),
    roomMemberUserIds$: scope.behavior(
      matrixRoomMembers$.pipe(map((members) => members.map((m) => m.userId))),
    ),
    sentCallNotification$,
    receivedDecline$: createReceivedDecline$(matrixRoom),
    options,
    localUser: { userId, deviceId },
  });

  const reconnecting$ = scope.behavior(
    rtcParticipation.state$.pipe(map((state) => state.kind === "reconnecting")),
  );

  const handsRaised$ = scope.behavior(
    handsRaisedSubject$.pipe(pauseWhen(reconnecting$)),
  );

  const reactions$ = scope.behavior(
    reactionsSubject$.pipe(
      map((v) =>
        Object.fromEntries(
          Object.entries(v).map(([a, { reactionOption }]) => [
            a,
            reactionOption,
          ]),
        ),
      ),
      pauseWhen(reconnecting$),
    ),
  );

  /**
   * List of user media (camera feeds) that we want tiles for.
   */
  const userMedia$ = scope.behavior<WrappedUserMediaViewModel[]>(
    combineLatest([members$, duplicateTiles.value$]).pipe(
      // Generate a collection of user media from the list of members, whether
      // their media is present or still missing.
      generateItems(
        "CallViewModel userMedia$",
        function* ([members, duplicateTiles]) {
          for (const member of members) {
            const mediaId = `${member.userId}:${member.deviceId}`;
            // A device that rejoins after an improper leave has two
            // memberships until the stale one expires, so the key is the
            // membership's own id, which the backend identity no longer
            // tells apart
            for (let dup = 0; dup < 1 + duplicateTiles; dup++) {
              yield {
                keys: [dup, mediaId, member.memberId],
                data: member,
              };
            }
          }
        },
        (scope, member$, dup, mediaId, _memberId) => {
          const member = member$.value;
          return createWrappedUserMedia(scope, {
            id: `${mediaId}:${dup}`,
            userId: member.userId,
            rtcBackendIdentity: member.rtcBackendIdentity,
            member,
            encryptionSystem,
            transport$: scope.behavior(
              member.transport$.pipe(map((transport) => transport?.raw)),
            ),
            mediaDevices,
            pretendToBeDisconnected$: reconnecting$,
            displayName$: member.displayName$,
            mxcAvatarUrl$: member.avatarUrl$,
            handRaised$: scope.behavior(
              handsRaised$.pipe(map((v) => v[mediaId]?.time ?? null)),
            ),
            reaction$: scope.behavior(
              reactions$.pipe(map((v) => v[mediaId] ?? undefined)),
            ),
          });
        },
      ),
    ),
  );

  const ringingMedia$ = scope.behavior<RingingMediaViewModel | null>(
    ringAttempts$.pipe(
      switchMap(({ intent, recipient, outcome$ }) =>
        outcome$.pipe(
          startWith("ringing" as const),
          generateItems(
            "CallViewModel ringingMedia$",
            function* (pickupState) {
              if (pickupState !== "accept")
                yield { keys: [intent, recipient], data: pickupState };
            },
            (scope, pickupState$, intent, userId) => {
              const member$ = matrixRoomMembers$.pipe(
                map((members) => members.find((m) => m.userId === userId)),
              );
              return createRingingMedia({
                id: `ringing:${userId}`,
                userId,
                displayName$: scope.behavior(
                  member$.pipe(map((m) => m?.rawDisplayName || userId)),
                ),
                mxcAvatarUrl$: scope.behavior(
                  member$.pipe(map((m) => m?.getMxcAvatarUrl())),
                ),
                pickupState$,
                intent,
              });
            },
          ),
          map(([media]) => media ?? null),
        ),
      ),
      startWith(null),
    ),
  );

  const screenShares$ = scope.behavior<ScreenShareViewModel[]>(
    userMedia$.pipe(
      switchMap((userMedia) =>
        userMedia.length === 0
          ? of([])
          : combineLatest(
              userMedia.map((m) => m.screenShares$),
              (...screenShares) => screenShares.flat(1),
            ),
      ),
    ),
  );

  const joinSoundEffect$ = userMedia$.pipe(
    pairwise(),
    filter(
      ([prev, current]) =>
        current.length <= MAX_PARTICIPANT_COUNT_FOR_SOUND &&
        current.length > prev.length,
    ),
    map(() => {}),
    throttleTime(THROTTLE_SOUND_EFFECT_MS),
  );

  /**
   * The number of participants currently in the call.
   *
   *  - Each participant has a corresponding MatrixRTC membership state event
   *  - There can be multiple participants for one Matrix user if they join from
   *    multiple devices.
   */
  // One per membership, so one user may count several times
  const participantCount$ = scope.behavior(
    rtcParticipation.slot.members$.pipe(map((members) => members.length)),
  );

  const keyRotationSuppressed$ = rtcParticipation.keyRotationSuppressed$;

  const leaveSoundEffect$ = userMedia$.pipe(
    pairwise(),
    filter(
      ([prev, current]) =>
        current.length <= MAX_PARTICIPANT_COUNT_FOR_SOUND &&
        current.length < prev.length,
    ),
    map(() => {}),
    throttleTime(THROTTLE_SOUND_EFFECT_MS),
    // Avoid doubling up on any auto-leave sounds (e.g. the decline sound),
    // which are handled elsewhere
    takeUntil(autoLeave$),
  );

  const soundRoster$ = members$.pipe(
    map((members) => soundRoster(members, userId)),
  );

  const userHangup$ = new Subject<void>();

  const hostHangup$ = hostBridge.hangUp$.pipe(
    tap((request) => {
      request.reply();
    }),
  );

  const leave$: Observable<"user" | "timeout" | "decline" | "allOthersLeft"> =
    merge(
      autoLeave$,
      merge(userHangup$, hostHangup$).pipe(map(() => "user" as const)),
    ).pipe(scope.share);

  const spotlightSpeaker$ = scope.behavior<UserMediaViewModel | undefined>(
    userMedia$.pipe(
      switchMap((mediaItems) =>
        mediaItems.length === 0
          ? of([])
          : combineLatest(
              mediaItems.map((media) =>
                media.speaking$.pipe(map((speaking) => ({ media, speaking }))),
              ),
            ),
      ),
      scan<
        { media: UserMediaViewModel; speaking: boolean }[],
        UserMediaViewModel | undefined,
        undefined
      >(chooseSpotlightSpeaker, undefined),
    ),
  );

  const grid$ = scope.behavior<UserMediaViewModel[]>(
    userMedia$.pipe(
      switchMap((mediaItems) => {
        const bins = mediaItems.map((m) =>
          m.bin$.pipe(map((bin) => [m, bin] as const)),
        );
        // Sort the media by bin order and generate a tile for each one
        return bins.length === 0
          ? of([])
          : combineLatest(bins, (...bins) =>
              bins.sort(([, bin1], [, bin2]) => bin1 - bin2).map(([m]) => m),
            );
      }),
      distinctUntilChanged(arrayShallowEquals),
    ),
  );

  /**
   * Local user media suitable for displaying in a PiP (undefined if not found,
   * video is muted, or if user prefers to not see themselves).
   */
  const localUserMediaForPip$ = scope.behavior<
    LocalUserMediaViewModel | undefined
  >(
    userMedia$.pipe(
      switchMap((userMedia) => {
        const localUserMedia = userMedia.find(
          (m): m is WrappedUserMediaViewModel & LocalUserMediaViewModel =>
            m.type === "user" && m.local,
        );
        if (!localUserMedia) return of(undefined);
        return combineLatest(
          [localUserMedia.videoEnabled$, localUserMedia.alwaysShow$],
          (videoEnabled, alwaysShow) =>
            videoEnabled && alwaysShow ? localUserMedia : undefined,
        );
      }),
    ),
  );

  const spotlightAndPip$ = scope.behavior(
    combineLatest(
      [ringingMedia$, screenShares$, spotlightSpeaker$, localUserMediaForPip$],
      (ringing, screenShares, speaker, localPip) =>
        computeSpotlight({ ringing, screenShares, speaker, localPip }),
    ).pipe(
      distinctUntilChanged(
        (a, b) =>
          arrayShallowEquals(a.spotlight, b.spotlight) && a.pip === b.pip,
      ),
    ),
  );

  const spotlight$ = scope.behavior<MediaViewModel[]>(
    spotlightAndPip$.pipe(
      map(({ spotlight }) => spotlight),
      distinctUntilChanged<MediaViewModel[]>(arrayShallowEquals),
    ),
  );

  const hasRemoteScreenShares$ = scope.behavior<boolean>(
    spotlight$.pipe(
      map((spotlight) =>
        spotlight.some((vm) => vm.type === "screen share" && !vm.local),
      ),
    ),
  );

  const pipEnabled$ = scope.behavior(setPipEnabled$, false);

  // A guess at what the window's mode should be based on the size and shape of
  // the space we have to draw in.
  const naturalWindowMode$ = scope.behavior<WindowMode>(
    viewSize$.pipe(
      map(({ width, height }) => {
        if (height <= 400 && width <= 340) return "pip";
        // Our layouts for flat windows are better at adapting to a small width
        // than our layouts for narrow windows are at adapting to a small height,
        // so we give "flat" precedence here
        if (height <= 600) return "flat";
        if (width <= 600) return "narrow";
        return "normal";
      }),
    ),
  );

  /**
   * The general shape of the window.
   */
  const windowMode$ = scope.behavior<WindowMode>(
    pipEnabled$.pipe(
      switchMap((pip) => (pip ? of<WindowMode>("pip") : naturalWindowMode$)),
    ),
  );

  const spotlightExpandedToggle$ = new Subject<void>();
  const spotlightExpanded$ = createToggle$(
    scope,
    false,
    spotlightExpandedToggle$,
  );

  // The media the user clicked to see large (its kind and ID), if any
  const focusedMedia$ = new BehaviorSubject<string | null>(null);
  const setFocusedMedia = (key: string | null): void => {
    if (focusedMedia$.value === key) return;
    focusedMedia$.next(key);
    diag("tile_focus", { on: key !== null, kind: key?.split(":")[0] });
  };
  // Nothing stays focused that has left the call
  combineLatest([grid$, screenShares$])
    .pipe(scope.bind())
    .subscribe(([grid, screenShares]) => {
      if (
        focusedMedia$.value !== null &&
        findFocusedMedia(focusedMedia$.value, screenShares, grid) === undefined
      )
        setFocusedMedia(null);
    });

  const layoutSwitchVm = createLayoutSwitchViewModel(
    scope,
    windowMode$,
    hasRemoteScreenShares$,
  );

  const oneOnOneLayoutMedia$: Behavior<OneOnOneMedia | null> = scope.behavior(
    combineLatest([userMedia$, screenShares$]).pipe(
      switchMap(([userMedia, screenShares]) => {
        // One-on-one layout only supports 2 user media, no screen shares
        if (userMedia.length <= 2 && screenShares.length === 0) {
          const local = userMedia.find(
            (vm): vm is WrappedUserMediaViewModel & LocalUserMediaViewModel =>
              vm.type === "user" && vm.local,
          );

          if (local !== undefined) {
            const remote = userMedia.find(
              (
                vm,
              ): vm is WrappedUserMediaViewModel & RemoteUserMediaViewModel =>
                vm.type === "user" && !vm.local,
            );

            if (remote !== undefined) return of({ local, remote });

            // If there's no other user media in the call (could still happen in
            // this branch due to the duplicate tiles option), we could possibly
            // show ringing media instead
            if (userMedia.length === 1)
              return ringingMedia$.pipe(
                map(
                  (ringingMedia) =>
                    ringingMedia && { local, remote: ringingMedia },
                ),
              );
          }
        }

        return of(null);
      }),
    ),
  );

  const localVideoEnabled$ = scope.behavior<boolean>(
    oneOnOneLayoutMedia$.pipe(
      switchMap((media) =>
        media === null ? of(false) : media.local.videoEnabled$,
      ),
    ),
  );

  spotlight$
    .pipe(
      switchMap((media) => {
        let layout;
        const pipMedia = media[0];
        if (pipMedia === undefined) return of(undefined);
        switch (pipMedia.type) {
          case "user":
            layout = pipMedia.videoOrientation$;
            break;
          case "ringing":
            layout = of("landscape" as const);
            break;
          case "screen share":
            layout = of("landscape" as const);
            break;
        }
        return layout;
      }),
      distinctUntilChanged(),
      scope.bind(),
    )
    .subscribe((orientation) => {
      if (orientation === undefined) return;
      logger.info("controls api pip orientation updated:", orientation);
      window.controls.onPipMediaOrientationUpdate?.(orientation);
    });

  /**
   * The media to be used to produce a layout.
   */
  const layoutMedia$ = scope.behavior<LayoutMedia>(
    // We deliberately don't use combineLatest here. Several of the inputs
    // below derive from the same source. So one upstream change cascades
    // through them one at a time. combineLatest would see each step of the
    // cascade and emit layouts built from inputs that never coexisted.
    // Instead, we treat the emissions as a mere "something changed" signal
    // and read every input's current value. The derived behaviors were
    // subscribed before this one and a BehaviorSubject updates its value
    // before notifying. So by the time the first signal arrives every value
    // is already consistent. The duplicate signals from the rest of the
    // cascade are dropped by distinctUntilChanged.
    merge(
      windowMode$,
      layoutSwitchVm.layout$,
      spotlightExpanded$,
      oneOnOneLayoutMedia$,
      localVideoEnabled$,
      spotlightAndPip$,
      grid$,
      screenShares$,
      focusedMedia$,
    ).pipe(
      map(() =>
        computeLayoutMedia({
          focused: focusedMedia$.value,
          screenShares: screenShares$.value,
          windowMode: windowMode$.value,
          layoutMode: layoutSwitchVm.layout$.value,
          spotlightExpanded: spotlightExpanded$.value,
          oneOnOne: oneOnOneLayoutMedia$.value,
          localVideoEnabled: localVideoEnabled$.value,
          ...spotlightAndPip$.value,
          grid: grid$.value,
          desktop: platform === "desktop",
        }),
      ),
      distinctUntilChanged(layoutShallowEquals),
    ),
  );

  const showSpotlightIndicators$ = scope.behavior<boolean>(
    layoutMedia$.pipe(map((l) => l.type !== "grid" && l.type !== "equal-grid")),
  );

  // Which layout the call is in, whoever or whatever changed it
  layoutMedia$
    .pipe(
      map((l) => l.type),
      distinctUntilChanged(),
      scope.bind(),
    )
    .subscribe((layout) =>
      diag("layout", {
        layout,
        mode: layoutSwitchVm.layout$.value,
        window: windowMode$.value,
      }),
    );

  const showSpeakingIndicators$ = scope.behavior<boolean>(
    layoutMedia$.pipe(
      map((l) => {
        switch (l.type) {
          case "spotlight-landscape":
          case "spotlight-portrait":
            // If the spotlight is showing the active speaker, we can do without
            // speaking indicators as they're a redundant visual cue. But if
            // screen sharing feeds are in the spotlight we still need them.
            return l.spotlight.some((m) => m.type === "screen share");
          // In expanded spotlight layout, the active speaker is always shown in
          // the picture-in-picture tile so there is no need for speaking
          // indicators. And in one-on-one layout there's no question as to who is
          // speaking.
          case "spotlight-expanded":
          case "one-on-one-desktop":
          case "one-on-one-mobile":
            return false;
          default:
            return true;
        }
      }),
    ),
  );

  const showNameTags$ = scope.behavior<boolean>(
    layoutMedia$.pipe(
      switchMap((l) =>
        l.type === "pip" || l.type === "one-on-one-mobile"
          ? matrixRoomMembers$.pipe(
              map(
                (members) =>
                  // Hide name tags by default in these layouts. For safety we
                  // still need to show them in case it wouldn't be clear who
                  // the spotlight media belongs to.
                  // TODO: Respect io.element.functional_members (while still
                  // being careful to never show a functional member's media
                  // without a name tag!)
                  // TODO: Only hide name tags in DMs, not group chats that just
                  // happen to have only 2 users
                  members.length > 2,
              ),
            )
          : of(true),
      ),
    ),
  );

  const toggleSpotlightExpanded$ = scope.behavior<(() => void) | null>(
    windowMode$.pipe(
      switchMap((mode) =>
        mode === "normal"
          ? layoutMedia$.pipe(
              map(
                (l) =>
                  l.type === "spotlight-landscape" ||
                  l.type === "spotlight-expanded",
              ),
            )
          : of(false),
      ),
      distinctUntilChanged(),
      map((enabled) =>
        enabled ? (): void => spotlightExpandedToggle$.next() : null,
      ),
    ),
  );

  const edgeToEdge$ = scope.behavior<boolean>(
    layoutMedia$.pipe(map(({ edgeToEdge }) => edgeToEdge)),
  );

  // Only show the layout switch in cases where it has an effect on the layout
  const showLayoutSwitch$ = windowMode$.pipe(
    switchMap((windowMode) => {
      switch (windowMode) {
        case "normal":
          return of(true);
        case "flat":
          return oneOnOneLayoutMedia$.pipe(
            map((oneOnOne) => oneOnOne === null),
          );
        default:
          return of(false);
      }
    }),
  );

  const screenTap$ = new Subject<void>();
  const controlsTap$ = new Subject<void>();
  const screenHover$ = new Subject<void>();
  const screenUnhover$ = new Subject<void>();

  const naturallyShowFooter$ = scope.behavior<boolean>(
    edgeToEdge$.pipe(
      switchMap((edgeToEdge) => {
        if (!edgeToEdge) return of(true);

        // Sadly Firefox has some layering glitches that prevent the footer
        // from appearing properly. They happen less often if we never hide
        // the footer.
        if (isFirefox()) return of(true);

        // Layout is edge-to-edge; show/hide the footer in response to interactions
        return windowMode$.pipe(
          switchMap((mode) => {
            if (mode === "pip" && platform !== "desktop") {
              // No controls are shown in mobile pip as interactions are disabled
              return of(false);
            }
            const showInitially = mode !== "flat";
            const timeout$ = mode === "flat" ? timer(showFooterMs) : NEVER;

            return merge(
              screenTap$.pipe(map(() => "tap screen" as const)),
              controlsTap$.pipe(map(() => "tap controls" as const)),
              screenHover$.pipe(map(() => "hover" as const)),
            ).pipe(
              switchScan((state, interaction) => {
                switch (interaction) {
                  case "tap screen":
                    return state
                      ? // Toggle visibility on tap
                        of(false)
                      : // Hide after a timeout
                        timeout$.pipe(
                          map(() => false),
                          startWith(true),
                        );
                  case "tap controls":
                    // The user is interacting with things, so reset the timeout
                    return timeout$.pipe(
                      map(() => false),
                      startWith(true),
                    );
                  case "hover":
                    // Show on hover and hide after a timeout
                    return race(timeout$, screenUnhover$.pipe(take(1))).pipe(
                      map(() => false),
                      startWith(true),
                    );
                }
              }, showInitially),
              startWith(showInitially),
            );
          }),
        );
      }),
    ),
  );

  const showFooterUrlParams = !(
    header === HeaderStyle.None && showControls === false
  );
  const showFooter$ = scope.behavior(
    naturallyShowFooter$.pipe(
      map((naturallyShowFooter) => naturallyShowFooter && showFooterUrlParams),
    ),
  );

  const showModals$ = scope.behavior(
    windowMode$.pipe(map((mode) => mode !== "pip")),
  );

  const settingsOpen$ = new BehaviorSubject(false);
  const setSettingsOpen$ = constant((open: boolean) => {
    settingsOpen$.next(open);
  });

  const showHeader$ = scope.behavior<boolean>(
    windowMode$.pipe(
      switchMap((mode) => {
        // In small windows the header would be too obstructive
        if (mode === "pip") return of(false);
        // In edge-to-edge layouts, couple the visibility of the header
        // to that of the footer
        return edgeToEdge$.pipe(
          switchMap((edgeToEdge) => (edgeToEdge ? showFooter$ : of(true))),
        );
      }),
    ),
  );

  /**
   * State of the floating spotlight tile, if present.
   */
  const floatingSpotlightTile = createFloatingTile(scope, {
    inline: "end",
    block: "end",
  });
  /**
   * State of the small picture-in-picture tile, if present, when in landscape.
   */
  const landscapePipTile = createFloatingTile(scope, {
    inline: "end",
    block: "start",
  });
  /**
   * State of the small picture-in-picture tile, if present, when in portrait.
   */
  const portraitPipTile = {
    ...createFloatingTile(scope, { inline: "end", block: "end" }),
    size$: scope.behavior(
      showFooter$.pipe(map((showFooter) => (showFooter ? "lg" : "sm"))),
    ),
  };

  // There is a cyclical dependency here: the layout algorithms want to know
  // which tiles are on screen, but to know which tiles are on screen we have to
  // first render a layout. To deal with this we assume initially that all tiles
  // are visible, and loop the data back into the layouts with a Subject.
  const equalGridShareTiles: EqualGridShareTiles = new WeakMap();
  const visibleTiles$ = new Subject<number>();
  const setVisibleTiles = (value: number): void => visibleTiles$.next(value);

  const layoutInternals$ = scope.behavior<LayoutScanState & { layout: Layout }>(
    combineLatest([
      layoutMedia$,
      visibleTiles$.pipe(startWith(Infinity), distinctUntilChanged()),
    ]).pipe(
      scan<
        [LayoutMedia, number],
        LayoutScanState & { layout: Layout },
        LayoutScanState
      >(
        ({ tiles: prevTiles }, [media, visibleTiles]) => {
          let layout: Layout;
          let newTiles: TileStore;
          let pip: GridTileViewModel | undefined;
          let overflowing = false;
          switch (media.type) {
            case "grid":
            case "spotlight-landscape":
            case "spotlight-portrait":
              [layout, newTiles] = gridLikeLayout(
                media,
                floatingSpotlightTile,
                visibleTiles,
                setVisibleTiles,
                prevTiles,
              );
              overflowing = newTiles.gridTiles.length > visibleTiles;
              break;
            case "spotlight-expanded":
              [layout, newTiles] = spotlightExpandedLayout(
                media,
                landscapePipTile,
                prevTiles,
              );
              break;
            case "one-on-one-desktop":
              [layout, newTiles] = oneOnOneDesktopLayout(
                media,
                landscapePipTile,
                prevTiles,
              );
              pip = layout.pip.vm;
              break;
            case "one-on-one-mobile":
              [layout, newTiles] = oneOnOneMobileLayout(
                media,
                portraitPipTile,
                prevTiles,
              );
              pip = layout.pip?.vm;
              break;
            case "equal-grid":
              [layout, newTiles] = equalGridLayout(
                media,
                prevTiles,
                equalGridShareTiles,
              );
              break;
            case "pip":
              [layout, newTiles] = pipLayout(media, prevTiles);
              break;
          }

          for (const tile of newTiles.gridTiles) {
            tile.setShowOutline(tile === pip);
          }

          return { layout, overflowing, tiles: newTiles };
        },
        { layout: null, overflowing: false, tiles: TileStore.empty() },
      ),
    ),
  );

  /**
   * The layout of tiles in the call interface.
   */
  const layout$ = scope.behavior<Layout>(
    layoutInternals$.pipe(
      map(({ layout }) => layout),
      // Drop redundant layout updates before they would hit React.
      distinctUntilChanged(layoutShallowEquals),
    ),
  );

  const overflowing$ = scope.behavior<boolean>(
    layoutInternals$.pipe(map(({ overflowing }) => overflowing)),
  );

  /**
   * The current generation of the tile store, exposed for debugging purposes.
   */
  const tileStoreGeneration$ = scope.behavior<number>(
    layoutInternals$.pipe(map(({ tiles }) => tiles.generation)),
  );

  /**
   * Whether audio is currently being output through the earpiece.
   */
  const earpieceMode$ = scope.behavior<boolean>(
    combineLatest(
      [mediaDevices.audioOutput.available$, mediaDevices.audioOutput.selected$],
      (available, selected) =>
        selected !== undefined &&
        available.get(selected.id)?.type === "earpiece",
    ),
  );

  /**
   * Callback to toggle between the earpiece and the loudspeaker.
   *
   * This will be `null` in case the target does not exist in the list
   * of available audio outputs.
   */
  const audioOutputSwitcher$ = scope.behavior<{
    targetOutput: "earpiece" | "speaker";
    switch: () => void;
  } | null>(
    combineLatest(
      [mediaDevices.audioOutput.available$, mediaDevices.audioOutput.selected$],
      (available, selected) => {
        const selectionType = selected && available.get(selected.id)?.type;

        // If we are in any output mode other than speaker switch to speaker.
        const newSelectionType: "earpiece" | "speaker" =
          selectionType === "speaker" ? "earpiece" : "speaker";
        const newSelection = [...available].find(
          ([, d]) => d.type === newSelectionType,
        );
        if (newSelection === undefined) return null;

        const [id] = newSelection;
        return {
          targetOutput: newSelectionType,
          switch: (): void => mediaDevices.audioOutput.select(id),
        };
      },
    ),
  );

  /**
   * Emits an array of reactions that should be visible on the screen.
   */
  // DISCUSSION move this into a reaction file
  // const {visibleReactions$, audibleReactions$} = reactionsObservables$(showReactionSetting$, )
  const visibleReactions$ = scope.behavior(
    showReactions.value$.pipe(
      switchMap((show) => (show ? reactions$ : of({}))),
      scan<
        Record<string, ReactionOption>,
        { sender: string; emoji: string; startX: number }[]
      >((acc, latest) => {
        const newSet: { sender: string; emoji: string; startX: number }[] = [];
        for (const [sender, reaction] of Object.entries(latest)) {
          const startX =
            acc.find((v) => v.sender === sender && v.emoji)?.startX ??
            Math.ceil(Math.random() * 80) + 10;
          newSet.push({ sender, emoji: reaction.emoji, startX });
        }
        return newSet;
      }, []),
    ),
  );

  /**
   * Emits an array of reactions that should be played.
   */
  const audibleReactions$ = playReactionsSound.value$.pipe(
    switchMap((show) =>
      show ? reactions$ : of<Record<string, ReactionOption>>({}),
    ),
    map((reactions) => Object.values(reactions).map((v) => v.name)),
    scan<string[], { playing: string[]; newSounds: string[] }>(
      (acc, latest) => {
        return {
          playing: latest.filter(
            (v) => acc.playing.includes(v) || acc.newSounds.includes(v),
          ),
          newSounds: latest.filter(
            (v) => !acc.playing.includes(v) && !acc.newSounds.includes(v),
          ),
        };
      },
      { playing: [], newSounds: [] },
    ),
    map((v) => v.newSounds),
  );

  const newHandRaised$ = handsRaised$.pipe(
    map((v) => Object.keys(v).length),
    scan(
      (acc, newValue) => ({
        value: newValue,
        playSounds: newValue > acc.value,
      }),
      { value: 0, playSounds: false },
    ),
    filter((v) => v.playSounds),
  );

  const newScreenShare$ = screenShares$.pipe(
    map((v) => v.length),
    scan(
      (acc, newValue) => ({
        value: newValue,
        playSounds: newValue > acc.value,
      }),
      { value: 0, playSounds: false },
    ),
    filter((v) => v.playSounds),
  );

  /**
   * Whether we are sharing our screen: one of our tracks is a screen share.
   */
  const sharingScreen$ = scope.behavior(
    screenShare$.pipe(map((track) => track !== undefined)),
  );

  const screenShareError$ = new BehaviorSubject<Error | null>(null);

  // How the share that is on was asked to be encoded, for the budget below
  let screenShareSettings: VideoCaptureSettings | undefined;
  let screenShareAudioAsked = false;
  let screenShareBudget: ShareDiagnostics["budget"];
  const startingScreenShare = (mix?: MediaStreamTrack): PublishRequest => {
    // The developer settings win; otherwise what the share menu says now
    const request: Extract<PublishRequest, { source: "screenShare" }> = {
      ...screenShareRequest(),
      // The mix made here, in place of a device of the SDK's own choosing
      ...(mix !== undefined && { audio: { kind: "track", track: mix } }),
      ...(capture.screenShare && { capture: capture.screenShare }),
    };
    screenShareSettings = request.capture;
    screenShareAudioAsked = request.audio !== false;
    screenShareBudget = undefined;
    const choices = screenShareChoices();
    diag("screen_share_start", {
      preset: choices.preset,
      resolution: choices.resolution,
      codec: choices.codec,
      customBitrateMbps: choices.customBitrate,
      customFramerate: choices.customFramerate,
      // Which kind of source, never which device: its id says nothing useful
      audio: mix !== undefined ? "mix" : shareAudioMode(choices.audio),
      audioSources: mixSourceKinds(
        shareAudioMix(choices.audio, screenShareAudioMix.getValue()),
      ),
      developerOverride: capture.screenShare !== undefined,
      capture: request.capture,
    });
    return request;
  };
  const shareDiagnostics = (): ShareDiagnostics | undefined => {
    const track = screenShare$.value;
    const settings = screenShareSettings;
    if (track === undefined) return undefined;
    const size = track.dimensions();
    const scale = settings ? screenShareScale(settings, size) : 1;
    return {
      expected: size && {
        width: size.width / scale,
        height: size.height / scale,
      },
      audioExpected: screenShareAudioAsked,
      budget: screenShareBudget,
    };
  };
  recordCallDiagnostics(scope, {
    participation: rtcParticipation,
    participant: `${userId}:${deviceId}`,
    micEnabled$: muteStates.audio.enabled$,
    cameraEnabled$: muteStates.video.enabled$,
    devices: {
      audioInput: mediaDevices.audioInput.available$,
      audioOutput: mediaDevices.audioOutput.available$,
      videoInput: mediaDevices.videoInput.available$,
    },
    share: shareDiagnostics,
  });

  // The SFU sends a copy of our share to every viewer: its bitrate follows
  // the number of them so that the server stays within its uplink
  const egressBudgetMbps = options.screenShareEgressBudgetMbps ?? 0;
  if (egressBudgetMbps > 0)
    combineLatest([
      screenShare$,
      rtcParticipation.remoteMembers$.pipe(
        map((members) => members.length),
        distinctUntilChanged(),
      ),
    ])
      .pipe(scope.bind())
      .subscribe(([track, viewers]) => {
        const settings = screenShareSettings;
        if (track === undefined || settings === undefined) return;
        const size = track.dimensions();
        const scale = screenShareScale(settings, size);
        const bitrate = screenShareBitrate(settings, size);
        if (bitrate === undefined || size === undefined) return;
        const limits = screenShareLimitsForBudget({
          bitrate,
          framerate: settings.maxFramerate ?? 30,
          pixels: (size.width * size.height) / (scale * scale),
          viewers,
          budgetMbps: egressBudgetMbps,
          custom: settings.maxBitrate !== undefined,
        });
        logger.info(
          `Screen share for ${viewers} viewer(s) within ${egressBudgetMbps} Mbps: ${limits.maxBitrate} bps, ${limits.maxFramerate} fps`,
        );
        screenShareBudget = {
          mbps: egressBudgetMbps,
          viewers,
          maxBitrate: limits.maxBitrate,
          maxFramerate: limits.maxFramerate,
        };
        diag("budget", {
          ...screenShareBudget,
          uncappedBitrate: bitrate,
          overBudget: limits.overBudget,
          width: size.width / scale,
          height: size.height / scale,
        });
        track.setEncodingLimits(limits).catch((e) => {
          logger.error("Failed to change the screen share's encoding", e);
        });
      });
  // Unless it is the picker's own, a share's audio is a mix made here: one
  // track for as long as the share is on, with the sources and their gains
  // following the settings, so that they can change without republishing
  const { start: startShareAudioMix, end: endShareAudioMix } =
    createShareAudioMix(scope, hostBridge.shareAudio);
  sharingScreen$.pipe(pairwise(), scope.bind()).subscribe(([was, is]) => {
    if (was && !is) endShareAudioMix();
  });
  scope.onEnd(endShareAudioMix);

  /**
   * Callback to toggle screen sharing. If null, screen sharing is not possible:
   * the platform cannot capture a screen, or the host hides the button.
   */
  const toggleScreenSharing =
    hideScreensharing || !("getDisplayMedia" in (navigator.mediaDevices ?? {}))
      ? null
      : (): void => {
          const track = screenShare$.value;
          if (track !== undefined) diag("screen_share_stop", { by: "user" });
          (track === undefined
            ? rtcParticipation
                .publish(startingScreenShare(startShareAudioMix()))
                .then((started) =>
                  diag("screen_share_published", {
                    sid: started.id,
                    capture: "dimensions" in started && started.dimensions(),
                  }),
                )
            : rtcParticipation.unpublish("screenShare")
          ).catch((e: unknown) => {
            if (track === undefined) endShareAudioMix();
            diag("screen_share_error", {
              phase: track === undefined ? "start" : "stop",
              cancelled: isPermissionDenied(e),
              error: describeError(e),
            });
            logger.error(
              `Screen share ${track === undefined ? "start" : "stop"} failed`,
              e,
            );
            // The user closing the picker is not an error worth showing
            if (isPermissionDenied(e)) return;
            screenShareError$.next(
              e instanceof Error ? e : new Error(String(e)),
            );
          });
        };

  // Tell the host and the analytics about the user's joins and leaves. The
  // participation is joined by the time the view model is built on it
  PosthogAnalytics.instance.eventCallEnded.cacheStartCall(new Date());
  PosthogAnalytics.instance.eventCallStarted.track(matrixRoom.roomId);
  hostBridge.notifyJoined().catch((e) => {
    logger.error("Failed to notify the host that we joined", e);
  });
  const leave = (): void => {
    rtcParticipation.leave();
    hostBridge.notifyHungUp().catch((e) => {
      logger.error("Failed to notify the host that we hung up", e);
    });
  };

  let reconnectStart: { time: number; reason: DisconnectReason } | null = null;
  rtcParticipation.state$.pipe(scope.bind()).subscribe((state) => {
    if (state.kind === "reconnecting") {
      reconnectStart ??= { time: Date.now(), reason: state.reason };
    } else if (state.kind === "connected" && reconnectStart !== null) {
      const reason =
        reconnectStart.reason === "media" ? "livekit" : reconnectStart.reason;
      PosthogAnalytics.instance.eventCallReconnecting.track(
        matrixRoom.roomId,
        reason,
        (Date.now() - reconnectStart.time) / 1000,
      );
      PosthogAnalytics.instance.eventCallEnded.cacheReconnecting(reason);
      reconnectStart = null;
    }
  });

  return {
    autoLeave$: autoLeave$,
    ringingVm$: ringingMedia$,
    ringingStatusLocation: header === HeaderStyle.AppBar ? "app_bar" : "tile",
    leave$: leave$,
    hangup: (): void => userHangup$.next(),
    leave,
    toggleScreenSharing: toggleScreenSharing,
    sharingScreen$: sharingScreen$,
    camera$,

    tapScreen: (): void => screenTap$.next(),
    tapControls: (): void => controlsTap$.next(),
    hoverScreen: (): void => screenHover$.next(),
    unhoverScreen: (): void => screenUnhover$.next(),

    fatalError$: scope.behavior(
      rtcParticipation.state$.pipe(
        map((state) =>
          state.kind === "failed" ? fromMatrixRTCError(state.error) : null,
        ),
      ),
    ),
    participantCount$: participantCount$,
    keyRotationSuppressed$: keyRotationSuppressed$,
    localMember$: rtcParticipation.localMember$,
    remoteMembers$: rtcParticipation.remoteMembers$,
    hostParticipants$: hostParticipants$(userMedia$),
    connectedTransports$: rtcParticipation.connectedTransports$,
    handsRaised$: handsRaised$,
    reactions$: reactions$,
    joinSoundEffect$: joinSoundEffect$,
    leaveSoundEffect$: leaveSoundEffect$,
    soundRoster$: soundRoster$,
    newHandRaised$: newHandRaised$,
    newScreenShare$: newScreenShare$,
    audibleReactions$: audibleReactions$,
    visibleReactions$: visibleReactions$,

    spotlightExpanded$: spotlightExpanded$,
    toggleSpotlightExpanded$: toggleSpotlightExpanded$,
    focusedMedia$: focusedMedia$,
    toggleFocusedMedia: (key: string): void =>
      setFocusedMedia(focusedMedia$.value === key ? null : key),
    clearFocusedMedia: (): void => setFocusedMedia(null),
    layoutSwitchVm$: scope.behavior(
      showLayoutSwitch$.pipe(map((show) => (show ? layoutSwitchVm : null))),
    ),
    layout$: layout$,
    tileStoreGeneration$: tileStoreGeneration$,
    showSpotlightIndicators$: showSpotlightIndicators$,
    showSpeakingIndicators$: showSpeakingIndicators$,
    showNameTags$,
    showHeader$: showHeader$,
    showFooter$: showFooter$,
    showModals$,
    settingsOpen$: settingsOpen$,
    setSettingsOpen$: setSettingsOpen$,
    edgeToEdge$,
    overflowing$,
    earpieceMode$: earpieceMode$,
    audioOutputSwitcher$: audioOutputSwitcher$,
    reconnecting$,
    screenShareError$,
    dismissScreenShareError: (): void => screenShareError$.next(null),
  };
}

/** Whether an error, or the browser error the SDK wrapped, is the user saying no. */
function isPermissionDenied(e: unknown): boolean {
  const cause = e instanceof Error && e.cause !== undefined ? e.cause : e;
  return cause instanceof DOMException && cause.name === "NotAllowedError";
}

/** The members a call can be with: those in the room and those invited. */
function roomMembers(room: MatrixRoom): RoomMember[] {
  return room
    .getMembersWithMembership(KnownMembership.Join)
    .concat(room.getMembersWithMembership(KnownMembership.Invite));
}
