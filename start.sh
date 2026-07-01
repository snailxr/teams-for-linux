#!/usr/bin/env bash
# Launch the dev build with X11 ozone so window controls (min/max/close) show on Wayland.
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron ./app --ozone-platform=x11 --trace-warnings "$@"
