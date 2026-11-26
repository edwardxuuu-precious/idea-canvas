#!/bin/bash
# Assemble 想法画布.html from src/. Edit src/, then run this script.
# --check exits non-zero when 想法画布.html differs from what src/ would produce.
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
src_dir="$project_dir/src"
output="$project_dir/想法画布.html"
include='^<!-- @include ([A-Za-z0-9._/-]+) -->$'

bundle() {
    local line
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ $include ]]; then
            cat "$src_dir/${BASH_REMATCH[1]}"
        else
            printf '%s\n' "$line"
        fi
    done < "$src_dir/index.html"
}

staged="$(mktemp "${TMPDIR:-/tmp}/idea-canvas-bundle.XXXXXXXX")"
trap 'rm -f -- "$staged"' EXIT
bundle > "$staged"

if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s "$staged" "$output"; then
        printf '想法画布.html 与 src/ 不一致。请修改 src/ 后运行 tools/bundle.sh。\n' >&2
        exit 1
    fi
    exit 0
fi

chmod 0644 "$staged"
mv -f -- "$staged" "$output"
trap - EXIT
printf '%s\n' "$output"
