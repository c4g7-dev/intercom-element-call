/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { BehaviorSubject } from "rxjs";

import { type ShareAudioMixSource } from "../settings/settings";
import {
  type ShareAudioMode,
  sinkChoice,
  sinkOfChoice,
} from "./shareAudioSink";
import { type ShareAudioHost } from "../HostBridge";
import { diag } from "../diagnostics/diag";

/** The systems a share's audio differs between. */
export type SharePlatform = "linux" | "windows" | "macos" | "other";

/** The system the call runs on, from what the browser says of itself. */
export function sharePlatform(userAgent: string): SharePlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes("android") || /iphone|ipad|ipod/.test(ua)) return "other";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  if (ua.includes("linux") || ua.includes("x11")) return "linux";
  return "other";
}

/**
 * Where a share's sound comes from before the user chose anything. Windows
 * and macOS hand the system's sound over with the screen. On Linux the
 * screen picker has none to give: the sound is a mix of outputs and inputs,
 * which somebody has to pick first.
 */
export function defaultShareAudio(platform: SharePlatform): ShareAudioMode {
  return platform === "linux" ? "none" : "system";
}

export interface QuickShareInputs {
  /** Whether a share is on. */
  sharing: boolean;
  /** Whether the user ever started a share from the dialog on this device. */
  configured: boolean;
  /** Whether a dialog can be shown at all (not in a picture-in-picture). */
  canShowDialog: boolean;
  mode: ShareAudioMode;
  mix: ShareAudioMixSource[];
  /**
   * The ids of the audio sources that are there right now; undefined where
   * that could not be found out, which is nobody's fault and nothing to
   * report.
   */
  available?: ReadonlySet<string>;
}

export type QuickShareDecision =
  | { do: "stop" }
  /** Nothing is saved yet: the dialog asks first. */
  | { do: "dialog" }
  /**
   * Straight to the system's picker with what was used last. The sources of
   * `missing` are not there any more: the share starts without them.
   */
  | { do: "start"; missing: string[] };

/**
 * What the share button does when pressed: stop the share that is on, start
 * one right away with the settings of the last one, or, the first time on
 * this device, ask.
 */
export function decideQuickShare({
  sharing,
  configured,
  canShowDialog,
  mode,
  mix,
  available,
}: QuickShareInputs): QuickShareDecision {
  if (sharing) return { do: "stop" };
  if (!configured && canShowDialog) return { do: "dialog" };
  const missing =
    mode === "mix" && available !== undefined
      ? mix.filter((s) => !available.has(s.id)).map((s) => s.id)
      : [];
  return { do: "start", missing };
}

/** What a source that is gone is called in the notice about it. */
export function missingSourceName(id: string): string | undefined {
  return sinkOfChoice(id);
}

/** The dialog of the share that is open, if one is. */
export type ShareDialog = "settings" | "audio" | null;

const shareDialogSubject$ = new BehaviorSubject<ShareDialog>(null);
/**
 * Which of the share's dialogs is open. Kept here and not in the button that
 * opens them, as the host's buttons and shortcuts open them too.
 */
export const shareDialog$ = shareDialogSubject$;
export function setShareDialog(dialog: ShareDialog): void {
  if (shareDialogSubject$.value !== dialog) shareDialogSubject$.next(dialog);
}

/**
 * The sources a share was started without, for the notice that says so;
 * null while there is nothing to say.
 */
export const shareNotice$ = new BehaviorSubject<string[] | null>(null);

interface DeviceLists {
  audioInput: { available$: { value: ReadonlyMap<string, unknown> } };
  shareAudioSources$?: { value: ReadonlyMap<string, unknown> };
}

/**
 * The ids of the audio sources that are there right now: the host's outputs
 * and the browser's inputs. Undefined where that cannot be told: the host
 * does not answer in time, or the browser lists no input at all (which is
 * what it does before it may name them).
 */
export async function availableShareSources(
  host: ShareAudioHost | undefined,
  devices: DeviceLists,
  timeoutMs = 1500,
): Promise<Set<string> | undefined> {
  const inputs = [
    ...devices.audioInput.available$.value.keys(),
    ...(devices.shareAudioSources$?.value.keys() ?? []),
  ];
  if (inputs.length === 0) return undefined;
  const ids = new Set(inputs);
  if (host !== undefined) {
    const sinks = await Promise.race([
      host.listSinks().catch(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    if (sinks === undefined) return undefined;
    for (const sink of sinks.sinks) ids.add(sinkChoice(sink.name));
  }
  return ids;
}

interface PressShareInputs extends Omit<QuickShareInputs, "available"> {
  /** Starts the share, or stops the one that is on. */
  toggle: () => void;
  /** Finds out which sources are there; see {@link availableShareSources}. */
  available?: () => Promise<ReadonlySet<string> | undefined>;
  /** What asked: the button, the keyboard, the host. */
  source: string;
}

/**
 * The share button pressed, wherever it is: in the call, in the host's
 * panel, on the keyboard or on the command line.
 * @returns what was done about it
 */
export function pressShare({
  toggle,
  available,
  source,
  ...inputs
}: PressShareInputs): QuickShareDecision["do"] {
  const decision = decideQuickShare(inputs);
  diag("quick_share", { do: decision.do, source });
  if (decision.do === "dialog") {
    setShareDialog("settings");
    return decision.do;
  }
  shareNotice$.next(null);
  toggle();
  if (decision.do === "start" && inputs.mode === "mix" && available)
    // The share does not wait for this: it is only for the notice
    void available()
      .then((ids) => {
        const late = decideQuickShare({ ...inputs, available: ids });
        if (late.do === "start" && late.missing.length > 0) {
          diag("quick_share_missing", { count: late.missing.length });
          shareNotice$.next(late.missing);
        }
      })
      .catch(() => undefined);
  return decision.do;
}
