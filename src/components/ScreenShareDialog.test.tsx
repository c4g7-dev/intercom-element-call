/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@vector-im/compound-web";
import { type ReactNode } from "react";

import { ScreenShareDialog, ShareAudioDialog } from "./ScreenShareDialog";
import {
  HostBridgeProvider,
  nullHostBridge,
  type ShareAudioHost,
} from "../HostBridge";
import {
  screenShareAudioMix,
  screenShareAudioSource,
  screenShareConfigured,
  screenShareCustomFramerate,
  screenSharePreset,
} from "../settings/settings";
import { shareAudioMixStatus$ } from "../state/shareAudioMixer";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { mockMediaDevices } from "../utils/test";
import { constant } from "../state/Behavior";

const devices = mockMediaDevices({
  audioInput: {
    available$: constant(
      new Map([["mic", { type: "name", name: "Microphone" }]]),
    ),
    selected$: constant(undefined),
    select(): void {},
  } as never,
  // What the microphone list leaves out
  shareAudioSources$: constant(
    new Map([
      ["d-music", { type: "name", name: "InterCom-Share-Music" }],
      ["d-phone", { type: "name", name: "InterCom-Share-Phone" }],
    ]),
  ) as never,
});

const sinks = [
  {
    name: "virtual-music",
    description: "Virtual Music",
    apps: ["Spotify", "mpv"],
    ownPlayback: false,
    // The user's own remap already carries this output
    source: "InterCom-Share-Music",
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
  props: { onDismiss?: () => void; onShare?: () => void; live?: boolean } = {},
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
  if (props.live) {
    render(wrap(<ShareAudioDialog open={true} onDismiss={vi.fn()} />));
    return;
  }
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

describe("the share dialog's audio sources", () => {
  beforeEach(() => {
    screenShareAudioSource.setValue("system");
    screenShareAudioMix.setValue([]);
    shareAudioMixStatus$.next({});
  });
  afterEach(() => {
    screenShareAudioSource.setValue("system");
    screenShareAudioMix.setValue([]);
    shareAudioMixStatus$.next({});
  });

  const pickMix = async (
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> => {
    await user.click(screen.getByRole("radio", { name: "Chosen sources" }));
    await screen.findByTestId("screenshare_audio_group_outputs");
  };

  it("lists the host's outputs with what plays into them, the share sources and the inputs", async () => {
    const user = userEvent.setup();
    renderDialog(host());
    await pickMix(user);
    const group = screen.getByTestId("screenshare_audio_group_outputs");
    expect(group).toHaveTextContent("Apps and outputs");
    expect(
      screen.getByRole("checkbox", { name: /^Virtual Music/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: /^Virtual Discord \(this call plays here\)/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Microphone" })).toBeVisible();
    // The input that carries a listed output is that output, listed once;
    // one that carries something else is a source of its own
    expect(
      screen.queryByRole("checkbox", { name: "InterCom-Share-Music" }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "InterCom-Share-Phone" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["the host has no way to share an output", host(false)],
    ["there is no host", undefined],
  ])(
    "has no outputs to offer when %s, only devices",
    async (_why, shareAudio) => {
      const user = userEvent.setup();
      renderDialog(shareAudio);
      await user.click(screen.getByRole("radio", { name: "Chosen sources" }));
      if (shareAudio)
        await waitFor(() => expect(shareAudio.listSinks).toHaveBeenCalled());
      expect(
        screen.queryByTestId("screenshare_audio_group_outputs"),
      ).toBeNull();
      expect(
        screen.getByRole("checkbox", { name: "InterCom-Share-Music" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("checkbox", { name: "Microphone" }),
      ).toBeVisible();
    },
  );

  it("mixes several ticked sources, each with a gain and a mute, and keeps them", async () => {
    const user = userEvent.setup();
    renderDialog(host());
    await waitFor(() =>
      expect(screen.queryByTestId("screenshare_audio_sources")).toBeNull(),
    );
    await pickMix(user);
    await user.click(screen.getByRole("checkbox", { name: /^Virtual Music/ }));
    await user.click(
      screen.getByRole("checkbox", { name: "InterCom-Share-Phone" }),
    );
    expect(screenShareAudioSource.getValue()).toBe("mix");
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "sink:virtual-music", gain: 1, muted: false },
      { id: "d-phone", gain: 1, muted: false },
    ]);

    const slider = screen.getByRole("slider", {
      name: "Volume of InterCom-Share-Phone",
    });
    expect(slider).toHaveAttribute("max", "200");
    fireEvent.change(slider, { target: { value: "150" } });
    await user.click(
      screen.getByRole("button", {
        name: "Mute Virtual Music",
      }),
    );
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "sink:virtual-music", gain: 1, muted: true },
      { id: "d-phone", gain: 1.5, muted: false },
    ]);

    await user.click(screen.getByRole("checkbox", { name: /^Virtual Music/ }));
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "d-phone", gain: 1.5, muted: false },
    ]);
  });

  it("ticking a source chooses the mix", async () => {
    const user = userEvent.setup();
    // What an older version left behind: a source picked under another mode
    screenShareAudioSource.setValue("none");
    renderDialog(host());
    expect(screen.queryByTestId("screenshare_audio_sources")).toBeNull();
    await pickMix(user);
    await user.click(screen.getByRole("checkbox", { name: "Microphone" }));
    expect(screenShareAudioSource.getValue()).toBe("mix");
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "mic", gain: 1, muted: false },
    ]);
  });

  it("keeps the mix while the mode is another, to come back to", async () => {
    const user = userEvent.setup();
    screenShareAudioSource.setValue("mix");
    screenShareAudioMix.setValue([{ id: "mic", gain: 1.4, muted: false }]);
    renderDialog(host());
    await user.click(screen.getByRole("radio", { name: "No audio" }));
    // The list is only there for the mix
    expect(screen.queryByTestId("screenshare_audio_sources")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "System audio" }));
    expect(screen.getByRole("radio", { name: "System audio" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Chosen sources" }));
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "mic", gain: 1.4, muted: false },
    ]);
    expect(screen.getByRole("checkbox", { name: "Microphone" })).toBeChecked();
  });

  it("finds sources by their name or by an app playing into them", async () => {
    const user = userEvent.setup();
    renderDialog(host());
    await pickMix(user);
    await user.type(
      screen.getByRole("searchbox", { name: "Search sources and apps" }),
      "spotify",
    );
    expect(
      screen.getByRole("checkbox", { name: /^Virtual Music/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Microphone" })).toBeNull();
    // "All" takes what the search shows, and nothing else
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "sink:virtual-music", gain: 1, muted: false },
    ]);
    await user.clear(
      screen.getByRole("searchbox", { name: "Search sources and apps" }),
    );
    expect(screen.getByTestId("screenshare_audio_count")).toHaveTextContent(
      "1 of 4",
    );
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(screenShareAudioMix.getValue()).toEqual([]);
  });

  it("offers what to optimise for as cards, and says what the share will be", async () => {
    const user = userEvent.setup();
    screenSharePreset.setValue("sharp");
    screenShareCustomFramerate.setValue(0);
    renderDialog(host());
    expect(screen.getByRole("radio", { name: /Text \/ sharp/ })).toBeChecked();
    expect(screen.getByTestId("screenshare_summary")).toHaveTextContent(
      "Text / sharp · Auto (max 1440p) · 30 fps · System audio",
    );
    await user.click(screen.getByRole("radio", { name: /Motion \/ smooth/ }));
    expect(screenSharePreset.getValue()).toBe("motion");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Frame rate" }),
      "120",
    );
    expect(screenShareCustomFramerate.getValue()).toBe(120);
    await pickMix(user);
    await user.click(screen.getByRole("checkbox", { name: "Microphone" }));
    expect(screen.getByTestId("screenshare_summary")).toHaveTextContent(
      "Motion / smooth · Auto (max 1440p) · 120 fps · 1 audio source",
    );
    screenSharePreset.setValue("sharp");
    screenShareCustomFramerate.setValue(0);
  });

  it("reads the one source an older version stored as a mix of one", async () => {
    screenShareAudioSource.setValue("sink:virtual-music");
    renderDialog(host());
    await waitFor(() => expect(screenShareAudioSource.getValue()).toBe("mix"));
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "sink:virtual-music", gain: 1, muted: false },
    ]);
    expect(
      await screen.findByRole("checkbox", {
        name: /^Virtual Music/,
      }),
    ).toBeChecked();
  });

  it("keeps listing a picked source that is not there, so it can be dropped", async () => {
    const user = userEvent.setup();
    screenShareAudioSource.setValue("mix");
    screenShareAudioMix.setValue([{ id: "sink:gone", gain: 1, muted: false }]);
    renderDialog(host());
    const gone = await screen.findByRole("checkbox", { name: "gone" });
    expect(gone).toBeChecked();
    await user.click(gone);
    expect(screenShareAudioMix.getValue()).toEqual([]);
  });

  it("warns of an echo for the output the call itself plays into", async () => {
    const user = userEvent.setup();
    renderDialog(host());
    await pickMix(user);
    expect(screen.getByTestId("screenshare_audio_hint")).toHaveAttribute(
      "data-warning",
      "false",
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /^Virtual Discord \(this call plays here\)/,
      }),
    );
    const warning = await screen.findByText(/would hear themselves back/);
    expect(warning).toHaveAttribute("data-warning", "true");
  });

  it("starts the share with the choices as they are", async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    renderDialog(host(), { onShare });
    screenShareConfigured.setValue(false);
    await user.click(screen.getByTestId("screenshare_start"));
    expect(onShare).toHaveBeenCalled();
    // From here on the share button needs no dialog
    expect(screenShareConfigured.getValue()).toBe(true);
    screenShareConfigured.setValue(false);
  });
});

