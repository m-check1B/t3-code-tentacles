#!/usr/bin/env bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
output_dir="${project_dir}/assets/audio"
output_file="${output_dir}/master-mix.wav"

mkdir -p "$output_dir"

ffmpeg -hide_banner -loglevel error -y \
  -i "${project_dir}/assets/voice/01.wav" \
  -i "${project_dir}/assets/voice/02.wav" \
  -i "${project_dir}/assets/voice/03.wav" \
  -i "${project_dir}/assets/voice/04.wav" \
  -i "${project_dir}/assets/voice/05.wav" \
  -i "${project_dir}/assets/sfx/land.wav" \
  -i "${project_dir}/assets/sfx/draw.wav" \
  -i "${project_dir}/assets/sfx/land.wav" \
  -i "${project_dir}/assets/sfx/type.wav" \
  -i "${project_dir}/assets/sfx/tick.wav" \
  -i "${project_dir}/assets/sfx/tick.wav" \
  -i "${project_dir}/assets/sfx/tick.wav" \
  -i "${project_dir}/assets/sfx/stamp.wav" \
  -i "${project_dir}/assets/sfx/land.wav" \
  -i "${project_dir}/assets/sfx/type.wav" \
  -filter_complex '[0:a]aresample=48000,adelay=0:all=1,volume=1[v0];[1:a]aresample=48000,adelay=5952:all=1,volume=1[v1];[2:a]aresample=48000,adelay=16107:all=1,volume=1[v2];[3:a]aresample=48000,adelay=24406:all=1,volume=1[v3];[4:a]aresample=48000,adelay=33665:all=1,volume=1[v4];[5:a]aresample=48000,adelay=80:all=1,volume=0.17[s0];[6:a]aresample=48000,adelay=6550:all=1,volume=0.10[s1];[7:a]aresample=48000,adelay=16180:all=1,volume=0.15[s2];[8:a]aresample=48000,adelay=18650:all=1,volume=0.08[s3];[9:a]aresample=48000,adelay=25000:all=1,volume=0.12[s4];[10:a]aresample=48000,adelay=26550:all=1,volume=0.12[s5];[11:a]aresample=48000,adelay=27500:all=1,volume=0.12[s6];[12:a]aresample=48000,adelay=31650:all=1,volume=0.14[s7];[13:a]aresample=48000,adelay=33780:all=1,volume=0.14[s8];[14:a]aresample=48000,adelay=37000:all=1,volume=0.08[s9];[v0][v1][v2][v3][v4][s0][s1][s2][s3][s4][s5][s6][s7][s8][s9]amix=inputs=15:duration=longest:normalize=0,alimiter=limit=0.89,atrim=0:41.601,pan=stereo|c0=c0|c1=c0[out]' \
  -map '[out]' \
  -ar 48000 \
  -c:a pcm_s16le \
  "$output_file"

printf 'built %s\n' "$output_file"
