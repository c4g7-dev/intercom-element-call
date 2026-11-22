/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@vector-im/compound-web";
import { BehaviorSubject } from "rxjs";

import { LayoutSwitch } from "./LayoutSwitch";
import { type LayoutMode } from "../state/LayoutSwitchViewModel";

test("offers the three layouts and passes the choice on", async () => {
  const user = userEvent.setup();
  const layout$ = new BehaviorSubject<LayoutMode>("grid");
  const setLayout = vi.fn((value: LayoutMode) => layout$.next(value));
  render(
    <TooltipProvider>
      <LayoutSwitch vm={{ layout$, setLayout }} />
    </TooltipProvider>,
  );

  expect(screen.getAllByRole("radio")).toHaveLength(3);
  expect(screen.getByRole("radio", { name: "Grid" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Equal grid" }));
  expect(setLayout).toHaveBeenCalledWith("equal-grid");
  expect(screen.getByRole("radio", { name: "Equal grid" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Spotlight" }));
  expect(setLayout).toHaveBeenLastCalledWith("spotlight");
});
