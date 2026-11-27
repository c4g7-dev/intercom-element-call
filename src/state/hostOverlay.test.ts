/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import { Subject } from "rxjs";

import {
  createHostOverlay,
  type HostOverlayChannel,
  type OverlayEvent,
  type OverlayPlacement,
  overlayPin,
  parseOverlayEvent,
  parseOverlayPlacement,
} from "./hostOverlay";

const placement: OverlayPlacement = {
  rect: { x: 300, y: 48, width: 700, height: 320 },
  window: { width: 1280, height: 800 },
};

function channel(answer: OverlayPlacement | null = placement): {
  channel: HostOverlayChannel;
  events$: Subject<OverlayEvent>;
  calls: string[];
} {
  const events$ = new Subject<OverlayEvent>();
  const calls: string[] = [];
  return {
    events$,
    calls,
    channel: {
      open: vi.fn(async () => {
        calls.push("open");
        return Promise.resolve(answer ?? undefined);
      }),
      close: vi.fn(async () => {
        calls.push("close");
        return Promise.resolve();
      }),
      events$,
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("the host's overlay", () => {
  it("is asked for when the first dialog opens and given back when the last closes", async () => {
    const host = channel();
    const overlay = createHostOverlay(host.channel, () => 0);
    expect(overlay.state$.value.phase).toBe("closed");
    const first = overlay.acquire();
    expect(overlay.state$.value.phase).toBe("opening");
    await flush();
    expect(overlay.state$.value).toEqual({ phase: "open", placement });
    // A dialog opened from a dialog shares the overlay that is open
    const second = overlay.acquire();
    await flush();
    expect(host.calls).toEqual(["open"]);
    first();
    await flush();
    expect(host.calls).toEqual(["open"]);
    expect(overlay.state$.value.phase).toBe("open");
    second();
    // Letting go twice is letting go once
    second();
    await flush();
    expect(host.calls).toEqual(["open", "close"]);
    // The place is kept until the frame is small again
    expect(overlay.state$.value).toEqual({ phase: "closing", placement });
    overlay.settled();
    expect(overlay.state$.value).toEqual({ phase: "closed" });
  });

  it("forgets the place by itself when the frame never reports back", async () => {
    const host = channel();
    let timer: (() => void) | undefined;
    const overlay = createHostOverlay(host.channel, (fn) => (timer = fn));
    const release = overlay.acquire();
    await flush();
    release();
    await flush();
    expect(overlay.state$.value.phase).toBe("closing");
    timer?.();
    expect(overlay.state$.value.phase).toBe("closed");
  });

  it("gives back what was granted for a dialog that closed in the meantime", async () => {
    const host = channel();
    const overlay = createHostOverlay(host.channel, () => 0);
    const release = overlay.acquire();
    release();
    expect(overlay.state$.value.phase).toBe("closed");
    await flush();
    // Either it was never asked for, or it was closed again: never left open
    expect(host.calls.filter((c) => c === "open").length).toBe(
      host.calls.filter((c) => c === "close").length,
    );
    expect(overlay.state$.value.phase).toBe("closed");
  });

  it("opens again after closing, in order", async () => {
    const host = channel();
    const overlay = createHostOverlay(host.channel, () => 0);
    overlay.acquire()();
    const release = overlay.acquire();
    await flush();
    expect(overlay.state$.value.phase).toBe("open");
    release();
    overlay.acquire();
    await flush();
    expect(host.calls.at(-1)).toBe("open");
    expect(overlay.state$.value.phase).toBe("open");
  });

  it("stays closed where the host has none: standalone, another host, a refusal", async () => {
    const none = createHostOverlay(undefined);
    none.acquire()();
    expect(none.state$.value.phase).toBe("closed");

    const refusing = channel(null);
    const overlay = createHostOverlay(refusing.channel, () => 0);
    const release = overlay.acquire();
    await flush();
    expect(overlay.state$.value).toEqual({ phase: "closed" });
    release();
    await flush();
    expect(refusing.calls).toEqual(["open"]);

    const failing = channel();
    failing.channel.open = vi.fn().mockRejectedValue(new Error("unknown"));
    const failed = createHostOverlay(failing.channel, () => 0);
    failed.acquire();
    await flush();
    expect(failed.state$.value).toEqual({ phase: "closed" });
  });

  it("passes the host's Escape to the dialog that opened last", async () => {
    const host = channel();
    const overlay = createHostOverlay(host.channel, () => 0);
    const outer = vi.fn();
    const inner = vi.fn();
    overlay.acquire(outer);
    const release = overlay.acquire(inner);
    await flush();
    host.events$.next({ op: "dismiss" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    release();
    host.events$.next({ op: "dismiss" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("follows the host's window as it is resized, and a call that left for a window of its own", async () => {
    const host = channel();
    const overlay = createHostOverlay(host.channel, () => 0);
    overlay.acquire();
    await flush();
    const resized: OverlayPlacement = {
      rect: { x: 300, y: 48, width: 500, height: 280 },
      window: { width: 1000, height: 700 },
    };
    host.events$.next({ op: "layout", placement: resized });
    expect(overlay.state$.value).toEqual({ phase: "open", placement: resized });
    host.events$.next({ op: "layout", placement: undefined });
    expect(overlay.state$.value).toEqual({ phase: "closed" });
  });

  it("lets go when it is destroyed with dialogs open", async () => {
    const host = channel();
    const overlay = createHostOverlay(host.channel, () => 0);
    overlay.acquire();
    await flush();
    overlay.destroy();
    await flush();
    expect(host.calls).toEqual(["open", "close"]);
  });
});

describe("where the call view is pinned", () => {
  const open = { phase: "open", placement } as const;

  it("is its old place once the frame has the window's size", () => {
    expect(overlayPin(open, { width: 1280, height: 800 })).toEqual(
      placement.rect,
    );
    // A pixel of rounding is the same size
    expect(overlayPin(open, { width: 1279.5, height: 800.4 })).toEqual(
      placement.rect,
    );
  });

  it("is nowhere while the frame is still, or again, the call's own size", () => {
    expect(overlayPin(open, { width: 700, height: 320 })).toBeUndefined();
    expect(
      overlayPin({ phase: "closing", placement }, { width: 700, height: 320 }),
    ).toBeUndefined();
    // Closing, the frame still large: the call stays put
    expect(
      overlayPin({ phase: "closing", placement }, { width: 1280, height: 800 }),
    ).toEqual(placement.rect);
  });

  it("is nowhere without an overlay or without a place in it", () => {
    expect(
      overlayPin({ phase: "closed" }, { width: 1280, height: 800 }),
    ).toBeUndefined();
    expect(
      overlayPin(
        { phase: "open", placement: { window: placement.window } },
        { width: 1280, height: 800 },
      ),
    ).toBeUndefined();
  });
});

describe("what the host sends", () => {
  it("is a placement only when it is complete", () => {
    expect(
      parseOverlayPlacement({
        supported: true,
        rect: { x: 1, y: 2, width: 3, height: 4 },
        window: { width: 10, height: 20 },
      }),
    ).toEqual({
      rect: { x: 1, y: 2, width: 3, height: 4 },
      window: { width: 10, height: 20 },
    });
    expect(
      parseOverlayPlacement({
        supported: true,
        rect: null,
        window: { width: 10, height: 20 },
      }),
    ).toEqual({ window: { width: 10, height: 20 } });
    for (const bad of [
      null,
      "yes",
      {},
      { supported: false, window: { width: 10, height: 20 } },
      { supported: true },
      { supported: true, window: { width: 0, height: 20 } },
      { supported: true, window: { width: "10", height: 20 } },
    ])
      expect(parseOverlayPlacement(bad)).toBeUndefined();
  });

  it("is an event when it says what happened", () => {
    expect(parseOverlayEvent({ op: "dismiss" })).toEqual({ op: "dismiss" });
    expect(parseOverlayEvent({ op: "layout", supported: false })).toEqual({
      op: "layout",
      placement: undefined,
    });
    expect(parseOverlayEvent({ op: "else" })).toBeUndefined();
    expect(parseOverlayEvent(undefined)).toBeUndefined();
  });
});
