/*
Copyright 2026 InterCom contributors

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useEffect } from "react";
import { E2eeType, type EncryptionSystem } from "@element-hq/matrixrtc-sdk";

import { type HostBridge } from "../HostBridge";
import { type Behavior } from "../state/Behavior";
import { detailedReadings$, diagSample$ } from "./CallDiagnostics";
import {
  createConnReporter,
  mediaServerName,
  summarizeConnection,
} from "./connStats";

type Transport = Parameters<typeof mediaServerName>[0];

/**
 * Tells the host how the connection is, from the readings the diagnostics
 * take anyway: little while it only draws its signal bars, every reading
 * while it shows the details.
 */
export function useHostConnStats(
  hostBridge: Pick<HostBridge, "notifyConnStats">,
  localMember$: Behavior<{ transport$: Behavior<Transport> } | null>,
  encryption: EncryptionSystem,
): void {
  const encrypted = encryption.kind !== E2eeType.NONE;
  useEffect(() => {
    if (hostBridge.notifyConnStats === undefined) return;
    const report = createConnReporter();
    const subscription = diagSample$.subscribe((sample) => {
      if (sample === null) return;
      const stats = report(summarizeConnection(sample), {
        now: sample.t,
        detailed: detailedReadings$.value,
        server: mediaServerName(localMember$.value?.transport$.value),
        encrypted,
      });
      if (stats !== undefined)
        hostBridge.notifyConnStats?.(stats).catch(() => {
          // A host that is not InterCom, or one from before, does not know the message
        });
    });
    return (): void => subscription.unsubscribe();
  }, [hostBridge, localMember$, encrypted]);
}
