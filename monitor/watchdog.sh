#!/bin/bash
# One 15-minute watchdog window; waiting remains before evaluation (frozen).
cd "$(dirname "$0")"
sleep 900
echo "=== watchdog fires $(date +%H:%M:%S) ===" | tee -a watchdog-history.log
if [ ! -f a-fast-state.json ]; then
  echo "STATE_MISSING_WAKE_SUPERVISOR" | tee -a watchdog-history.log
  exit 0
fi
python -I - <<'PY'
import json, math, sys, time

SCHEMA = "ego-fast-state/v3"
REQUIRED = {
    "schema", "ts", "spaceId", "pageLabel", "generationKey", "pageCount", "generating",
    "everGenerating", "len", "bodyChanged", "lastProgressAt", "startIdle",
    "doneCandidate", "gapRejected", "probeFailed", "backoffUntil",
    "unavailableStrikes", "unavailablePersistent", "uiSchema", "composerCount", "composerEmpty",
    "lastMessageRole", "lastMessageKey", "lastMessageTextLength",
    "stopLabelCount", "buttonLabels", "activityMarkers", "busyCount",
    "dispatchId", "dispatchStatus", "toolState", "finalVerification",
    "recoveryFailed", "errorName", "errorCode"
}
BOOLS = {"generating", "everGenerating", "bodyChanged", "startIdle", "doneCandidate", "probeFailed", "unavailablePersistent", "recoveryFailed"}
NUMBERS = {"ts", "pageCount", "len", "gapRejected", "unavailableStrikes", "composerCount", "lastMessageTextLength", "stopLabelCount", "busyCount"}
try:
    with open("a-fast-state.json", encoding="utf-8") as handle:
        state = json.load(handle)
    if not isinstance(state, dict) or state.get("schema") != SCHEMA or not REQUIRED.issubset(state) or not set(state).issubset(REQUIRED):
        raise ValueError("schema-or-required-field")
    for key in BOOLS:
        if not isinstance(state.get(key), bool):
            raise ValueError("boolean:" + key)
    for key in NUMBERS:
        value = state.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("number:" + key)
    for key in ("buttonLabels", "activityMarkers"):
        if not isinstance(state.get(key), list):
            raise ValueError("array:" + key)
    for key in ("uiSchema", "dispatchStatus", "toolState", "finalVerification"):
        if not isinstance(state.get(key), str):
            raise ValueError("string:" + key)
    for key in ("pageLabel", "generationKey", "lastMessageRole", "lastMessageKey", "dispatchId", "errorName", "errorCode"):
        if state.get(key) is not None and not isinstance(state.get(key), str):
            raise ValueError("nullable-string:" + key)
    if state.get("spaceId") is not None and (isinstance(state.get("spaceId"), bool) or not isinstance(state.get("spaceId"), (str, int, float))):
        raise ValueError("spaceId")
    if state.get("composerEmpty") is not None and not isinstance(state.get("composerEmpty"), bool):
        raise ValueError("composerEmpty")
    last_progress = state.get("lastProgressAt")
    if last_progress is not None and (isinstance(last_progress, bool) or not isinstance(last_progress, (int, float)) or not math.isfinite(last_progress) or last_progress < 0):
        raise ValueError("lastProgressAt")
    deadline = state.get("backoffUntil")
    if deadline is not None and (isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline) or deadline < 0):
        raise ValueError("backoffUntil")
    age = (time.time() * 1000 - state.get("ts", 0)) / 1000
    print("state age=%.0fs generating=%s everGenerating=%s done=%s startIdle=%s dispatch=%s tool=%s" % (
        age, state.get("generating", False), state.get("everGenerating", False),
        state.get("doneCandidate", False), state.get("startIdle", False),
        state.get("dispatchStatus", "UNTRACKED"), state.get("toolState", "UNOBSERVED")))
    if age > 420 or state.get("startIdle") or state.get("recoveryFailed") or state.get("uiSchema") == "UNKNOWN" or state.get("dispatchStatus") == "UNCERTAIN" or state.get("errorCode") == "STATE_CORRUPT":
        sys.exit(3)
    if state.get("doneCandidate"):
        sys.exit(5)
    sys.exit(0)
except Exception as error:
    print("STATE_CORRUPT " + type(error).__name__)
    sys.exit(4)
PY
rc=$?
case "$rc" in
  0) echo "WATCHDOG_15MIN_NO_REPLY_WAKE_SUPERVISOR" | tee -a watchdog-history.log ;;
  3) echo "WATCHDOG_STATE_OR_RECOVERY_FAILURE_WAKE_SUPERVISOR" | tee -a watchdog-history.log ;;
  4) echo "STATE_CORRUPT_WAKE_SUPERVISOR" | tee -a watchdog-history.log ;;
  5) echo "REPLY_ARRIVED_BUT_UNHANDLED_15MIN_WAKE_SUPERVISOR" | tee -a watchdog-history.log ;;
  *) echo "WATCHDOG_UNEXPECTED_EXIT_$rc WAKE_SUPERVISOR" | tee -a watchdog-history.log ;;
esac
exit 0
