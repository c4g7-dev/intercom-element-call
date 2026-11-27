/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ReactNode, useEffect, useMemo } from "react";
import { fromEvent, map, filter } from "rxjs";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScreenShareDialog } from "./ScreenShareDialog";
import { ShareSplitButton } from "./ShareSplitButton";
import {
  type HostBridge,
  HostBridgeProvider,
  nullHostBridge,
  type ShareAudioHost,
} from "../HostBridge";
import {
  type HostOverlayChannel,
  type OverlayEvent,
  parseOverlayEvent,
  parseOverlayPlacement,
} from "../state/hostOverlay";
import { useHostOverlayPin } from "../useHostOverlay";
import { useBehavior } from "../useBehavior";
import { setShareDialog, shareDialog$ } from "../state/quickShare";
import { Config } from "../config/Config";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { type MediaDevices } from "../state/MediaDevices";
import { constant } from "../state/Behavior";
import {
  screenShareAudioMix,
  screenShareAudioSource,
} from "../settings/settings";

Config.initDefault();

const devices = {
  audioInput: {
    available$: constant(
      new Map([["mic-1", { type: "name", name: "USB Headset Mono" }]]),
    ),
  },
} as unknown as MediaDevices;

const shareAudio: ShareAudioHost = {
  listSinks: async () =>
    Promise.resolve({
      supported: true,
      sinks: [
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
      ],
    }),
  prepareShareSource: async (sink) =>
    Promise.resolve({ description: `InterCom share: ${sink}` }),
  releaseShareSource: async () => Promise.resolve(),
};

/**
 * The host's side of the overlay as a page that frames this story plays it:
 * it is asked with a message, gives the frame its whole window and answers
 * with the place the frame had. Without such a page around the story nobody
 * answers, and the dialog opens inside the frame.
 */
function framedOverlay(): HostOverlayChannel {
  const ask = async (op: string): Promise<unknown> =>
    new Promise((resolve) => {
      const done = (ev: MessageEvent): void => {
        if (ev.data?.intercomOverlayReply !== op) return;
        window.removeEventListener("message", done);
        resolve(ev.data);
      };
      window.addEventListener("message", done);
      window.parent.postMessage({ intercomOverlay: op }, "*");
      setTimeout(() => resolve(undefined), 500);
    });
  return {
    open: async () => parseOverlayPlacement(await ask("open")),
    close: async () => void (await ask("close")),
    events$: fromEvent<MessageEvent>(window, "message").pipe(
      map((ev) => parseOverlayEvent(ev.data?.intercomOverlayEvent)),
      filter((event): event is OverlayEvent => event !== undefined),
    ),
  };
}

function CallArea(): ReactNode {
  useHostOverlayPin();
  const dialog = useBehavior(shareDialog$);
  useEffect(() => {
    screenShareAudioSource.setValue("mix");
    screenShareAudioMix.setValue([
      { id: "sink:virtual-music", gain: 0.8, muted: false },
      { id: "sink:virtual-game", gain: 1.2, muted: false },
    ]);
    return (): void => setShareDialog(null);
  }, []);
  return (
    // What the page of the call is: the stylesheet pins it by this id
    <div
      id="root"
      style={{
        blockSize: "100vh",
        display: "grid",
        placeItems: "end center",
        padding: 24,
        boxSizing: "border-box",
        background: "var(--cpd-color-bg-canvas-default)",
      }}
    >
      <ShareSplitButton
        sharing={false}
        size="lg"
        onShare={() => setShareDialog("settings")}
        onSettings={() => setShareDialog("settings")}
      />
      {dialog === "settings" && (
        <ScreenShareDialog
          open
          onDismiss={() => setShareDialog(null)}
          onShare={() => setShareDialog(null)}
        />
      )}
    </div>
  );
}

function Wrapper(): ReactNode {
  const bridge = useMemo<HostBridge>(
    () => ({ ...nullHostBridge, shareAudio, overlay: framedOverlay() }),
    [],
  );
  return (
    <MediaDevicesContext value={devices}>
      <HostBridgeProvider value={bridge}>
        <CallArea />
      </HostBridgeProvider>
    </MediaDevicesContext>
  );
}

const meta = {
  component: Wrapper,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Wrapper>;

export default meta;

/**
 * A call in a part of a host's window. Alone, the dialog opens within the
 * frame; framed by a page that answers the overlay messages, it has that
 * page's whole window, and the call stays where it was.
 */
export const ShareDialogInAHost: StoryObj<typeof meta> = {};
