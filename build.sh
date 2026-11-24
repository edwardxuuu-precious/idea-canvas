#!/bin/bash
set -euo pipefail

project_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
source_dir="$project_dir/macos"
dist_dir="$project_dir/dist"
bundle="$dist_dir/想法画布.app"
stage_dir="$dist_dir/.build-lock"
candidate="$stage_dir/想法画布.app"
previous="$stage_dir/previous.app"

mkdir -p "$dist_dir"
if ! mkdir "$stage_dir" 2>/dev/null; then
    printf '无法使用构建暂存目录 %s\n' "$stage_dir" >&2
    exit 1
fi

cleanup() {
    if [[ -e "$previous" || -L "$previous" ]] && [[ ! -e "$bundle" && ! -L "$bundle" ]]; then
        mv "$previous" "$bundle" || return 1
    fi
    rm -rf "$stage_dir"
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
# File Provider can attach Finder metadata when the bundle is created in Documents.
if /usr/bin/xattr -p com.apple.FinderInfo "$candidate" >/dev/null 2>&1; then
    /usr/bin/xattr -d com.apple.FinderInfo "$candidate"
fi
/usr/bin/codesign --force --sign - "$candidate"
/usr/bin/codesign --verify --deep --strict "$candidate"

if [[ -e "$bundle" || -L "$bundle" ]]; then
    mv "$bundle" "$previous"
fi
mv "$candidate" "$bundle"
printf '%s\n' "$bundle"
