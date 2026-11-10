#!/bin/bash
# Runs the whole test suite when an agent (or a subagent) finishes a turn.
# If tests fail it blocks once and sends the failure back to the agent.
# It only blocks once per turn (stop_hook_active), so a planned red step in
# test-first work does not trap the agent. The agent has to say it is red on purpose.
input=$(cat)
if echo "$input" | grep -q '"stop_hook_active": *true'; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR" || exit 0
out=$(npm test --silent 2>&1)
if [ $? -ne 0 ]; then
  echo "Tests are failing. If this is the planned red step of test-first, say so. Otherwise fix the code, not the tests." >&2
  echo "$out" | tail -40 >&2
  exit 2
fi
exit 0
