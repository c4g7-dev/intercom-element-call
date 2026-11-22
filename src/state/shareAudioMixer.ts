/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject, debounceTime, merge, skip } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";

import { type ShareAudioHost } from "../HostBridge";
import {
  screenShareAudioMix,
  screenShareAudioSource,
  type ShareAudioMixSource,
} from "../settings/settings";
import { describeError, diag } from "../diagnostics/diag";
import {
  prepareSinkDevice,
  sanitizeMix,
  shareAudioMix,
  shareAudioMode,
  sinkOfChoice,
} from "./shareAudioSink";
import { type ObservableScope } from "./ObservableScope";

export type MixSourceStatus = "opening" | "live" | "failed";

/**
 * How each source of the share that is on is doing, by its id; empty while
 * nothing is shared. For the controls that list the sources.
 */
export const shareAudioMixStatus$ = new BehaviorSubject<
  Record<string, MixSourceStatus>
>({});

/** Shared audio is anything but a voice: none of the browser's processing. */
export function mixSourceConstraints(deviceId: string): MediaTrackConstraints {
  return {
    deviceId: { exact: deviceId },
    sampleRate: 48000,
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: 2,
    // Not in the typings yet
    ...({ voiceIsolation: false } as MediaTrackConstraints),
  };
}

interface MixerOptions {
  /** Makes capture devices of outputs, for the `sink:<name>` sources. */
  host?: ShareAudioHost;
  createContext?: () => AudioContext;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Finds the device the host made of a sink; replaced in tests. */
  prepareSink?: (host: ShareAudioHost, sinkName: string) => Promise<string>;
}

interface LiveSource {
  stream: MediaStream;
  node: MediaStreamAudioSourceNode;
  gain: GainNode;
}

/** What a source's gain node is set to. */
export function mixGain(source: ShareAudioMixSource): number {
  return source.muted ? 0 : source.gain;
}

/**
 * Mixes any number of audio inputs into one track, which is what a screen
 * share publishes as its audio: every source through a gain of its own into
 * one destination. Sources come and go and change their gain while the track
 * stays the same, so nothing is republished.
 */
export class ShareAudioMixer {
  private readonly context: AudioContext;
  private readonly destination: MediaStreamAudioDestinationNode;
  /** The one track of the mix, silent while it has no sources. */
  public readonly track: MediaStreamTrack;

  private readonly live = new Map<string, LiveSource>();
  private readonly failed = new Set<string>();
  private readonly opening = new Set<string>();
  private wanted = new Map<string, ShareAudioMixSource>();
  private closed = false;
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly options: MixerOptions = {}) {
    this.context = (
      options.createContext ??
      ((): AudioContext =>
        new AudioContext({ latencyHint: "interactive", sampleRate: 48000 }))
    )();
    this.destination = this.context.createMediaStreamDestination();
    this.destination.channelCount = 2;
    this.track = this.destination.stream.getAudioTracks()[0];
    // Made in the click that starts the share, so allowed to run
    if (this.context.state === "suspended")
      this.context.resume().catch(() => undefined);
  }

  /** The ids of the sources that are being mixed right now. */
  public get liveSources(): string[] {
    return [...this.live.keys()];
  }

  private publishStatus(): void {
    const status: Record<string, MixSourceStatus> = {};
    for (const id of this.opening) status[id] = "opening";
    for (const id of this.failed) status[id] = "failed";
    for (const id of this.live.keys()) status[id] = "live";
    shareAudioMixStatus$.next(status);
  }

  /**
   * Makes the mix consist of these sources at these gains: opens the new
   * ones, lets go of the ones no longer in it and sets every gain. A source
   * that cannot be opened is left out and tried again once it was taken out
   * and put back. Resolves when the mix is as asked; never rejects.
   */
  public async setSources(sources: ShareAudioMixSource[]): Promise<void> {
    this.wanted = new Map(sanitizeMix(sources).map((s) => [s.id, s]));
    // Gains are set at once, whatever is still being opened
    this.applyGains();
    const run = async (): Promise<void> => this.reconcile();
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private applyGains(): void {
    for (const [id, source] of this.live) {
      const wanted = this.wanted.get(id);
      if (wanted === undefined) continue;
      const value = mixGain(wanted);
      // A short ramp: a step in the gain is heard as a click
      if (typeof source.gain.gain.setTargetAtTime === "function")
        source.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
      else source.gain.gain.value = value;
    }
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    for (const id of this.live.keys())
      if (!this.wanted.has(id)) this.remove(id, "removed");
    for (const id of this.failed)
      if (!this.wanted.has(id)) this.failed.delete(id);

    const toOpen = [...this.wanted.keys()].filter(
      (id) => !this.live.has(id) && !this.failed.has(id),
    );
    for (const id of toOpen) this.opening.add(id);
    this.publishStatus();
    await Promise.all(toOpen.map(async (id) => this.open(id)));
    this.applyGains();
    this.publishStatus();
  }

  private async open(id: string): Promise<void> {
    const sink = sinkOfChoice(id);
    const kind = sink !== undefined ? "sink" : "device";
    let stream: MediaStream | undefined;
    try {
      let deviceId = id;
      if (sink !== undefined) {
        if (this.options.host === undefined)
          throw new Error("The host cannot share an output's audio");
        deviceId = await (this.options.prepareSink ?? prepareSinkDevice)(
          this.options.host,
          sink,
        );
      }
      stream = await (
        this.options.getUserMedia ??
        (async (c): Promise<MediaStream> =>
          navigator.mediaDevices.getUserMedia(c))
      )({ audio: mixSourceConstraints(deviceId) });
      // Taken out again, or the share ended, while it was being opened
      if (this.closed || !this.wanted.has(id)) {
        for (const track of stream.getTracks()) track.stop();
        if (sink !== undefined) this.releaseSink(sink);
        return;
      }
      const node = this.context.createMediaStreamSource(stream);
      const gain = this.context.createGain();
      gain.gain.value = mixGain(this.wanted.get(id)!);
      node.connect(gain);
      gain.connect(this.destination);
      this.live.set(id, { stream, node, gain });
      // A device that is unplugged goes quiet; say so where it is listed
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        if (this.live.get(id)?.stream !== stream) return;
        this.remove(id, "ended");
        this.failed.add(id);
        this.publishStatus();
      });
      diag("share_audio_source", { kind, sink, change: "added" });
    } catch (e) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (sink !== undefined) this.releaseSink(sink);
      if (!this.closed) this.failed.add(id);
      diag("share_audio_source", {
        kind,
        sink,
        change: "failed",
        error: describeError(e),
      });
    } finally {
      this.opening.delete(id);
    }
  }

  private remove(id: string, change: string): void {
    const source = this.live.get(id);
    if (source === undefined) return;
    this.live.delete(id);
    try {
      source.node.disconnect();
      source.gain.disconnect();
    } catch {
      // Already disconnected with its context
    }
    for (const track of source.stream.getTracks()) track.stop();
    const sink = sinkOfChoice(id);
    if (sink !== undefined) this.releaseSink(sink);
    diag("share_audio_source", {
      kind: sink !== undefined ? "sink" : "device",
      sink,
      change,
    });
  }

  private releaseSink(sink: string): void {
    void this.options.host?.releaseShareSource(sink);
  }

  /**
   * Ends the mix: every source is let go of, with whatever the host made
   * for it, and the track ends.
   */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.live.keys()) this.remove(id, "closed");
    this.wanted.clear();
    this.failed.clear();
    this.opening.clear();
    this.track.stop();
    this.context.close().catch(() => undefined);
    // Whatever was still being made for a source that never got to open
    void this.options.host?.releaseShareSource();
    shareAudioMixStatus$.next({});
  }
}

