#!/bin/bash
# Fast DOM poller: frozen 1-minute interval and 600-round ceiling.
cd "$(dirname "$0")"
LOG="fast-history.log"
for i in $(seq 1 600); do
  echo "=== fast poll $i $(date +%H:%M:%S) ===" | tee -a "$LOG"
  ego-browser nodejs < ego-fast-probe.mjs > fast-out.txt 2>&1
  rc=$?
  grep -E '^(state=|TRANSITION|RESULT=|GAP_FALSE_POSITIVE)' fast-out.txt | tee -a "$LOG"
  if [ "$rc" -ne 0 ]; then
    echo "EGO_BROWSER_EXIT=$rc WAKE_SUPERVISOR" | tee -a "$LOG"
    break
  fi
  if ! grep -q '^RESULT=' fast-out.txt; then
    echo "PROBE_NO_RESULT_WAKE_SUPERVISOR" | tee -a "$LOG"
    break
  fi
  if grep -qE 'RESULT=(DONE_CANDIDATE|CONVERSATION_UNAVAILABLE_PERSISTENT|START_IDLE_WAKE_SUPERVISOR|UI_SCHEMA_UNKNOWN|DISPATCH_UNCERTAIN_WAKE_SUPERVISOR|DISPATCH_UUID_MISMATCH|DISPATCH_STATE_INVALID|TASKSPACE_RECOVERY_FAILED|STATE_CORRUPT|UUID_MISSING_OR_INVALID)' fast-out.txt; then
    echo "FAST_POLLER_WAKE_SUPERVISOR" | tee -a "$LOG"
    break
  fi
  sleep 60
done
echo "fast-poller exit $(date +%H:%M:%S)" | tee -a "$LOG"
