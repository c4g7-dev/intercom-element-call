/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import {
  chooseSpotlightSpeaker,
  computeLayoutMedia,
  computeSpotlight,
  type LayoutMediaInputs,
} from "./layoutMedia";
import { type LocalUserMediaViewModel } from "./media/LocalUserMediaViewModel";
import { type RemoteUserMediaViewModel } from "./media/RemoteUserMediaViewModel";
import { type RingingMediaViewModel } from "./media/RingingMediaViewModel";
import { type ScreenShareViewModel } from "./media/ScreenShareViewModel";

// The layout functions only look at `type` and `local`, so stubs suffice
const local = { type: "user", local: true } as LocalUserMediaViewModel;
const alice = { type: "user", local: false } as RemoteUserMediaViewModel;
const bob = { type: "user", local: false } as RemoteUserMediaViewModel;
const carol = { type: "user", local: false } as RemoteUserMediaViewModel;
const screenShare = {
  type: "screen share",
  local: false,
} as ScreenShareViewModel;
const ringing = { type: "ringing" } as RingingMediaViewModel;

describe("chooseSpotlightSpeaker", () => {
  const items = (
    ...speaking: boolean[]
  ): {
    media: RemoteUserMediaViewModel | LocalUserMediaViewModel;
    speaking: boolean;
  }[] =>
    [local, alice, bob].map((media, i) => ({
      media,
      speaking: speaking[i] ?? false,
    }));

  it("prefers a remote speaker over the local user", () => {
    expect(chooseSpotlightSpeaker(undefined, items(true, false, true))).toBe(
      bob,
    );
  });

  it("falls back to any remote user, then the local user", () => {
    expect(chooseSpotlightSpeaker(undefined, items())).toBe(alice);
    expect(
      chooseSpotlightSpeaker(undefined, [{ media: local, speaking: false }]),
    ).toBe(local);
    expect(chooseSpotlightSpeaker(undefined, [])).toBeUndefined();
  });

  it("sticks with the previous speaker while they keep speaking", () => {
    expect(chooseSpotlightSpeaker(bob, items(false, true, true))).toBe(bob);
  });

  it("sticks with the previous speaker when nobody is speaking", () => {
    expect(chooseSpotlightSpeaker(bob, items())).toBe(bob);
  });

  it("switches when someone else speaks and the previous speaker is silent", () => {
    expect(chooseSpotlightSpeaker(bob, items(false, true, false))).toBe(alice);
  });

  it("forgets a previous speaker who left, and never sticks to the local user", () => {
    expect(chooseSpotlightSpeaker(carol, items())).toBe(alice);
    expect(chooseSpotlightSpeaker(local, items())).toBe(alice);
  });
});

describe("computeSpotlight", () => {
  it("spotlights ringing media with the local user in the PiP", () => {
    expect(
      computeSpotlight({
        ringing,
        screenShares: [screenShare],
        speaker: alice,
        localPip: local,
      }),
    ).toEqual({ spotlight: [ringing], pip: local });
  });

  it("spotlights screen shares with the speaker in the PiP", () => {
    expect(
      computeSpotlight({
        ringing: null,
        screenShares: [screenShare],
        speaker: alice,
        localPip: local,
      }),
    ).toEqual({ spotlight: [screenShare], pip: alice });
  });

  it("otherwise spotlights the speaker and hides a redundant PiP", () => {
    expect(
      computeSpotlight({
        ringing: null,
        screenShares: [],
        speaker: alice,
        localPip: local,
      }),
    ).toEqual({ spotlight: [alice], pip: local });
    expect(
      computeSpotlight({
        ringing: null,
        screenShares: [],
        speaker: local,
        localPip: local,
      }),
    ).toEqual({ spotlight: [local], pip: undefined });
  });
});

