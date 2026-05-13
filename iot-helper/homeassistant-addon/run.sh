#!/usr/bin/env sh
set -eu

CONFIG=/data/options.json
exec node /app/bin/mantis-iot-helper.js --config "$CONFIG"
