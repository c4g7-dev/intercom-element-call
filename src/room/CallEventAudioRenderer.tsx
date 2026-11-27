/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ReactNode, useEffect, useRef, useState } from "react";
import { combineLatest } from "rxjs";

import { type CallViewModel } from "../state/CallViewModel/CallViewModel";
// InterCom: its own two chimes for joining and leaving, made by
// scripts/intercom-sounds.py (ogg only: the app is Chromium)
import joinCallSoundOgg from "../sound/intercom_join.ogg?url&no-inline";
import leftCallSoundOgg from "../sound/intercom_leave.ogg?url&no-inline";
import handSoundOgg from "../sound/raise_hand.ogg?url&no-inline";
import handSoundMp3 from "../sound/raise_hand.mp3?url&no-inline";
import screenShareStartedOgg from "../sound/screen_share_started.ogg?url&no-inline";
import screenShareStartedMp3 from "../sound/screen_share_started.mp3?url&no-inline";
import declineMp3 from "../sound/call_declined.mp3?url&no-inline";
import declineOgg from "../sound/call_declined.ogg?url&no-inline";
import timeoutMp3 from "../sound/call_timeout.mp3?url&no-inline";
import timeoutOgg from "../sound/call_timeout.ogg?url&no-inline";
import { useAudioContext } from "../useAudioContext";
import { prefetchSounds } from "../soundUtils";
import { useLatest } from "../useLatest";
import { useHostBridge } from "../HostBridge";
import { hostSounds, RosterCueGate } from "../state/callEventSounds";
import { MAX_PARTICIPANT_COUNT_FOR_SOUND } from "../state/CallViewModel/CallViewModel";

export const callEventAudioSounds = prefetchSounds({
  join: {
    ogg: joinCallSoundOgg,
  },
  left: {
    ogg: leftCallSoundOgg,
  },
  raiseHand: {
    mp3: handSoundMp3,
    ogg: handSoundOgg,
  },
  screenshareStarted: {
    mp3: screenShareStartedMp3,
    ogg: screenShareStartedOgg,
  },
  decline: {
    mp3: declineMp3,
    ogg: declineOgg,
  },
  timeout: {
    mp3: timeoutMp3,
    ogg: timeoutOgg,
  },
});

export type CallEventSounds = keyof Awaited<typeof callEventAudioSounds>;

export function CallEventAudioRenderer({
  vm,
  muted,
}: {
  vm: CallViewModel;
  muted?: boolean;
}): ReactNode {
  const hostBridge = useHostBridge();
  const hostBridgeRef = useLatest(hostBridge);
  // InterCom: the host may have sound files of the user's to play instead of
  // the built-in ones, and may play the user's own join and leave itself
  const [sounds, setSounds] = useState(callEventAudioSounds);
  // Whose the user's own join and leave sounds are: undefined until the host
  // answered, or it is known that there is none to answer
  const [hostPlaysOwnCues, setHostPlaysOwnCues] = useState<boolean>();
  const mutedRef = useLatest(muted === true);
  useEffect(() => {
    let over = false;
    void hostSounds(hostBridge)
      .then((host) => {
        if (over) return;
        setHostPlaysOwnCues(host?.hostPlaysOwnCues === true);
        if (!host) return;
        if (Object.keys(host.sounds).length > 0) {
          setSounds(
            callEventAudioSounds.then((builtIn) => ({
              ...builtIn,
              ...host.sounds,
            })),
          );
        }
      })
      .catch(() => undefined);
    return (): void => {
      over = true;
    };
  }, [hostBridge]);

  const audioEngineCtx = useAudioContext({
    sounds,
    latencyHint: "interactive",
    muted,
  });
  const audioEngineRef = useLatest(audioEngineCtx);

  // Who came and who went, see RosterCueGate: the others only, each change
  // once it has stood for a moment, and nothing from when the user leaves
  const gate = useRef<RosterCueGate | null>(null);
  const pollGate = useRef<() => void>(() => {});
  useEffect(() => {
    const rosterGate = new RosterCueGate({
      now: Date.now,
      maxCount: MAX_PARTICIPANT_COUNT_FOR_SOUND,
    });
    gate.current = rosterGate;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const cue of rosterGate.poll({ silenced: mutedRef.current })) {
        void audioEngineRef.current?.playSound(cue);
        // The host plays the user's own leave: it is told of this one, so
        // that the two do not follow each other when the call ends
        if (cue === "left")
          hostBridgeRef.current.notifyLeaveSoundPlayed().catch(() => undefined);
      }
      const due = rosterGate.nextDueAt();
      if (due !== undefined)
        timer = setTimeout(poll, Math.max(0, due - Date.now()));
    };
    pollGate.current = poll;
    const rosterSub = combineLatest([
      vm.soundRoster$,
      vm.reconnecting$,
    ]).subscribe(([roster, reconnecting]) => {
      rosterGate.update(roster, reconnecting);
      poll();
    });
    // The user leaves, or the call ends: whatever falls apart after this is
    // not somebody leaving. The one sound of it is the user's own leave
    const leaveSub = vm.leave$.subscribe(() => rosterGate.close());
    return (): void => {
      rosterGate.close();
      if (timer !== undefined) clearTimeout(timer);
      rosterSub.unsubscribe();
      leaveSub.unsubscribe();
      gate.current = null;
    };
  }, [audioEngineRef, hostBridgeRef, mutedRef, vm]);

  useEffect(() => {
    if (hostPlaysOwnCues === undefined) return;
    gate.current?.hostAnswered(hostPlaysOwnCues);
    pollGate.current();
  }, [hostPlaysOwnCues, vm]);

  useEffect(() => {
    const handRaisedSub = vm.newHandRaised$.subscribe(
      () => void audioEngineRef.current?.playSound("raiseHand"),
    );
    const screenshareSub = vm.newScreenShare$.subscribe(
      () => void audioEngineRef.current?.playSound("screenshareStarted"),
    );

    return (): void => {
      handRaisedSub.unsubscribe();
      screenshareSub.unsubscribe();
    };
  }, [audioEngineRef, vm]);

  return <></>;
}