describe("computeLayoutMedia", () => {
  const base: LayoutMediaInputs = {
    windowMode: "normal",
    layoutMode: "grid",
    spotlightExpanded: false,
    oneOnOne: null,
    localVideoEnabled: true,
    spotlight: [alice],
    grid: [local, alice, bob],
    pip: local,
    desktop: false,
  };
  const layout = (
    overrides: Partial<LayoutMediaInputs>,
  ): ReturnType<typeof computeLayoutMedia> =>
    computeLayoutMedia({ ...base, ...overrides });

  it("uses a plain grid unless a screen share needs the spotlight", () => {
    expect(layout({})).toEqual({
      type: "grid",
      edgeToEdge: false,
      spotlight: undefined,
      grid: base.grid,
    });
    expect(layout({ spotlight: [screenShare] })).toMatchObject({
      spotlight: [screenShare],
    });
  });

  it("gives every member and every screen share a tile in the equal grid", () => {
    const equal = {
      type: "equal-grid",
      edgeToEdge: false,
      screenShares: [screenShare],
      grid: base.grid,
    };
    const inputs = {
      layoutMode: "equal-grid" as const,
      spotlight: [screenShare],
      screenShares: [screenShare as never],
    };
    expect(layout(inputs)).toEqual(equal);
    expect(layout({ ...inputs, windowMode: "narrow" })).toEqual(equal);
    // Nothing takes its place: not a call of two, not an expanded spotlight
    expect(
      layout({
        ...inputs,
        spotlightExpanded: true,
        oneOnOne: { local: local as never, remote: alice },
      }),
    ).toEqual(equal);
    expect(layout({ layoutMode: "equal-grid" })).toEqual({
      ...equal,
      screenShares: [],
    });
  });

  it("falls back to what the grid gets where the window is no place for an equal grid", () => {
    expect(
      layout({ layoutMode: "equal-grid", windowMode: "flat" }),
    ).toMatchObject({ type: "spotlight-landscape" });
    expect(
      layout({ layoutMode: "equal-grid", windowMode: "pip" }),
    ).toMatchObject({ type: "pip" });
  });

  it("switches between landscape and expanded spotlight", () => {
    expect(layout({ layoutMode: "spotlight" })).toMatchObject({
      type: "spotlight-landscape",
      edgeToEdge: false,
    });
    expect(
      layout({ layoutMode: "spotlight", spotlightExpanded: true }),
    ).toEqual({
      type: "spotlight-expanded",
      edgeToEdge: false,
      spotlight: [alice],
      pip: local,
    });
  });

  it("puts the remote user in the desktop one-on-one spotlight, or the local user when ringing", () => {
    expect(layout({ oneOnOne: { local, remote: alice } })).toEqual({
      type: "one-on-one-desktop",
      edgeToEdge: false,
      spotlight: alice,
      pip: local,
    });
    expect(layout({ oneOnOne: { local, remote: ringing } })).toMatchObject({
      spotlight: local,
      pip: ringing,
    });
  });

  it("uses a mobile one-on-one layout in narrow and flat windows, hiding the PiP without video", () => {
    const oneOnOne = { local, remote: alice };
    expect(layout({ windowMode: "narrow", oneOnOne })).toEqual({
      type: "one-on-one-mobile",
      edgeToEdge: true,
      spotlight: alice,
      pip: local,
    });
    expect(
      layout({ windowMode: "flat", oneOnOne, localVideoEnabled: false }),
    ).toMatchObject({ type: "one-on-one-mobile", pip: undefined });
  });

  it("uses a portrait spotlight in narrow windows for big calls or screen shares", () => {
    expect(layout({ windowMode: "narrow" }).type).toBe("grid");
    expect(
      layout({ windowMode: "narrow", grid: [local, alice, bob, carol] }).type,
    ).toBe("spotlight-portrait");
    expect(
      layout({ windowMode: "narrow", spotlight: [screenShare] }).type,
    ).toBe("spotlight-portrait");
  });

  it("uses edge-to-edge spotlight layouts in flat windows", () => {
    expect(layout({ windowMode: "flat" })).toMatchObject({
      type: "spotlight-landscape",
      edgeToEdge: true,
    });
    expect(
      layout({ windowMode: "flat", layoutMode: "spotlight" }),
    ).toMatchObject({
      type: "spotlight-expanded",
      edgeToEdge: true,
    });
  });

  it("uses the PiP layout, edge to edge except on desktop", () => {
    expect(layout({ windowMode: "pip" })).toEqual({
      type: "pip",
      edgeToEdge: true,
      spotlight: [alice],
    });
    expect(layout({ windowMode: "pip", desktop: true }).edgeToEdge).toBe(false);
  });
});

