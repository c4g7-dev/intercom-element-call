/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { type ReactNode, useEffect, useRef, useState } from "react";

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
import {
  rosterCueDecision,
  type RosterCue,
  type RosterCueHistory,
} from "../state/callEventSounds";

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
  // InterCom: the host may have sound files of the user's to play instead of
  // the built-in ones, and may play the user's own join and leave itself
  const [sounds, setSounds] = useState(callEventAudioSounds);
  const hostPlaysOwnCues = useRef(false);
  const mutedRef = useLatest(muted === true);
  useEffect(() => {
    let over = false;
    void hostBridge
      .requestSounds()
      .then((host) => {
        if (over || !host) return;
        hostPlaysOwnCues.current = host.hostPlaysOwnCues;
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

  useEffect(() => {
    // Who came and who went: one sound of a kind at a time, none while the
    // list fills up after the user's own join where the host plays that
    const joinedAt = Date.now();
    let history: RosterCueHistory = {};
    const rosterCue = (cue: RosterCue): void => {
      const decision = rosterCueDecision(cue, history, {
        now: Date.now(),
        joinedAt,
        hostPlaysOwnCues: hostPlaysOwnCues.current,
        silenced: mutedRef.current,
      });
      history = decision.history;
      if (decision.play) void audioEngineRef.current?.playSound(cue);
    };
    const joinSub = vm.joinSoundEffect$.subscribe(() => rosterCue("join"));
    const leftSub = vm.leaveSoundEffect$.subscribe(() => rosterCue("left"));
    const handRaisedSub = vm.newHandRaised$.subscribe(
      () => void audioEngineRef.current?.playSound("raiseHand"),
    );
    const screenshareSub = vm.newScreenShare$.subscribe(
      () => void audioEngineRef.current?.playSound("screenshareStarted"),
    );

    return (): void => {
      joinSub.unsubscribe();
      leftSub.unsubscribe();
      handRaisedSub.unsubscribe();
      screenshareSub.unsubscribe();
    };
  }, [audioEngineRef, mutedRef, vm]);

  return <></>;
}
