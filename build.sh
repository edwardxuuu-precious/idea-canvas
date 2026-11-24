#!/bin/bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
source_dir="$project_dir/macos"
dist_dir="$project_dir/dist"
archive="$dist_dir/想法画布-macOS.zip"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/idea-canvas-build.XXXXXXXX")"
candidate="$stage_dir/想法画布.app"
staged_archive=""

cleanup() {
    if [[ -n "$staged_archive" ]]; then
        rm -f -- "$staged_archive"
    fi
    rm -rf -- "$stage_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

plist="$source_dir/Info.plist"
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
minimum_os="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")"
target="$(uname -m)-apple-macosx$minimum_os"

mkdir -p "$candidate/Contents/MacOS" "$candidate/Contents/Resources"
cp -X "$plist" "$candidate/Contents/Info.plist"
cp -X "$source_dir/CanvasIcon.icns" "$candidate/Contents/Resources/"
cp -X "$project_dir/想法画布.html" "$candidate/Contents/Resources/Canvas.html"

/usr/bin/xcrun --sdk macosx swiftc -O -target "$target" \
    "$source_dir/CanvasApp.swift" "$source_dir/CanvasLoopback.swift" "$source_dir/DiskWorkspace.swift" \
    -o "$candidate/Contents/MacOS/$executable"
/usr/bin/codesign --force --sign - "$candidate"
/usr/bin/codesign --verify --deep --strict "$candidate"

mkdir -p "$dist_dir"
if [[ -d "$archive" ]]; then
    printf '构建产物路径被文件夹占用 %s\n' "$archive" >&2
    exit 1
fi
staged_archive="$(mktemp "$dist_dir/.release.XXXXXXXX")"
/usr/bin/ditto -c -k --keepParent --norsrc --noextattr "$candidate" "$staged_archive"
mv -f -- "$staged_archive" "$archive"
printf '%s\n' "$archive"