describe("computeLayoutMedia with a focused tile", () => {
  const me = { type: "user", local: true, id: "me" } as LocalUserMediaViewModel;
  const ann = {
    type: "user",
    local: false,
    id: "ann",
  } as RemoteUserMediaViewModel;
  const ben = {
    type: "user",
    local: false,
    id: "ben",
  } as RemoteUserMediaViewModel;
  const share = {
    type: "screen share",
    local: false,
    id: "ann",
  } as ScreenShareViewModel;
  const base: LayoutMediaInputs = {
    windowMode: "normal",
    layoutMode: "grid",
    spotlightExpanded: false,
    oneOnOne: null,
    localVideoEnabled: true,
    spotlight: [ann],
    grid: [me, ann, ben],
    pip: me,
    desktop: true,
    screenShares: [],
  };

  it("puts the focused member in the spotlight with everyone in the strip", () => {
    expect(computeLayoutMedia({ ...base, focused: "user:ben" })).toEqual({
      type: "spotlight-landscape",
      edgeToEdge: false,
      spotlight: [ben],
      grid: [me, ann, ben],
    });
  });

  it("takes the place of the equal grid and of a one-on-one layout", () => {
    expect(
      computeLayoutMedia({
        ...base,
        layoutMode: "equal-grid",
        focused: "user:ann",
      }).type,
    ).toBe("spotlight-landscape");
    expect(
      computeLayoutMedia({
        ...base,
        grid: [me, ann],
        oneOnOne: { local: me, remote: ann },
        focused: "user:me",
      }),
    ).toMatchObject({ type: "spotlight-landscape", spotlight: [me] });
  });

  it("tells a member's screen share from the member, and keeps other shares a page away", () => {
    const other = {
      type: "screen share",
      local: false,
      id: "ben",
    } as ScreenShareViewModel;
    const inputs = { ...base, screenShares: [share, other] };
    expect(
      computeLayoutMedia({ ...inputs, focused: "screen share:ben" }),
    ).toMatchObject({ spotlight: [other, share] });
    expect(
      computeLayoutMedia({ ...inputs, focused: "user:ann" }),
    ).toMatchObject({ spotlight: [ann, share, other] });
  });

  it("uses the portrait spotlight in a narrow window and leaves a PiP alone", () => {
    expect(
      computeLayoutMedia({ ...base, windowMode: "narrow", focused: "user:ben" })
        .type,
    ).toBe("spotlight-portrait");
    expect(
      computeLayoutMedia({ ...base, windowMode: "pip", focused: "user:ben" })
        .type,
    ).toBe("pip");
  });

  it("expands the focused media when the spotlight's expand button is on", () => {
    expect(
      computeLayoutMedia({
        ...base,
        spotlightExpanded: true,
        focused: "user:ben",
      }),
    ).toEqual({
      type: "spotlight-expanded",
      edgeToEdge: false,
      spotlight: [ben],
      pip: me,
    });
    // Our own camera is not shown twice
    expect(
      computeLayoutMedia({
        ...base,
        spotlightExpanded: true,
        focused: "user:me",
      }),
    ).toMatchObject({
      type: "spotlight-expanded",
      spotlight: [me],
      pip: undefined,
    });
    // A narrow window has no expand button: the portrait spotlight stays
    expect(
      computeLayoutMedia({
        ...base,
        windowMode: "narrow",
        spotlightExpanded: true,
        focused: "user:ben",
      }).type,
    ).toBe("spotlight-portrait");
  });

  it("falls back to the chosen layout when the focused media is gone", () => {
    expect(computeLayoutMedia({ ...base, focused: "user:gone" }).type).toBe(
      "grid",
    );
    expect(computeLayoutMedia({ ...base, focused: null }).type).toBe("grid");
  });
});
