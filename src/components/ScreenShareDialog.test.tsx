/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@vector-im/compound-web";
import { type ReactNode } from "react";

import { ScreenShareDialog } from "./ScreenShareDialog";
import {
  HostBridgeProvider,
  nullHostBridge,
  type ShareAudioHost,
} from "../HostBridge";
import { screenShareAudioSource } from "../settings/settings";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { mockMediaDevices } from "../utils/test";
import { constant } from "../state/Behavior";

const devices = mockMediaDevices({
  audioInput: {
    available$: constant(
      new Map([
        ["mic", { type: "name", name: "Microphone" }],
        ["d1", { type: "name", name: "InterCom share: virtual-music" }],
      ]),
    ),
    selected$: constant(undefined),
    select(): void {},
  } as never,
});

const sinks = [
  {
    name: "virtual-music",
    description: "Virtual Music",
    apps: ["Spotify", "mpv"],
    ownPlayback: false,
  },
  {
    name: "virtual-discord",
    description: "Virtual Discord",
    apps: ["InterCom"],
    ownPlayback: true,
  },
];

function host(supported = true): ShareAudioHost {
  return {
    listSinks: vi
      .fn()
      .mockResolvedValue({ supported, sinks: supported ? sinks : [] }),
    prepareShareSource: vi
      .fn()
      .mockImplementation(async (sink: string) =>
        Promise.resolve({ description: `InterCom share: ${sink}` }),
      ),
    releaseShareSource: vi.fn().mockResolvedValue(undefined),
  };
}

function renderDialog(
  shareAudio: ShareAudioHost | undefined,
  props: { onDismiss?: () => void; onShare?: () => void } = {},
): void {
  const wrap = (children: ReactNode): ReactNode => (
    <TooltipProvider>
      <MediaDevicesContext value={devices}>
        <HostBridgeProvider value={{ ...nullHostBridge, shareAudio }}>
          {children}
        </HostBridgeProvider>
      </MediaDevicesContext>
    </TooltipProvider>
  );
  render(
    wrap(
      <ScreenShareDialog
        open={true}
        onDismiss={props.onDismiss ?? vi.fn()}
        onShare={props.onShare ?? vi.fn()}
      />,
    ),
  );
}

describe("ScreenShareDialog audio from an output", () => {
  beforeEach(() => {
    screenShareAudioSource.setValue("system");
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue([
          {
            kind: "audioinput",
            label: "InterCom share: virtual-music",
            deviceId: "d1",
          },
          {
            kind: "audioinput",
            label: "InterCom share: virtual-discord",
            deviceId: "d2",
          },
        ]),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    screenShareAudioSource.setValue("system");
  });

  it("lists the host's outputs with what plays into them", async () => {
    renderDialog(host());
    const group = await screen.findByTestId("screenshare_audio_sinks");
    expect(group).toHaveAttribute("label", "Apps playing into…");
    expect(
      screen.getByRole("option", { name: "Virtual Music — Spotify, mpv" }),
    ).toHaveValue("sink:virtual-music");
    expect(
      screen.getByRole("option", {
        name: "Virtual Discord — InterCom (this call plays here)",
      }),
    ).toBeInTheDocument();
    // The devices the host makes are offered as the outputs, not as inputs
    expect(screen.getByRole("option", { name: "Microphone" })).toHaveValue(
      "mic",
    );
    expect(
      screen.queryByRole("option", { name: "InterCom share: virtual-music" }),
    ).toBeNull();
  });

  it.each([
    ["the host has no way to share an output", host(false)],
    ["there is no host", undefined],
  ])("hides the section when %s", async (_why, shareAudio) => {
    renderDialog(shareAudio);
    if (shareAudio)
      await waitFor(() => expect(shareAudio.listSinks).toHaveBeenCalled());
    expect(screen.queryByTestId("screenshare_audio_sinks")).toBeNull();
    expect(screen.getByRole("option", { name: "None" })).toBeInTheDocument();
  });

  it("prepares the chosen output, remembers it and releases it when closed without sharing", async () => {
    const user = userEvent.setup();
    const shareAudio = host();
    const onDismiss = vi.fn();
    renderDialog(shareAudio, { onDismiss });
    await screen.findByTestId("screenshare_audio_sinks");
    await user.selectOptions(
      screen.getByTestId("screenshare_audio_source"),
      "sink:virtual-music",
    );
    await waitFor(() =>
      expect(shareAudio.prepareShareSource).toHaveBeenCalledWith(
        "virtual-music",
      ),
    );
    expect(screenShareAudioSource.getValue()).toBe("sink:virtual-music");
    expect(
      screen.getByText(/Shares everything that plays into this output/),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("modal_close"));
    expect(shareAudio.releaseShareSource).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalled();
  });

  it("keeps the prepared output when the share starts", async () => {
    const user = userEvent.setup();
    const shareAudio = host();
    const onShare = vi.fn();
    screenShareAudioSource.setValue("sink:virtual-music");
    renderDialog(shareAudio, { onShare });
    await waitFor(() =>
      expect(shareAudio.prepareShareSource).toHaveBeenCalledWith(
        "virtual-music",
      ),
    );
    await user.click(screen.getByTestId("screenshare_start"));
    expect(onShare).toHaveBeenCalled();
    expect(shareAudio.releaseShareSource).not.toHaveBeenCalled();
  });

  it("warns of an echo for the output the call itself plays into", async () => {
    const user = userEvent.setup();
    renderDialog(host());
    await screen.findByTestId("screenshare_audio_sinks");
    await user.selectOptions(
      screen.getByTestId("screenshare_audio_source"),
      "sink:virtual-discord",
    );
    const warning = await screen.findByText(/would hear themselves back/);
    expect(warning).toHaveAttribute("data-warning", "true");
  });

  it("says so when the output cannot be made available", async () => {
    const shareAudio = host();
    vi.mocked(shareAudio.prepareShareSource).mockRejectedValue(
      new Error("No such sink"),
    );
    screenShareAudioSource.setValue("sink:virtual-music");
    renderDialog(shareAudio);
    expect(
      await screen.findByText(/could not be made available/),
    ).toHaveAttribute("data-warning", "true");
  });
});
