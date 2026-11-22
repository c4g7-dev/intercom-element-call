/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { TooltipProvider } from "@vector-im/compound-web";
import { type ComponentProps } from "react";

import { MediaView } from "./MediaView";
import { mockVideoTrack } from "../utils/test";
import { constant } from "../state/Behavior";

describe("MediaView", () => {
  const track = mockVideoTrack({ source: "camera" });

  const baseProps: ComponentProps<typeof MediaView> = {
    displayName: "some name",
    videoEnabled: true,
    targetWidth: 300,
    targetHeight: 200,
    mirror: false,
    unencryptedWarning: false,
    showNameTags: true,
    video: track,
    userId: "@alice:example.com",
    mxcAvatarUrl: undefined,
    focusable: true,
  };

  test("is accessible", async () => {
    const { container } = render(<MediaView {...baseProps} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  describe("with no video", () => {
    it("shows avatar", () => {
      render(<MediaView {...baseProps} video={undefined} />);
      expect(
        screen.getByRole("img", { name: "@alice:example.com" }),
      ).toBeVisible();
      expect(screen.queryByTestId("video")).toBe(null);
    });
  });

  describe("with video", () => {
    it("labels the video element with the track source", () => {
      render(
        <MediaView
          {...baseProps}
          video={mockVideoTrack({ source: "screenShare" })}
        />,
      );
      expect(screen.getByTestId("video")).toHaveAttribute(
        "data-source",
        "screenShare",
      );
    });
  });

  describe("tile actions", () => {
    it("shows the tile fullscreen from its button and on a double click", async () => {
      const requestFullscreen = vi.fn(async () => Promise.resolve());
      HTMLElement.prototype.requestFullscreen = requestFullscreen;
      render(<MediaView {...baseProps} />);

      // Shown on hover only, which a test DOM has no way to do
      fireEvent.click(screen.getByTestId("tile_fullscreen"));
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(requestFullscreen.mock.contexts[0]).toBe(
        screen.getByTestId("videoTile"),
      );

      await userEvent.dblClick(screen.getByTestId("video"));
      expect(requestFullscreen).toHaveBeenCalledTimes(2);
    });

    it("asks for the best quality of a screen share, and of a camera only when fullscreen", () => {
      const camera = mockVideoTrack({ source: "camera" });
      const screenShare = mockVideoTrack({ source: "screenShare" });
      render(<MediaView {...baseProps} video={camera} />);
      render(<MediaView {...baseProps} video={screenShare} />);
      expect(camera.requestHighQuality).not.toHaveBeenCalled();
      expect(screenShare.requestHighQuality).toHaveBeenCalledOnce();
    });

    it("offers no window or fullscreen without a video, and a volume only with controls", async () => {
      const { unmount } = render(
        <MediaView {...baseProps} video={undefined} />,
      );
      expect(screen.queryByTestId("tile_actions")).toBe(null);
      unmount();

      const adjustPlaybackVolume = vi.fn();
      render(
        <MediaView
          {...baseProps}
          video={undefined}
          volumeControls={{
            playbackVolume$: constant(1),
            playbackMuted$: constant(false),
            togglePlaybackMuted: vi.fn(),
            adjustPlaybackVolume,
            commitPlaybackVolume: vi.fn(),
          }}
        />,
      );
      expect(screen.queryByTestId("tile_fullscreen")).toBe(null);
      const slider = screen.getByRole("slider", { name: "Volume" });
      expect(slider).toHaveAttribute("max", "200");
      fireEvent.change(slider, { target: { value: "150" } });
      expect(adjustPlaybackVolume).toHaveBeenCalledWith(1.5);
    });
  });

  describe("name tag", () => {
    test("is shown with name", () => {
      render(<MediaView {...baseProps} displayName="Bob" />);
      expect(screen.getByTestId("name_tag")).toHaveTextContent("Bob");
    });
  });

  describe("waitingForMedia", () => {
    test("defaults to false", () => {
      render(<MediaView {...baseProps} />);
      expect(screen.queryAllByText("Waiting for media...").length).toBe(0);
    });
    test("shows and is accessible", async () => {
      const { container } = render(
        <TooltipProvider>
          <MediaView {...baseProps} waitingForMedia={true} />
        </TooltipProvider>,
      );
      expect(await axe(container)).toHaveNoViolations();
      expect(screen.getByText("Waiting for media...")).toBeVisible();
    });
  });

  describe("unencryptedWarning", () => {
    test("is shown and accessible", async () => {
      const { container } = render(
        <TooltipProvider>
          <MediaView {...baseProps} unencryptedWarning={true} />
        </TooltipProvider>,
      );
      expect(await axe(container)).toHaveNoViolations();
      expect(screen.getByRole("img", { name: "Not encrypted" })).toBeTruthy();
    });

    test("is shown and accessible even with name tag hidden", async () => {
      const { container } = render(
        <TooltipProvider>
          <MediaView {...baseProps} unencryptedWarning showNameTags={false} />
        </TooltipProvider>,
      );
      expect(await axe(container)).toHaveNoViolations();
      screen.getByRole("img", { name: "Not encrypted" });
    });

    test("is not shown", () => {
      render(
        <TooltipProvider>
          <MediaView {...baseProps} unencryptedWarning={false} />
        </TooltipProvider>,
      );
      expect(
        screen.queryAllByRole("img", { name: "Not encrypted" }).length,
      ).toBe(0);
    });
  });
});
