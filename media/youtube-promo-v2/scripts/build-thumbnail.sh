#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
input_file="${1:-${project_dir}/renders/promo-v2.mp4}"
output_file="${2:-${project_dir}/assets/promo-v2-thumbnail.jpg}"

if [[ ! -f "$input_file" ]]; then
  printf 'input video not found: %s\n' "$input_file" >&2
  exit 1
fi

ffmpeg -hide_banner -loglevel error -y \
  -ss 4.8 \
  -i "$input_file" \
  -frames:v 1 \
  -vf 'scale=1280:720:flags=lanczos' \
  -q:v 2 \
  "$output_file"

printf 'built %s\n' "$output_file"
