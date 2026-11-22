/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { type FC } from "react";

import {
  FOCUS_CLICK_DELAY_MS,
  focusKey,
  TileFocusContext,
  useFocusClick,
} from "./TileFocus";

const Tile: FC<{ id?: string }> = ({ id }) => (
  <div data-testid="tile" {...useFocusClick(id)}>
    <button>menu</button>
  </div>
);

describe("useFocusClick", () => {
  const toggle = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    toggle.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  const renderTile = (id?: string): void => {
    render(
      <TileFocusContext.Provider value={{ toggle }}>
        <Tile id={id} />
      </TileFocusContext.Provider>,
    );
  };

  it("names media by kind and ID", () => {
    expect(focusKey({ type: "screen share", id: "a" })).toBe("screen share:a");
  });

  it("focuses on a single click, once a double click is ruled out", () => {
    renderTile("user:a");
    fireEvent.click(screen.getByTestId("tile"), { detail: 1 });
    expect(toggle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FOCUS_CLICK_DELAY_MS);
    expect(toggle).toHaveBeenCalledExactlyOnceWith("user:a");
  });

  it("leaves a double click to fullscreen", () => {
    renderTile("user:a");
    const tile = screen.getByTestId("tile");
    fireEvent.click(tile, { detail: 1 });
    fireEvent.click(tile, { detail: 2 });
    fireEvent.doubleClick(tile);
    vi.advanceTimersByTime(FOCUS_CLICK_DELAY_MS * 2);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("ignores clicks on a button in the tile", () => {
    renderTile("user:a");
    fireEvent.click(screen.getByRole("button"), { detail: 1 });
    vi.advanceTimersByTime(FOCUS_CLICK_DELAY_MS);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("does nothing for a tile without a key or outside a call view", () => {
    renderTile(undefined);
    fireEvent.click(screen.getByTestId("tile"), { detail: 1 });
    vi.advanceTimersByTime(FOCUS_CLICK_DELAY_MS);
    expect(toggle).not.toHaveBeenCalled();

    render(<Tile id="user:b" />);
    fireEvent.click(screen.getAllByTestId("tile")[1], { detail: 1 });
    vi.advanceTimersByTime(FOCUS_CLICK_DELAY_MS);
    expect(toggle).not.toHaveBeenCalled();
  });
});
