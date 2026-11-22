/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { ObservableScope } from "@element-hq/matrixrtc-sdk";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { constant } from "../state/Behavior";
import { diagnosticsOverlay } from "../settings/settings";
import { mockMediaTrack } from "../utils/test";
import {
  DIAG_STATS_INTERVAL_MS,
  recordCallDiagnostics,
} from "./CallDiagnostics";
import { diag, resetDiag } from "./diag";
import { DiagnosticsOverlay } from "./DiagnosticsOverlay";
import { buildTestPattern, TEST_PATTERN_SIZES } from "./testPattern";
import { snapshotFileName } from "./snapshot";

describe("DiagnosticsOverlay", () => {
  beforeEach(() => {
    resetDiag();
    diagnosticsOverlay.setValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it("is toggled by Ctrl+Alt+D and by its close button", () => {
    render(<DiagnosticsOverlay />);
    expect(screen.queryByTestId("diagnostics_overlay")).toBeNull();

    // Ctrl+Shift+D is deafen now
    fireEvent.keyDown(document.body, {
      key: "D",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.queryByTestId("diagnostics_overlay")).toBeNull();

    fireEvent.keyDown(document.body, {
      key: "d",
      ctrlKey: true,
      altKey: true,
    });
    expect(screen.getByTestId("diagnostics_overlay")).toBeVisible();
    expect(diagnosticsOverlay.getValue()).toBe(true);

    // Not without both modifiers
    fireEvent.keyDown(document.body, { key: "d", ctrlKey: true });
    expect(screen.getByTestId("diagnostics_overlay")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("diagnostics_overlay")).toBeNull();
  });

  it("shows the checks, a row per track and the latest events of a call", async () => {
    vi.useFakeTimers();
    const scope = new ObservableScope();
    recordCallDiagnostics(scope, {
      participation: {
        state$: constant({ kind: "connected" }),
        localMember$: constant({
          tracks$: constant([
            {
              ...mockMediaTrack({ id: "share", source: "screenShare" }),
              kind: "video",
              diagnostics: async () =>
                Promise.resolve({
                  stats: [
                    {
                      type: "outbound-rtp",
                      kind: "video",
                      frameWidth: 1280,
                      frameHeight: 720,
                      framesPerSecond: 30,
                      encoderImplementation: "libvpx",
                      qualityLimitationReason: "cpu",
                    },
                  ],
                }),
            },
          ]),
        } as never),
        remoteMembers$: new BehaviorSubject([]),
      },
      participant: "@me:example.org:DEV",
      micEnabled$: constant(false),
      cameraEnabled$: constant(false),
      devices: {},
      share: () => ({
        expected: { width: 2560, height: 1440 },
        audioExpected: false,
      }),
    });
    diag("mute", { source: "microphone", enabled: false, reason: "user" });
    diagnosticsOverlay.setValue(true);
    render(<DiagnosticsOverlay />);
    expect(screen.getByText("Waiting for the first reading…")).toBeVisible();

    await act(async () => vi.advanceTimersByTimeAsync(DIAG_STATS_INTERVAL_MS));
    expect(screen.getByTestId("diagnostics_check_mic_audio")).toHaveAttribute(
      "data-status",
      "na",
    );
    const resolution = screen.getByTestId("diagnostics_check_share_resolution");
    expect(resolution).toHaveAttribute("data-status", "fail");
    expect(resolution).toHaveTextContent(
      "Screen share at expected resolution1280x720, expected 2560x1440",
    );
    expect(
      screen.getByTestId("diagnostics_check_no_limitation"),
    ).toHaveTextContent("screen_share: cpu");
    // Our own share's audio has a line of its own; nobody else is sharing,
    // so there is none about what is received
    expect(
      screen.getByTestId("diagnostics_check_share_audio_send"),
    ).toHaveTextContent("My share audio sendingnot sharing audio");
    expect(
      screen.queryByTestId("diagnostics_check_share_audio_recv"),
    ).toBeNull();
    expect(screen.queryByTestId("diagnostics_check_top_layer")).toBeNull();
    const row = screen.getByText(/screen_share$/).closest("tr");
    expect(row).toHaveTextContent("1280x720");
    expect(row).toHaveTextContent("SW");
    expect(
      screen.getByText(/mute source=microphone enabled=false reason=user/),
    ).toBeVisible();
    act(() => scope.end());
  });
});

describe("buildTestPattern", () => {
  it("draws every size in every font, the pixel patterns and the window's size", () => {
    const doc = document.implementation.createHTMLDocument();
    buildTestPattern(doc, {
      ...window,
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 2,
      screen: { width: 1920, height: 1080 },
      addEventListener: vi.fn(),
    } as unknown as Window);
    expect(doc.querySelectorAll("p.line")).toHaveLength(
      TEST_PATTERN_SIZES.length * 4,
    );
    expect(
      [...doc.querySelectorAll("canvas")].map((c) => c.dataset.pattern),
    ).toEqual([
      "vertical-1",
      "horizontal-1",
      "checker-1",
      "vertical-2",
      "checker-2",
      "checker-4",
    ]);
    expect(doc.getElementById("resolution")?.textContent).toBe(
      "window 2560 x 1440 device px  |  scale 2  |  screen 3840 x 2160",
    );
  });
});

describe("snapshotFileName", () => {
  it("keeps to what a file name may safely hold", () => {
    expect(snapshotFileName("@alice:example.org:DEV/../x")).toBe(
      "intercom-snapshot-_alice_example.org_DEV_.._x.png",
    );
    expect(snapshotFileName("")).toBe("intercom-snapshot-unknown.png");
  });
});
