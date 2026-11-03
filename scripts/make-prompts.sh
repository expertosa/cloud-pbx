#!/usr/bin/env bash
# Generates the built-in Arabic system prompts as 8 kHz mono WAV.
# These are robotic placeholders made with espeak-ng. For production, replace
# each prompts/<name>.wav with a studio recording (or a TTS voice) of the
# text in prompts/prompts.tsv — same file name, any length.
set -euo pipefail
cd "$(dirname "$0")/../prompts"
while IFS=$'\t' read -r name text; do
  [[ -z "$name" ]] && continue
  espeak-ng -v ar -s 135 -w "/tmp/prompt-$name.wav" "$text"
  sox "/tmp/prompt-$name.wav" -r 8000 -c 1 -b 16 -e signed-integer "$name.wav" norm -3 pad 0.2 0.3
  rm -f "/tmp/prompt-$name.wav"
  echo "prompt: $name.wav ($(soxi -D "$name.wav")s)"
done < prompts.tsv
[[ -f beep.wav ]] || sox -n -r 8000 -c 1 -b 16 beep.wav synth 0.35 sine 1000 vol 0.6
