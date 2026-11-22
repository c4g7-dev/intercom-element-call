/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type VideoMediaTrack } from "@element-hq/matrixrtc-sdk";
import { BehaviorSubject, type Subscription } from "rxjs";
import { logger } from "matrix-js-sdk/lib/logger";

import { type Behavior } from "../state/Behavior";
import { diag } from "../diagnostics/diag";
import {
  formatPlaybackVolume,
  MAX_PLAYBACK_VOLUME,
  type VolumeControls,
} from "../state/VolumeControls";

/**
 * The prefix of every pop-out window's name. The application hosting Element
 * Call lets `about:blank` popups with a frame name that starts with it open
 * (and nothing else), so this is a contract with the host.
 */
export const POPOUT_WINDOW_NAME_PREFIX = "intercom-popout-";

/** How long a video may be without a track (a resubscription) before its window closes. */
const TRACK_GRACE_MS = 4000;

interface Popout {
  window: Window;
  close: () => void;
}

const popouts = new Map<string, Popout>();
const openIds$ = new BehaviorSubject<ReadonlySet<string>>(new Set());

/** The ids of the videos that are in a window of their own right now. */
export const poppedOutIds$: Behavior<ReadonlySet<string>> = openIds$;

export interface PopoutOptions {
  /** Stable for the thing shown (a member's camera, a member's screen): reopening focuses its window. */
  id: string;
  title: string;
  video: VideoMediaTrack;
  /** For a slider in the window; the sound itself keeps playing from the call. */
  volume?: Pick<
    VolumeControls,
    | "playbackVolume$"
    | "adjustPlaybackVolume"
    | "commitPlaybackVolume"
    | "togglePlaybackMuted"
  >;
  mirror?: boolean;
  labels: { fullscreen: string; mute: string; volume: string };
}

export function popoutWindowName(id: string): string {
  return POPOUT_WINDOW_NAME_PREFIX + id.replace(/[^A-Za-z0-9_-]/g, "_");
}

const STYLE = `
  html, body { margin: 0; height: 100%; background: #000; color: #e6e6e6;
    font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
  video { position: fixed; inset: 0; width: 100%; height: 100%;
    object-fit: contain; background: #000; }
  video.mirror { transform: scaleX(-1); }
  .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 10px; padding: 6px 12px;
    background: rgba(24, 24, 27, 0.92); border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px; opacity: 0; transition: opacity 0.15s; }
  body.active .bar, .bar:focus-within { opacity: 1; }
  button { appearance: none; border: 0; border-radius: 6px; padding: 4px 10px;
    background: rgba(255, 255, 255, 0.1); color: inherit; font: inherit; cursor: pointer; }
  button:hover { background: rgba(255, 255, 255, 0.2); }
  input[type=range] { width: 160px; accent-color: #e6e6e6; }
  output { min-width: 4ch; text-align: end; font-variant-numeric: tabular-nums; }
`;

/**
 * Shows a video in a window of its own: the same track on a `<video>` there,
 * at the best quality the publisher sends for as long as the window is open.
 * The window closes when the track is gone for good, when the call is left
 * (`closeAllPopouts`) and when this page goes away.
 *
 * @returns Whether there is a window now: false where the popup was blocked.
 */