describe("the sources of the share that is on", () => {
  beforeEach(() => {
    screenShareAudioSource.setValue("mix");
    screenShareAudioMix.setValue([{ id: "mic", gain: 1, muted: false }]);
  });
  afterEach(() => {
    screenShareAudioSource.setValue("system");
    screenShareAudioMix.setValue([]);
    shareAudioMixStatus$.next({});
  });

  it("can be added to, taken from and balanced, but not switched to the picker's audio", async () => {
    const user = userEvent.setup();
    renderDialog(host(), { live: true });
    await screen.findByTestId("screenshare_audio_group_outputs");
    expect(screen.getByRole("radio", { name: "System audio" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /^Virtual Music/ }));
    await user.click(screen.getByRole("checkbox", { name: "Microphone" }));
    expect(screenShareAudioMix.getValue()).toEqual([
      { id: "sink:virtual-music", gain: 1, muted: false },
    ]);
  });

  it("says so when a source could not be opened", async () => {
    shareAudioMixStatus$.next({ mic: "failed" });
    renderDialog(host(), { live: true });
    expect(await screen.findByText(/could not be opened/)).toHaveAttribute(
      "data-warning",
      "true",
    );
  });

  it("is fixed for a share that takes its sound from the picker", () => {
    screenShareAudioSource.setValue("system");
    renderDialog(host(), { live: true });
    expect(screen.getByRole("radio", { name: "No audio" })).toBeDisabled();
    expect(
      screen.getByRole("radio", { name: "Chosen sources" }),
    ).toBeDisabled();
    expect(screen.getByText(/only be changed by sharing again/)).toBeVisible();
    expect(screen.queryByTestId("screenshare_audio_sources")).toBeNull();
  });
});
