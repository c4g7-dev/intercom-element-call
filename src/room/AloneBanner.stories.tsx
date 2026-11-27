/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type JSX } from "react";
import { fn } from "storybook/test";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AloneBanner } from "./AloneBanner";

// A clock that stands still, so that the countdown is the same every time
const NOW = 1_800_000_000_000;

const meta: Meta<typeof AloneBanner> = {
  title: "InterCom/AloneBanner",
  component: AloneBanner,
  args: {
    deadline: NOW + 299_000,
    onStay: fn(),
    onLeave: fn(),
    now: (): number => NOW,
  },
  parameters: { layout: "fullscreen" },
  // The call lays itself out by the size of the element it is drawn in
  decorators: [
    (Story): JSX.Element => (
      <div style={{ container: "element-call / size", blockSize: 200 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Everybody else left a private call: when it ends, and the ways to stay or go. */
export const Default: Story = {};

/** The last seconds. */
export const AboutToLeave: Story = { args: { deadline: NOW + 7_000 } };

/** Under the notice of being deafened, which has the same place. */
export const Lowered: Story = { args: { lowered: true } };
