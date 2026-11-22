/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ShareAudioHost, type ShareSink } from "../HostBridge";
import { type ShareAudioMixSource } from "../settings/settings";

/**
 * How the share audio setting says "what plays into this output": the prefix
 * and the sink's name. The device made for it only exists while it is shared,
 * so it is the sink that is remembered and not a device id.
 */
export const SINK_CHOICE_PREFIX = "sink:";

/**
 * The audio inputs that exist to carry an output's sound into a share: the
 * ones the host makes and the ones a user set up by the same names. They are
 * offered as share audio and kept out of the microphone list.
 */
const SHARE_SOURCE_LABEL = /^(InterCom-Share|InterCom-Screen|InterCom share: )/;

export function isShareSourceLabel(label: string): boolean {
  return SHARE_SOURCE_LABEL.test(label);
}

export type ShareAudioMode = "none" | "system" | "mix";

/** What the share audio setting says, an old value being a mix of one. */
export function shareAudioMode(choice: string): ShareAudioMode {
  return choice === "none" || choice === "system" ? choice : "mix";
}

const MAX_MIX_GAIN = 2;

/** A stored mix as it can be trusted: known shapes, each source once. */
export function sanitizeMix(value: unknown): ShareAudioMixSource[] {
  if (!Array.isArray(value)) return [];
  const mix = new Map<string, ShareAudioMixSource>();
  for (const entry of value as Partial<ShareAudioMixSource>[]) {
    if (typeof entry?.id !== "string" || entry.id === "" || mix.has(entry.id))
      continue;
    const gain = Number(entry.gain);
    mix.set(entry.id, {
      id: entry.id,
      gain: Number.isFinite(gain)
        ? Math.min(Math.max(gain, 0), MAX_MIX_GAIN)
        : 1,
      muted: entry.muted === true,
    });
  }
  return [...mix.values()];
}

/**
 * The sources a share's audio is mixed from, for the two settings: none
 * unless the mode is `mix`, and the one source an old setting named.
 */
export function shareAudioMix(
  choice: string,
  mix: unknown,
): ShareAudioMixSource[] {
  if (shareAudioMode(choice) !== "mix") return [];
  if (choice !== "mix") return [{ id: choice, gain: 1, muted: false }];
  return sanitizeMix(mix);
}

export function sinkChoice(sinkName: string): string {
  return SINK_CHOICE_PREFIX + sinkName;
}

/** The sink a share audio choice names, if it names one. */
export function sinkOfChoice(choice: string): string | undefined {
  return choice.startsWith(SINK_CHOICE_PREFIX) &&
    choice.length > SINK_CHOICE_PREFIX.length
    ? choice.slice(SINK_CHOICE_PREFIX.length)
    : undefined;
}

/** A sink as one line of a list: what it is and what is playing into it. */
export function sinkLabel(sink: ShareSink): string {
  return sink.apps.length > 0
    ? `${sink.description} — ${sink.apps.join(", ")}`
    : sink.description;
}

type DeviceInfo = Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">;

/** The audio input that goes by a description, if the browser lists it. */
export function findDeviceByDescription(
  devices: DeviceInfo[],
  description: string,
): string | undefined {
  const inputs = devices.filter(
    (d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default",
  );
  return (
    inputs.find((d) => d.label === description) ??
    // Chromium may put the device's kind or form factor after the name
    inputs.find((d) => d.label.startsWith(description))
  )?.deviceId;
}

interface PrepareOptions {
  enumerate?: () => Promise<DeviceInfo[]>;
  /** How long to wait for the browser to list the new device. */
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Has the host make a capture device of what plays into a sink and waits for
 * the browser to list it.
 * @returns the id of the device, to capture the share's audio from
 * @throws if the host cannot make it or the browser never lists it
 */
export async function prepareSinkDevice(
  host: ShareAudioHost,
  sinkName: string,
  {
    enumerate = async (): Promise<DeviceInfo[]> =>
      navigator.mediaDevices.enumerateDevices(),
    // Short of how long a click stays good for the screen picker that follows
    timeoutMs = 3000,
    intervalMs = 150,
  }: PrepareOptions = {},
): Promise<string> {
  const { description } = await host.prepareShareSource(sinkName);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const deviceId = findDeviceByDescription(await enumerate(), description);
    if (deviceId !== undefined) return deviceId;
    if (Date.now() >= deadline)
      throw new Error("The browser does not list the share's audio device");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
