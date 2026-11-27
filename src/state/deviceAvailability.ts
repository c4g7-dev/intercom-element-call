/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  fromEvent,
  map,
  merge,
  Observable,
  of,
} from "rxjs";

/**
 * How a microphone or a camera stands: on, off (muted), or not there to be
 * turned on at all, for want of a device or of the permission to use one.
 */
export type DeviceAvailability = "on" | "off" | "no-device" | "no-permission";

/** Why a device cannot be turned on. */
export type DeviceUnavailability = "no-device" | "no-permission";

/** What the platform says about the permission; "unknown" where it cannot be asked. */
export type DevicePermission = PermissionState | "unknown";

export type DeviceSource = "microphone" | "camera";

interface DeviceFacts {
  /** How many devices of the kind are listed */
  deviceCount: number;
  permission: DevicePermission;
  /**
   * Whether the last attempt to open the device was refused for want of
   * permission. It counts only against a permission said to be granted: the
   * system refuses then, under the platform. Anywhere else it may be a
   * prompt that was closed, which is no lasting refusal.
   */
  refused: boolean;
  /** Whether the device is on (unmuted) */
  enabled: boolean;
}

/**
 * The one place that says how a device stands. Where the permission cannot be
 * told, a device counts as missing only if none is listed.
 */
export function deviceAvailability({
  deviceCount,
  permission,
  refused,
  enabled,
}: DeviceFacts): DeviceAvailability {
  if (permission === "denied") return "no-permission";
  if (deviceCount === 0) return "no-device";
  if (refused && permission === "granted") return "no-permission";
  return enabled ? "on" : "off";
}

export function unavailability(
  availability: DeviceAvailability,
): DeviceUnavailability | undefined {
  return availability === "no-device" || availability === "no-permission"
    ? availability
    : undefined;
}

/**
 * The permission to use a device, followed as it changes. "unknown" where the
 * platform cannot be asked about it.
 */
export function devicePermission$(
  source: DeviceSource,
  permissions: Pick<Permissions, "query"> | undefined = globalThis.navigator
    ?.permissions,
): Observable<DevicePermission> {
  if (typeof permissions?.query !== "function") return of("unknown");
  return new Observable<DevicePermission>((subscriber) => {
    let status: PermissionStatus | undefined;
    let over = false;
    const tell = (): void => subscriber.next(status?.state ?? "unknown");
    subscriber.next("unknown");
    permissions
      .query({ name: source as PermissionName })
      .then((s) => {
        if (over) return;
        status = s;
        status.addEventListener("change", tell);
        tell();
      })
      // A platform that does not know the name: it cannot be told
      .catch(() => undefined);
    return (): void => {
      over = true;
      status?.removeEventListener("change", tell);
    };
  }).pipe(distinctUntilChanged());
}

const refusals$ = new BehaviorSubject<Record<DeviceSource, boolean>>({
  microphone: false,
  camera: false,
});

/** Records what came of an attempt to open a device: `undefined` for success. */
export function rememberDeviceAttempt(
  source: DeviceSource,
  error: unknown,
): void {
  const refused = isPermissionRefusal(error);
  if (refusals$.value[source] !== refused)
    refusals$.next({ ...refusals$.value, [source]: refused });
}

function isPermissionRefusal(e: unknown): boolean {
  for (let cause: unknown = e, depth = 0; depth < 5; depth++) {
    if (typeof cause !== "object" || cause === null) return false;
    if ("name" in cause && cause.name === "NotAllowedError") return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

/**
 * Whether the last attempt to open a device was refused for want of
 * permission. Forgotten when the user comes back to the window or the devices
 * change: the refusal may be over then, and only another attempt can tell.
 */
export function deviceRefused$(source: DeviceSource): Observable<boolean> {
  return new Observable<boolean>((subscriber) => {
    const forget = (): void => rememberDeviceAttempt(source, undefined);
    const mediaDevices = globalThis.navigator?.mediaDevices;
    const subscription = merge(
      typeof window === "undefined" ? of() : fromEvent(window, "focus"),
      typeof mediaDevices?.addEventListener === "function"
        ? fromEvent(mediaDevices, "devicechange")
        : of(),
    ).subscribe(forget);
    subscription.add(
      refusals$.pipe(map((refusals) => refusals[source])).subscribe(subscriber),
    );
    return subscription;
  }).pipe(distinctUntilChanged());
}

interface DeviceAvailabilityInputs {
  /** The devices of the kind, by ID */
  available$: Observable<Map<string, unknown>>;
  enabled$: Observable<boolean>;
  permission$?: Observable<DevicePermission>;
  refused$?: Observable<boolean>;
}

/** How the microphone or the camera stands, followed as it changes. */
export function deviceAvailability$(
  source: DeviceSource,
  {
    available$,
    enabled$,
    permission$ = devicePermission$(source),
    refused$ = deviceRefused$(source),
  }: DeviceAvailabilityInputs,
): Observable<DeviceAvailability> {
  return combineLatest(
    [available$, permission$, refused$, enabled$],
    (available, permission, refused, enabled) =>
      deviceAvailability({
        deviceCount: available.size,
        permission,
        refused,
        enabled,
      }),
  ).pipe(distinctUntilChanged());
}
