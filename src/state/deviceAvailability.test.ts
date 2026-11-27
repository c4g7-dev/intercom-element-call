/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { afterEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject } from "rxjs";

import {
  type DeviceAvailability,
  deviceAvailability,
  deviceAvailability$,
  type DevicePermission,
  devicePermission$,
  deviceRefused$,
  rememberDeviceAttempt,
  unavailability,
} from "./deviceAvailability";

describe("deviceAvailability", () => {
  it.each<
    [number, DevicePermission, boolean, boolean, DeviceAvailability, string]
  >([
    [1, "granted", false, true, "on", "a device that is on"],
    [1, "granted", false, false, "off", "a device that is muted"],
    [2, "prompt", false, false, "off", "a device not asked for yet"],
    [1, "unknown", false, true, "on", "a platform that cannot tell"],
    [0, "granted", false, false, "no-device", "an empty list"],
    [0, "prompt", false, false, "no-device", "an empty list before asking"],
    [0, "unknown", false, false, "no-device", "an empty list, untold"],
    [1, "denied", false, false, "no-permission", "a denied permission"],
    [0, "denied", false, false, "no-permission", "denied, and so unlisted"],
    [1, "granted", true, false, "no-permission", "a refusal by the system"],
    [1, "prompt", true, false, "off", "a prompt that was closed"],
    [1, "unknown", true, false, "off", "a refusal that cannot be told apart"],
  ])(
    "%i device(s), permission %s, refused %s, enabled %s is %s: %s",
    (deviceCount, permission, refused, enabled, expected) => {
      expect(
        deviceAvailability({ deviceCount, permission, refused, enabled }),
      ).toBe(expected);
    },
  );

  it("names why a device cannot be turned on", () => {
    expect(unavailability("on")).toBeUndefined();
    expect(unavailability("off")).toBeUndefined();
    expect(unavailability("no-device")).toBe("no-device");
    expect(unavailability("no-permission")).toBe("no-permission");
  });
});

class FakePermissionStatus extends EventTarget {
  public constructor(public state: PermissionState) {
    super();
  }
  public change(state: PermissionState): void {
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}

describe("devicePermission$", () => {
  it("cannot tell where the platform cannot be asked", () => {
    const seen: DevicePermission[] = [];
    devicePermission$("microphone", undefined).subscribe((p) => seen.push(p));
    expect(seen).toEqual(["unknown"]);
  });

  it("follows the permission as it changes, and stops when unsubscribed", async () => {
    const status = new FakePermissionStatus("denied");
    const query = vi.fn().mockResolvedValue(status);
    const seen: DevicePermission[] = [];
    const subscription = devicePermission$("camera", { query }).subscribe((p) =>
      seen.push(p),
    );
    expect(seen).toEqual(["unknown"]);
    await Promise.resolve();
    expect(query).toHaveBeenCalledWith({ name: "camera" });
    status.change("granted");
    expect(seen).toEqual(["unknown", "denied", "granted"]);
    subscription.unsubscribe();
    status.change("denied");
    expect(seen).toHaveLength(3);
  });

  it("cannot tell where the platform does not know the device", async () => {
    const query = vi.fn().mockRejectedValue(new TypeError("no such name"));
    const seen: DevicePermission[] = [];
    devicePermission$("camera", { query }).subscribe((p) => seen.push(p));
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["unknown"]);
  });
});

describe("deviceRefused$", () => {
  afterEach(() => {
    rememberDeviceAttempt("microphone", undefined);
    rememberDeviceAttempt("camera", undefined);
  });

  it("remembers a refusal for want of permission, of that device only", () => {
    const microphone: boolean[] = [];
    const camera: boolean[] = [];
    const subscription = deviceRefused$("microphone").subscribe((r) =>
      microphone.push(r),
    );
    subscription.add(deviceRefused$("camera").subscribe((r) => camera.push(r)));

    // Not a refusal for want of permission
    rememberDeviceAttempt("microphone", new DOMException("", "NotFoundError"));
    // One that the SDK wrapped
    rememberDeviceAttempt(
      "microphone",
      new Error("publish failed", {
        cause: new DOMException("denied", "NotAllowedError"),
      }),
    );
    expect(microphone).toEqual([false, true]);
    // An attempt that went through
    rememberDeviceAttempt("microphone", undefined);
    expect(microphone).toEqual([false, true, false]);
    expect(camera).toEqual([false]);
    subscription.unsubscribe();
  });

  it("forgets the refusal when the user comes back to the window", () => {
    const seen: boolean[] = [];
    const subscription = deviceRefused$("camera").subscribe((r) =>
      seen.push(r),
    );
    rememberDeviceAttempt("camera", new DOMException("", "NotAllowedError"));
    window.dispatchEvent(new Event("focus"));
    expect(seen).toEqual([false, true, false]);
    subscription.unsubscribe();
  });
});

describe("deviceAvailability$", () => {
  it("follows the devices, the permission and the switch", () => {
    const available$ = new BehaviorSubject(new Map<string, unknown>());
    const enabled$ = new BehaviorSubject(false);
    const permission$ = new BehaviorSubject<DevicePermission>("unknown");
    const refused$ = new BehaviorSubject(false);
    const seen: DeviceAvailability[] = [];
    const subscription = deviceAvailability$("microphone", {
      available$,
      enabled$,
      permission$,
      refused$,
    }).subscribe((a) => seen.push(a));

    // Plugged in, turned on, blocked, allowed again, refused by the system
    available$.next(new Map([["mic", {}]]));
    enabled$.next(true);
    permission$.next("denied");
    permission$.next("granted");
    enabled$.next(false);
    refused$.next(true);
    available$.next(new Map());
    expect(seen).toEqual([
      "no-device",
      "off",
      "on",
      "no-permission",
      "on",
      "off",
      "no-permission",
      "no-device",
    ]);
    subscription.unsubscribe();
  });
});
