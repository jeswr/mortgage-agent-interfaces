#!/bin/sh
# One-command reproduction: ./run.sh <arm: A|B|C1|C2> <model> <n> [slot]
# Example: ./run.sh C1 claude-sonnet-5-5 5
set -e
cd "$(dirname "$0")"
exec node runner.js "$@"
