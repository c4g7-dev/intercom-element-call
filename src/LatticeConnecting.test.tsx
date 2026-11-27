/*
Copyright 2026 The InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { LatticeConnecting } from "./LatticeConnecting";

describe("LatticeConnecting", () => {
  it("draws the tile with a ring of eight dots around one, lit one after the other", () => {
    const { container } = render(<LatticeConnecting size={96} />);
    const mark = screen.getByTestId("lattice-connecting");
    expect(mark).toHaveAttribute("width", "96");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    const circles = [...container.querySelectorAll("circle")];
    expect(circles).toHaveLength(9);
    const delays = circles
      .slice(0, 8)
      .map((c) => parseFloat((c as SVGElement).style.animationDelay));
    expect(delays[0]).toBe(0);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(delays[7]).toBeLessThan(2.4);
  });
});
