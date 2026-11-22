/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ShareAudioHost, type ShareSink } from "../HostBridge";

/**
 * How the share audio setting says "what plays into this output": the prefix
 * and the sink's name. The device made for it only exists while it is shared,
 * so it is the sink that is remembered and not a device id.
 */
export const SINK_CHOICE_PREFIX = "sink:";

/** What the host calls the devices it makes, which are not offered as inputs. */
export const SHARE_DEVICE_LABEL_PREFIX = "InterCom share: ";

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
