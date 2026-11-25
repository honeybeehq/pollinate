#!/bin/sh
set -eu

usage() {
  echo "usage: scripts/release-runtime.sh [--out <dir>] [--publish] [<40-hex sha on main>]" >&2
  echo "  builds pollinate-<sha>.tgz, pollinate-<sha>-standalone.tgz and SHA256SUMS, smoke-tests the standalone asset," >&2
  echo "  and with --publish creates GitHub release runtime-<sha> unless it already exists" >&2
  exit 2
}

say() { echo "release: $*"; }
fail() { echo "release: $*" >&2; exit 1; }

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
scripts_dir="$repo_dir/scripts"
github_repo=${GITHUB_REPOSITORY:-honeybeehq/pollinate}
out=""
publish=0
sha=""

while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || usage; out=$2; shift 2 ;;
    --publish) publish=1; shift ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [ -z "$sha" ] || usage; sha=$1; shift ;;
  esac
done

cd "$repo_dir"
git fetch --quiet origin main
main_tip=$(git rev-parse FETCH_HEAD)
[ -n "$sha" ] || sha=$main_tip

if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  fail "refusing \"$sha\": need a full 40-character lowercase hex commit sha"
fi
git cat-file -e "$sha^{commit}" 2>/dev/null || fail "refusing $sha: no such commit in $github_repo"
git merge-base --is-ancestor "$sha" "$main_tip" || fail "refusing $sha: it is not on main"

tag="runtime-$sha"
short=$(printf '%s' "$sha" | cut -c1-8)
pack_name="pollinate-$sha.tgz"
standalone_name="pollinate-$sha-standalone.tgz"

release_state() {
  gh release view "$tag" --repo "$github_repo" --json isDraft --jq 'if .isDraft then "draft" else "published" end' 2>/dev/null || echo "absent"
}

if [ "$publish" = 1 ]; then
  state=$(release_state)
  case "$state" in
    published) say "$tag already exists; leaving it untouched"; exit 0 ;;
    draft) fail "$tag exists as a draft (an earlier upload failed?); a human must inspect it before it is published or removed" ;;
  esac
fi

[ -n "$out" ] || out="${TMPDIR:-/tmp}/pollinate-runtime-$sha"
mkdir -p "$out"
out=$(cd "$out" && pwd)
for asset in "$pack_name" "$standalone_name" SHA256SUMS; do
  [ ! -e "$out/$asset" ] || fail "$out/$asset already exists; pick an empty --out directory"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/pollinate-release.XXXXXX")
say "building $sha in $work"

src="$work/src"
mkdir -p "$src"
git archive --format=tar "$sha" | tar -xf - -C "$src"
(
  cd "$src"
  pnpm install --frozen-lockfile --reporter=silent
  POLLINATE_BUILD_COMMIT=$sha pnpm build
)
built_commit=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).commit)' "$src/dist/build-info.json")
[ "$built_commit" = "$sha" ] || fail "dist/build-info.json says commit $built_commit, expected $sha"

mkdir -p "$work/pack"
(cd "$src" && pnpm pack --pack-destination "$work/pack" >/dev/null)
set -- "$work"/pack/*.tgz
[ $# -eq 1 ] && [ -f "$1" ] || fail "pnpm pack did not produce exactly one tarball"
packed=$1
tar -tzf "$packed" > "$work/pack.list"
stray=$(grep -v '^package/' "$work/pack.list" || true)
[ -z "$stray" ] || fail "packed tarball has entries outside package/: $stray"
grep -qx 'package/dist/cli.js' "$work/pack.list" || fail "packed tarball has no package/dist/cli.js"
grep -qx 'package/dist/build-info.json' "$work/pack.list" || fail "packed tarball has no package/dist/build-info.json"

standalone_root="$work/standalone"
runtime="$standalone_root/pollinate-$sha"
mkdir -p "$runtime"
tar -xzf "$packed" -C "$runtime" --strip-components 1 --no-same-owner
cp "$src/pnpm-lock.yaml" "$runtime/pnpm-lock.yaml"
(
  cd "$runtime"
  pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=silent
)
rm -f "$runtime/pnpm-lock.yaml"
node "$scripts_dir/check-standalone.mjs" "$runtime"
(cd "$standalone_root" && COPYFILE_DISABLE=1 tar -czf "$work/standalone.tgz" "pollinate-$sha")

cp "$packed" "$out/$pack_name"
cp "$work/standalone.tgz" "$out/$standalone_name"
(cd "$out" && shasum -a 256 "$pack_name" "$standalone_name" > SHA256SUMS && shasum -a 256 -c SHA256SUMS)

node "$scripts_dir/smoke-runtime.mjs" "$out/$standalone_name" "$sha"

say "assets in $out:"
ls -l "$out"

if [ "$publish" = 0 ]; then
  say "not publishing (pass --publish to create $tag)"
  exit 0
fi

state=$(release_state)
case "$state" in
  published) say "$tag appeared while building; leaving it untouched"; exit 0 ;;
  draft) fail "$tag appeared as a draft while building; a human must inspect it" ;;
esac

subject=$(git log -1 --format=%s "$sha")
ci_run_url=${RELEASE_CI_RUN_URL:-}
if [ -z "$ci_run_url" ]; then
  ci_run_url=$(gh run list --repo "$github_repo" --workflow ci.yml --commit "$sha" --event push --status success --limit 1 --json url --jq '.[0].url // ""' 2>/dev/null || true)
fi
if [ -n "${GITHUB_RUN_ID:-}" ]; then
  built_by="Built by .github/workflows/release.yml ([run ${GITHUB_RUN_ID}](${GITHUB_SERVER_URL:-https://github.com}/$github_repo/actions/runs/${GITHUB_RUN_ID}))."
else
  built_by="Built by scripts/release-runtime.sh on $(hostname) (the fallback for .github/workflows/release.yml)."
fi
notes="$work/notes.md"
{
  echo "$subject"
  echo
  echo "Commit: https://github.com/$github_repo/commit/$sha"
  if [ -n "$ci_run_url" ]; then echo "CI run: $ci_run_url"; else echo "CI run: none found for this commit"; fi
  echo
  echo "$built_by"
} > "$notes"

if [ "$sha" = "$main_tip" ]; then latest=--latest; else latest=--latest=false; fi
gh release create "$tag" \
  --repo "$github_repo" \
  --target "$sha" \
  --title "Pollinate runtime $short" \
  --notes-file "$notes" \
  "$latest" \
  "$out/$pack_name" "$out/$standalone_name" "$out/SHA256SUMS"
say "published $(gh release view "$tag" --repo "$github_repo" --json url --jq .url)"
