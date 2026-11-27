/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, fn, userEvent, within } from "storybook/test";
import { type ReactNode, useEffect } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScreenShareDialog, ShareAudioDialog } from "./ScreenShareDialog";
import {
  HostBridgeProvider,
  nullHostBridge,
  type ShareAudioHost,
  type ShareSink,
} from "../HostBridge";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { type MediaDevices } from "../state/MediaDevices";
import { constant } from "../state/Behavior";
import { Config } from "../config/Config";
import {
  screenShareAudioMix,
  screenShareAudioSource,
  type ShareAudioMixSource,
} from "../settings/settings";

// The dialog reads the server's budget from the configuration
Config.initDefault();

const sinks: ShareSink[] = [
  {
    name: "virtual-music",
    description: "Music",
    apps: ["Spotify", "mpv"],
    ownPlayback: false,
  },
  {
    name: "virtual-game",
    description: "Game",
    apps: ["Factorio"],
    ownPlayback: false,
  },
  {
    name: "alsa_output.usb-headset",
    description: "USB Headset Analog Stereo",
    apps: ["InterCom", "Firefox"],
    ownPlayback: true,
  },
];

const shareAudio: ShareAudioHost = {
  listSinks: async () => Promise.resolve({ supported: true, sinks }),
  prepareShareSource: async (sink) =>
    Promise.resolve({ description: `InterCom share: ${sink}` }),
  releaseShareSource: async () => Promise.resolve(),
};

const devices = {
  audioInput: {
    available$: constant(
      new Map([
        ["mic-1", { type: "name", name: "USB Headset Mono" }],
        ["mic-2", { type: "name", name: "Webcam C920 Analog Stereo" }],
      ]),
    ),
  },
  shareAudioSources$: constant(
    new Map([["remap", { type: "name", name: "InterCom-Share-Stream" }]]),
  ),
} as unknown as MediaDevices;

function Wrapper({
  live,
  audio,
  mix,
  withSinks,
  onShare,
  onDismiss,
}: {
  live: boolean;
  audio: string;
  mix: ShareAudioMixSource[];
  /** Whether the host offers outputs: the InterCom desktop app on Linux. */
  withSinks: boolean;
  onShare: () => void;
  onDismiss: () => void;
}): ReactNode {
  useEffect(() => {
    screenShareAudioSource.setValue(audio);
    screenShareAudioMix.setValue(mix);
  }, [audio, mix]);
  return (
    <MediaDevicesContext value={devices}>
      <HostBridgeProvider
        value={{
          ...nullHostBridge,
          shareAudio: withSinks ? shareAudio : undefined,
        }}
      >
        {live ? (
          <ShareAudioDialog open onDismiss={onDismiss} />
        ) : (
          <ScreenShareDialog open onDismiss={onDismiss} onShare={onShare} />
        )}
      </HostBridgeProvider>
    </MediaDevicesContext>
  );
}

const meta = {
  component: Wrapper,
  parameters: { layout: "fullscreen" },
  args: {
    live: false,
    audio: "mix",
    mix: [
      { id: "sink:virtual-music", gain: 0.8, muted: false },
      { id: "sink:virtual-game", gain: 1.2, muted: false },
    ],
    withSinks: true,
    onShare: fn(),
    onDismiss: fn(),
  },
} satisfies Meta<typeof Wrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Linux: outputs with the apps playing into them, two of them picked. */
export const ChosenSources: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByRole("checkbox", { name: /^Music/ }),
    ).toBeChecked();
    await expect(body.getByTestId("screenshare_summary")).toHaveTextContent(
      "2 audio sources",
    );
    await userEvent.click(body.getByTestId("screenshare_start"));
    await expect(args.onShare).toHaveBeenCalled();
  },
};

/** Windows and macOS: the system's sound comes with the screen. */
export const SystemAudio: Story = {
  args: { audio: "system", mix: [], withSinks: false },
};

export const NoAudio: Story = {
  args: { audio: "none", mix: [], withSinks: false },
};

/** A small call area, or a phone: one column, the foot stays in view. */
export const Narrow: Story = {
  globals: { viewport: { value: "mobile2" } },
};

/** While sharing: the sources of the share's audio, live. */
export const LiveAudio: Story = {
  args: { live: true },
};
