#!/bin/bash
# Managed job must deliver process exit to the supervising Agent.
cd "$(dirname "$0")" || exit 2
node supervision-watchdog.mjs