export function openPopout({
  id,
  title,
  video,
  volume,
  mirror = false,
  labels,
}: PopoutOptions): boolean {
  const existing = popouts.get(id);
  if (existing !== undefined && !existing.window.closed) {
    existing.window.focus();
    return true;
  }
  existing?.close();

  const win = window.open(
    "",
    popoutWindowName(id),
    "popup,width=1280,height=720",
  );
  if (win === null) {
    logger.warn("The pop-out window was blocked");
    diag("popout", { action: "blocked", id, source: video.source });
    return false;
  }
  diag("popout", { action: "open", id, source: video.source });

  // Written with the DOM rather than as markup: nothing a member can choose
  // (their name is in the title) is ever parsed as HTML
  const doc = win.document;
  doc.head.replaceChildren();
  doc.body.replaceChildren();
  const style = doc.createElement("style");
  style.textContent = STYLE;
  doc.head.append(style);
  doc.title = title;

  const element = doc.createElement("video");
  element.autoplay = true;
  element.playsInline = true;
  // The sound stays with the call, which is what its volume controls act on
  element.muted = true;
  if (mirror) element.className = "mirror";
  doc.body.append(element);

  const bar = doc.createElement("div");
  bar.className = "bar";
  doc.body.append(bar);

  const subscriptions: Subscription[] = [];
  if (volume !== undefined) {
    const mute = doc.createElement("button");
    mute.type = "button";
    mute.textContent = labels.mute;
    mute.addEventListener("click", () => volume.togglePlaybackMuted());
    const slider = doc.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(MAX_PLAYBACK_VOLUME * 100);
    slider.step = "1";
    slider.setAttribute("aria-label", labels.volume);
    const output = doc.createElement("output");
    slider.addEventListener("input", () =>
      volume.adjustPlaybackVolume(Number(slider.value) / 100),
    );
    slider.addEventListener("change", () => volume.commitPlaybackVolume());
    subscriptions.push(
      volume.playbackVolume$.subscribe((v) => {
        const percent = Math.round(v * 100);
        slider.value = String(percent);
        output.textContent = formatPlaybackVolume(v);
        mute.setAttribute("aria-pressed", String(v === 0));
      }),
    );
    bar.append(mute, slider, output);
  }
  const toggleFullscreen = (): void => {
    if (doc.fullscreenElement) void doc.exitFullscreen();
    else void doc.documentElement.requestFullscreen().catch(() => undefined);
  };
  doc.addEventListener("fullscreenchange", () =>
    diag("fullscreen", {
      where: "popout",
      id,
      on: doc.fullscreenElement !== null,
    }),
  );
  const fullscreen = doc.createElement("button");
  fullscreen.type = "button";
  fullscreen.textContent = labels.fullscreen;
  fullscreen.addEventListener("click", toggleFullscreen);
  bar.append(fullscreen);
  element.addEventListener("dblclick", toggleFullscreen);

  // The controls show while the pointer moves, as in any video player
  let idle: ReturnType<typeof setTimeout> | undefined;
  doc.addEventListener("mousemove", () => {
    doc.body.classList.add("active");
    clearTimeout(idle);
    idle = setTimeout(() => doc.body.classList.remove("active"), 2500);
  });

  let closed = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const releaseQuality = video.requestHighQuality();
  const close = (): void => {
    if (closed) return;
    closed = true;
    diag("popout", { action: "close", id, byUser: win.closed });
    clearTimeout(grace);
    clearTimeout(idle);
    clearInterval(poll);
    for (const s of subscriptions) s.unsubscribe();
    releaseQuality();
    element.srcObject = null;
    if (popouts.get(id)?.window === win) {
      popouts.delete(id);
      const ids = new Set(openIds$.value);
      ids.delete(id);
      openIds$.next(ids);
    }
    if (!win.closed) win.close();
  };
  const closeSoon = (): void => {
    clearTimeout(grace);
    grace = setTimeout(close, TRACK_GRACE_MS);
  };

  popouts.set(id, { window: win, close });
  openIds$.next(new Set(openIds$.value).add(id));

  subscriptions.push(
    video.mediaStreamTrack$.subscribe(
      // Undefined for a while during a resubscription, and for good once the
      // publication is gone
      (track) => {
        if (track === undefined || track.readyState === "ended") {
          element.srcObject = null;
          closeSoon();
          return;
        }
        clearTimeout(grace);
        track.addEventListener("ended", closeSoon, { once: true });
        element.srcObject = new MediaStream([track]);
        element.play().catch(() => undefined);
      },
    ),
  );
  // The user closing the window is only seen by looking
  win.addEventListener("pagehide", () => setTimeout(close, 0));
  const poll = setInterval(() => {
    if (win.closed) close();
  }, 1000);
  return true;
}

/** For when the call is left. */
export function closeAllPopouts(): void {
  // Closing takes the entry out of the map, hence the copy
  for (const popout of Array.from(popouts.values())) popout.close();
}

if (typeof window !== "undefined")
  window.addEventListener("pagehide", closeAllPopouts);
