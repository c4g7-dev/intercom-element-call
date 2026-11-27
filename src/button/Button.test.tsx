/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@vector-im/compound-web";

import { MicButton, VideoButton } from "./Button";

describe("MicButton", () => {
  test("calls onClick when not busy", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <MicButton enabled={true} onClick={onClick} />
      </TooltipProvider>,
    );

    const button = screen.getByRole("switch");
    await user.click(button);

    expect(onClick).toHaveBeenCalled();
  });

  test("does not call onClick when busy", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <MicButton enabled={true} busy={true} onClick={onClick} />
      </TooltipProvider>,
    );

    const button = screen.getByRole("switch");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("does not call onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <MicButton enabled={true} disabled={true} onClick={onClick} />
      </TooltipProvider>,
    );

    const button = screen.getByRole("switch");
    expect(button).toHaveAttribute("aria-disabled", "true");

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("VideoButton", () => {
  test("calls onClick when not busy", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <VideoButton enabled={true} onClick={onClick} />
      </TooltipProvider>,
    );

    const button = screen.getByRole("switch");
    await user.click(button);

    expect(onClick).toHaveBeenCalled();
  });

  test("does not call onClick when busy", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <VideoButton enabled={true} busy={true} onClick={onClick} />
      </TooltipProvider>,
    );

    const button = screen.getByRole("switch");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("does not call onClick when disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <TooltipProvider>
        <VideoButton enabled={true} disabled={true} onClick={onClick} />
      </TooltipProvider>,
    );

    const button = screen.getByRole("switch");
    expect(button).toHaveAttribute("aria-disabled", "true");

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("a device that is not there to be turned on", () => {
  test.each([
    [MicButton, "no-device", "Microphone", "No microphone found"],
    [
      MicButton,
      "no-permission",
      "Microphone",
      "Microphone access blocked — check system settings",
    ],
    [VideoButton, "no-device", "Camera", "No camera found"],
    [
      VideoButton,
      "no-permission",
      "Camera",
      "Camera access blocked — check system settings",
    ],
  ] as const)(
    "%o with %s says why, can be focused and does nothing",
    async (DeviceButton, unavailable, name, reason) => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(
        <TooltipProvider>
          <DeviceButton
            enabled={false}
            unavailable={unavailable}
            onClick={onClick}
          />
        </TooltipProvider>,
      );

      const button = screen.getByRole("switch", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).not.toHaveAttribute("disabled");
      expect(button).toHaveAttribute("aria-checked", "false");
      expect(button).toHaveAttribute("data-unavailable", unavailable);
      expect(button).toHaveAccessibleDescription(reason);
      // The device's own icon with a badge, not the struck-through one
      expect(
        button.querySelector("svg[data-unavailable-badge]"),
      ).toBeInTheDocument();

      await user.tab();
      expect(button).toHaveFocus();
      await user.click(button);
      await user.keyboard("{Enter}");
      expect(onClick).not.toHaveBeenCalled();
    },
  );

  test("a muted device keeps the struck-through icon and its switch", () => {
    render(
      <TooltipProvider>
        <MicButton enabled={false} />
      </TooltipProvider>,
    );
    const button = screen.getByRole("switch", { name: "Unmute microphone" });
    expect(button).not.toHaveAttribute("aria-disabled", "true");
    expect(button.querySelector("svg[data-unavailable-badge]")).toBeNull();
  });
});
