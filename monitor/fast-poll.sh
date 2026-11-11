#!/bin/bash
# Fast DOM poller: frozen 1-minute interval and 600-round ceiling.
# Issue #8: benign signals (restart-self-healing class) auto-restart the probe with an audit
# line instead of exiting; only supervisor-decision signals truly exit to wake the supervisor.
cd "$(dirname "$0")"
LOG="fast-history.log"
BENIGN_CAP=20  # consecutive benign restarts before treating it as a real fault
benign_streak=0
for i in $(seq 1 600); do
  echo "=== fast poll $i $(date +%H:%M:%S) ===" | tee -a "$LOG"
  ego-browser nodejs < ego-fast-probe.mjs > fast-out.txt 2>&1
  rc=$?
  grep -E '^(state=|TRANSITION|RESULT=|GAP_FALSE_POSITIVE|PROBE_BOOT)' fast-out.txt | tee -a "$LOG"
  if [ "$rc" -ne 0 ]; then
    echo "EGO_BROWSER_EXIT=$rc WAKE_SUPERVISOR" | tee -a "$LOG"
    break
  fi
  if ! grep -q '^RESULT=' fast-out.txt; then
    echo "PROBE_NO_RESULT_WAKE_SUPERVISOR" | tee -a "$LOG"
    break
  fi
  result=$(grep -oE '^RESULT=[A-Z_]+' fast-out.txt | tail -1 | cut -d= -f2)
  case "$result" in
    START_IDLE_WAKE_SUPERVISOR)
      # Benign: a probe restart re-derives fresh state and heals it; restart instead of waking.
      benign_streak=$((benign_streak + 1))
      if [ "$benign_streak" -gt "$BENIGN_CAP" ]; then
        echo "BENIGN_STREAK_CAP_${BENIGN_CAP}_EXCEEDED WAKE_SUPERVISOR" | tee -a "$LOG"
        break
      fi
      echo "BENIGN_SIGNAL_SELFHEAL=$result streak=$benign_streak/$BENIGN_CAP" | tee -a "$LOG"
      sleep 60
      continue
      ;;
    DONE_CANDIDATE|CONVERSATION_UNAVAILABLE_PERSISTENT|UI_SCHEMA_UNKNOWN|DISPATCH_UNCERTAIN_WAKE_SUPERVISOR|DISPATCH_UUID_MISMATCH|DISPATCH_STATE_INVALID|TASKSPACE_RECOVERY_FAILED|EGO_TASKSPACE_TAKEOVER_REQUIRED|STATE_CORRUPT|UUID_MISSING_OR_INVALID)
      echo "FAST_POLLER_WAKE_SUPERVISOR signal=$result" | tee -a "$LOG"
      break
      ;;
    "")
      echo "PROBE_NO_RESULT_WAKE_SUPERVISOR" | tee -a "$LOG"
      break
      ;;
    GENERATING|IDLE_PREDELIVERY|PROBE_BACKOFF)
      ;;
    *)
      echo "FAST_POLLER_UNHANDLED_SIGNAL_WAKE_SUPERVISOR signal=$result" | tee -a "$LOG"
      break
      ;;
  esac
  benign_streak=0
  sleep 60
done
echo "fast-poller exit $(date +%H:%M:%S)" | tee -a "$LOG"
