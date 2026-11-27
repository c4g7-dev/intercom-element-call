/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, fn, userEvent, within } from "storybook/test";
import { type JSX, type ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { MediaMenuButton } from "./MediaMenuButton";
import { type MediaMenuSnapshot } from "./MediaMenuViewModel";
import { useStaticViewModel } from "../state/ViewModel";
import { MediaDevicesContext } from "../MediaDevicesContext";
import { MediaDevices } from "../state/MediaDevices";
import { globalScope } from "../state/ObservableScope";

const mediaDevices = new MediaDevices(globalScope, {
  controlledAudioDevices: false,
});

/** Builds the view model from the story's args, so each field is a control. */
function MediaMenuButtonStoryWrapper({
  kind,
  ...snapshot
}: MediaMenuSnapshot & { kind: "audio" | "video" }): ReactNode {
  const vm = useStaticViewModel(snapshot);
  return <MediaMenuButton kind={kind} vm={vm} size="lg" />;
}

const meta = {
  component: MediaMenuButtonStoryWrapper,
  decorators: [
    (Story): JSX.Element => (
      <MediaDevicesContext value={mediaDevices}>
        <Story />
      </MediaDevicesContext>
    ),
  ],
} satisfies Meta<typeof MediaMenuButtonStoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

const empty = {
  unavailable: undefined,
  outputOptions: [],
  selectedOutput: undefined,
  selectOutput: undefined,
  backgroundEffect: undefined,
  backgroundEffects: [],
  backgroundEffectNotice: undefined,
  backgroundEffectSettling: false,
  backgroundImageRefusal: undefined,
  selectBackgroundEffect: undefined,
  addBackgroundImage: undefined,
  removeBackgroundEffect: undefined,
  cameraTrack: null,
} satisfies Partial<MediaMenuSnapshot>;

export const Microphone: Story = {
  args: {
    ...empty,
    kind: "audio",
    enabled: true,
    busy: false,
    toggle: fn(),
    options: [
      { id: "mic1", label: { type: "name", name: "Microphone 1" } },
      { id: "mic2", label: { type: "name", name: "Microphone 2" } },
    ],
    selected: "mic1",
    select: fn(),
    outputOptions: [
      { id: "default", label: { type: "default", name: "Built-in Output" } },
    ],
    selectedOutput: "default",
    selectOutput: fn(),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("switch", { name: "Mute microphone" }),
    );
    await expect(args.toggle).toHaveBeenCalled();
  },
};

export const Camera: Story = {
  args: {
    ...empty,
    kind: "video",
    enabled: true,
    busy: false,
    toggle: fn(),
    options: [{ id: "cam1", label: { type: "name", name: "Camera 1" } }],
    selected: "cam1",
    select: fn(),
    backgroundEffect: "none",
    backgroundEffects: [
      { id: "none", kind: "none" },
      { id: "blur", kind: "blur" },
    ],
    selectBackgroundEffect: fn(),
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("switch", { name: "Stop video" }),
    );
    await expect(args.toggle).toHaveBeenCalled();
  },
};

export const CameraBusy: Story = {
  args: { ...Camera.args, busy: true },
};

/** Opens the effects, for the stories that check what they say. */
async function openEffects(canvasElement: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(
    within(canvasElement).getByRole("button", { name: "Camera" }),
  );
  return within(document.body).findByRole("group", {
    name: "Background effects",
  });
}

/** The view model says why; the view says it in words. */
export const CameraEffectsUnavailable: Story = {
  args: {
    ...Camera.args,
    selectBackgroundEffect: undefined,
    backgroundEffectNotice: "unavailable",
  },
  play: async ({ canvasElement }) => {
    const section = await openEffects(canvasElement);
    await expect(
      within(section).getByRole("group"),
    ).toHaveAccessibleDescription(
      "Background effects are not supported on this platform.",
    );
  },
};

export const CameraEffectsSlow: Story = {
  args: {
    ...Camera.args,
    backgroundEffectNotice: "slow",
  },
  play: async ({ canvasElement }) => {
    const section = await openEffects(canvasElement);
    await expect(
      within(section).getByRole("group"),
    ).toHaveAccessibleDescription(
      "Background effects run slowly on this platform, which may cause your video to stutter.",
    );
  },
};

export const CameraFileRefused: Story = {
  args: {
    ...Camera.args,
    addBackgroundImage: fn(),
    backgroundImageRefusal: { reason: "not-an-image", dismiss: fn() },
  },
  play: async ({ canvasElement }) => {
    await openEffects(canvasElement);
    await expect(
      await within(document.body).findByText(
        "That file is not a supported image",
      ),
    ).toBeInTheDocument();
  },
};

/** No devices to pick and none to mute: a plain, disabled mute button. */
export const WithoutDevices: Story = {
  args: {
    ...Camera.args,
    enabled: false,
    toggle: undefined,
    options: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: "Camera" }),
    ).not.toBeInTheDocument();
    await expect(canvas.getByTestId("incall_videomute")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

export const MicrophoneMuted: Story = {
  args: { ...Microphone.args, enabled: false },
  play: undefined,
};

export const CameraOff: Story = {
  args: { ...Camera.args, enabled: false },
  play: undefined,
};

/** Checks that the button says why it does nothing, and does nothing. */
async function expectUnavailable(
  canvasElement: HTMLElement,
  name: string,
  reason: string,
  toggle: unknown,
): Promise<void> {
  const button = within(canvasElement).getByRole("switch", { name });
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAccessibleDescription(reason);
  await userEvent.click(button);
  await expect(toggle).not.toHaveBeenCalled();
}

/** No microphone, and no speaker to pick either: the button alone. */
export const MicrophoneNotFound: Story = {
  args: {
    ...Microphone.args,
    enabled: false,
    toggle: undefined,
    unavailable: "no-device",
    options: [],
    outputOptions: [],
  },
  play: async ({ canvasElement }) =>
    expectUnavailable(canvasElement, "Microphone", "No microphone found", fn()),
};

/** The speaker can still be picked; the menu says there is no microphone. */
export const MicrophoneNotFoundWithSpeaker: Story = {
  args: {
    ...MicrophoneNotFound.args,
    outputOptions: Microphone.args.outputOptions,
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Microphone" }),
    );
    await expect(
      await within(document.body).findByText("No microphone found"),
    ).toBeInTheDocument();
  },
};

export const MicrophoneBlocked: Story = {
  args: { ...Microphone.args, enabled: false, unavailable: "no-permission" },
  play: async ({ args, canvasElement }) =>
    expectUnavailable(
      canvasElement,
      "Microphone",
      "Microphone access blocked — check system settings",
      args.toggle,
    ),
};

export const CameraNotFound: Story = {
  args: {
    ...Camera.args,
    enabled: false,
    toggle: undefined,
    unavailable: "no-device",
    options: [],
  },
  play: async ({ canvasElement }) =>
    expectUnavailable(canvasElement, "Camera", "No camera found", fn()),
};

export const CameraBlocked: Story = {
  args: { ...Camera.args, enabled: false, unavailable: "no-permission" },
  play: async ({ args, canvasElement }) =>
    expectUnavailable(
      canvasElement,
      "Camera",
      "Camera access blocked — check system settings",
      args.toggle,
    ),
};