/** The sources of a mix as the diagnostics name them: by kind, never by id. */
export function mixSourceKinds(sources: ShareAudioMixSource[]): string[] {
  return sources.map((source) =>
    sinkOfChoice(source.id) !== undefined ? "sink" : "device",
  );
}

type Mixer = Pick<ShareAudioMixer, "track" | "setSources" | "close">;

/**
 * The audio mix of the screen share that is on, kept in step with the share
 * audio settings for as long as it runs: whatever is ticked, unticked, muted
 * or turned up while sharing is rewired into the one published track.
 */
export function createShareAudioMix(
  scope: ObservableScope,
  host: ShareAudioHost | undefined,
  makeMixer: (options: { host?: ShareAudioHost }) => Mixer = (options) =>
    new ShareAudioMixer(options),
): {
  /**
   * Starts the mix for a share that is about to start.
   * @returns the track to publish as the share's audio, or undefined where
   *   the audio is the screen picker's own or cannot be mixed
   */
  start: () => MediaStreamTrack | undefined;
  /** Ends the mix with the share: every source and device is let go of. */
  end: () => void;
} {
  let mixer: Mixer | undefined;
  const sources = (): ShareAudioMixSource[] =>
    shareAudioMix(
      screenShareAudioSource.getValue(),
      screenShareAudioMix.getValue(),
    );
  const end = (): void => {
    if (mixer === undefined) return;
    mixer.close();
    mixer = undefined;
    diag("share_audio_mix", { change: "end" });
  };
  const start = (): MediaStreamTrack | undefined => {
    end();
    if (shareAudioMode(screenShareAudioSource.getValue()) === "system")
      return undefined;
    try {
      const started = makeMixer({ host });
      mixer = started;
      const wanted = sources();
      diag("share_audio_mix", {
        change: "start",
        sources: mixSourceKinds(wanted),
      });
      void started.setSources(wanted);
      return started.track;
    } catch (e) {
      // The picture is worth sharing without the sound
      diag("share_audio_mix", { change: "failed", error: describeError(e) });
      logger.warn("Could not set up the share's audio mix", e);
      return undefined;
    }
  };

  // Both settings say what they hold as they are subscribed to
  const changes$ = merge(
    screenShareAudioSource.value$,
    screenShareAudioMix.value$,
  ).pipe(skip(2), scope.bind());
  changes$.subscribe(() => {
    void mixer?.setSources(sources());
  });
  // Recorded once a slider has come to rest, not for every step of a drag
  changes$.pipe(debounceTime(500)).subscribe(() => {
    if (mixer === undefined) return;
    const wanted = sources();
    diag("share_audio_mix", {
      change: "update",
      sources: mixSourceKinds(wanted),
      muted: wanted.filter((s) => s.muted).length,
      gains: wanted.map((s) => Math.round(s.gain * 100)),
    });
  });
  scope.onEnd(end);

  return { start, end };
}
