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
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
build_no="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")"
minimum_os="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist")"
target="$(uname -m)-apple-macosx$minimum_os"

mkdir -p "$candidate/Contents/MacOS" "$candidate/Contents/Resources"
"$project_dir/tools/bundle.sh" > /dev/null
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
chmod 0644 "$staged_archive"
mv -f -- "$staged_archive" "$archive"

release_tag="v${version}-b${build_no}"
release_dir="$dist_dir/releases/$release_tag"
mkdir -p "$release_dir"
backup_zip="$release_dir/想法画布-macOS-${release_tag}.zip"
backup_html="$release_dir/想法画布-${release_tag}.html"
cp -f -- "$archive" "$backup_zip"
cp -f -- "$candidate/Contents/Resources/Canvas.html" "$backup_html"
chmod 0644 "$backup_zip" "$backup_html"

git_commit="$(git -C "$project_dir" rev-parse HEAD 2>/dev/null || echo 'unknown')"
git_dirty="false"
if [[ -n "$(git -C "$project_dir" status --porcelain 2>/dev/null || true)" ]]; then
    git_dirty="true"
fi
zip_sha="$(/usr/bin/shasum -a 256 "$backup_zip" | awk '{print $1}')"
html_sha="$(/usr/bin/shasum -a 256 "$backup_html" | awk '{print $1}')"

/usr/bin/python3 - "$project_dir" "$release_dir" "$version" "$build_no" "$git_commit" "$git_dirty" "$backup_zip" "$zip_sha" "$backup_html" "$html_sha" <<'PY'
import datetime, json, os, re, sys

(
    project_dir, release_dir, version, build_no, git_commit, git_dirty,
    backup_zip, zip_sha, backup_html, html_sha,
) = sys.argv[1:]

changelog_path = os.path.join(project_dir, "CHANGELOG.md")
notes_path = os.path.join(release_dir, "RELEASE-NOTES.md")
if os.path.isfile(changelog_path):
    text = open(changelog_path, "r", encoding="utf-8").read()
    pattern = re.compile(rf"(^## \[{re.escape(version)}\][^\n]*\n.*?)(?=^## \[|\Z)", re.MULTILINE | re.DOTALL)
    match = pattern.search(text)
    section = match.group(1).strip() if match else text.strip()
else:
    section = f"# v{version} (Build {build_no})\n"
with open(notes_path, "w", encoding="utf-8") as fh:
    fh.write(section + "\n")

manifest = {
    "version": version,
    "build": int(build_no) if build_no.isdigit() else build_no,
    "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "gitCommit": git_commit,
    "gitDirty": git_dirty == "true",
    "artifacts": {
        "macosZip": {
            "file": os.path.basename(backup_zip),
            "bytes": os.path.getsize(backup_zip),
            "sha256": zip_sha,
        },
        "standaloneHtml": {
            "file": os.path.basename(backup_html),
            "bytes": os.path.getsize(backup_html),
            "sha256": html_sha,
        },
    },
}
with open(os.path.join(release_dir, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

printf '%s\n' "$archive"
printf '%s\n' "$release_dir"
