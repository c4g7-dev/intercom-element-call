/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AloneBanner } from "./AloneBanner";

describe("AloneBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says the user is alone and counts down to the deadline", () => {
    let now = 10_000;
    render(
      <AloneBanner
        deadline={now + 299_000}
        onStay={vi.fn()}
        onLeave={vi.fn()}
        now={() => now}
      />,
    );
    const banner = screen.getByTestId("alone_banner");
    expect(banner).toHaveTextContent("You're alone in this call");
    expect(banner).toHaveTextContent("disconnecting in 4:59");

    now += 60_000;
    act(() => void vi.advanceTimersByTime(250));
    expect(banner).toHaveTextContent("disconnecting in 3:59");

    now += 235_000;
    act(() => void vi.advanceTimersByTime(250));
    expect(banner).toHaveTextContent("disconnecting in 0:04");
  });

  it("shows a countdown that started over", () => {
    const now = 10_000;
    const { rerender } = render(
      <AloneBanner
        deadline={now + 5_000}
        onStay={vi.fn()}
        onLeave={vi.fn()}
        now={() => now}
      />,
    );
    expect(screen.getByTestId("alone_banner")).toHaveTextContent("0:05");
    rerender(
      <AloneBanner
        deadline={now + 300_000}
        onStay={vi.fn()}
        onLeave={vi.fn()}
        now={() => now}
      />,
    );
    expect(screen.getByTestId("alone_banner")).toHaveTextContent("5:00");
  });

  it("stays and leaves with its buttons", () => {
    const onStay = vi.fn();
    const onLeave = vi.fn();
    render(
      <AloneBanner
        deadline={400_000}
        onStay={onStay}
        onLeave={onLeave}
        now={() => 100_000}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(onStay).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Leave now" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
