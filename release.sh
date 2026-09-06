#!/bin/bash
# =============================================================================
# Release Script -- Bump, tag, publish to npm + MCP registry.
#
# Single-machine flow: lint + typecheck + tests, bump package.json +
# server.json in lockstep, commit + tag + push, publish to npm via
# ~/.npmrc, publish server.json to the MCP registry via mcp-publisher.
# No GitHub release creation, no per-platform build orchestration, no
# SEA binaries. Install story is `npm install -g @yawlabs/mcp` (or
# `npx -y @yawlabs/mcp`) -- see docs/v0.70.3-binary-track-decision.md
# for the rationale on dropping the SEA binary track.
# =============================================================================
# Replaces the earlier .github/workflows/release.yml-driven flow + the
# per-platform SEA build orchestration that briefly lived in
# scripts/build-platforms-all.sh (removed in v0.70.3). The script is
# the single source of truth: it runs the pre-flight gates (lint,
# typecheck, tests, build), bumps package.json + server.json in
# lockstep, commits and tags, publishes to npm via the ~/.npmrc
# automation token, publishes server.json to the MCP registry via
# mcp-publisher, and exits.
#
# Usage:
#   ./release.sh <version>           -- full release (the only mode)
#   ./release.sh -y <version>        -- skip the y/N confirm prompt
#
# Environment:
#   SKIP_CONFIRM=1                   skip the y/N confirm prompt
#   NO_COLOR=1                       disable ANSI colors
#   SKIP_LINT=1                      DISABLES THE LINT GATE. win32-arm64
#                                    escape hatch only -- biome segfaults
#                                    there on every input, so the tolerance
#                                    paths in run_npm_check can never engage.
#                                    Typecheck + tests still gate the release;
#                                    formatting goes unverified on that host.
#   GITHUB_TOKEN=<pat>               GitHub token for the step-5 MCP-registry
#                                    login (needs publish rights on
#                                    io.github.YawLabs/*). Only read when the
#                                    persisted registry JWT is missing/expired.
#   MCP_REGISTRY_TOKEN=<pat>         second-choice spelling of the same token;
#                                    read only when GITHUB_TOKEN is unset. If
#                                    neither is set, `gh auth token` is tried.
#
# Required tools on PATH: node, npm, git, curl, tar, sha256sum (or shasum).
# The first run also needs `mcp-publisher` (downloaded to a temp dir on
# demand, sha256-verified against the registry's per-release
# `registry_<ver>_checksums.txt`) and a one-time `mcp-publisher login
# github` (interactive device flow) which persists a JWT at
# ~/.config/mcp-publisher/token.json for subsequent runs.
#
# If interrupted, re-run with the same version -- each step is idempotent.
#
# Branch protection: the script's `git push origin main --follow-tags`
# (step 3) bypasses the YawLabs/mcp "Protect default branch" ruleset
# (PR review, signed commits, status check "check") and the "Protect
# release tags" ruleset (block ref creation) under the ruleset's
# OrganizationAdmin bypass policy -- the SSH key registered to a YawLabs
# org admin (the `gh_woods` key on this workstation) is a configured
# bypass actor. If a different operator runs the script, the push will
# fail with rule-violation output and the operator must open a PR
# instead. Verified: rulesets #14941666 (default branch) and #14943288
# (refs/tags/v*), bypass_actors: [{actor_type: OrganizationAdmin,
# bypass_mode: always}].
# =============================================================================

# -E (errtrace) so the ERR trap below is inherited by functions and command
# substitutions -- without it a failure inside run_npm_check() or a $(...)
# never records its line number.
set -Eeuo pipefail
# Single EXIT trap: if we're exiting because of an error, print the failure
# banner; either way, clean up the mcp-publisher temp dir. (Two `trap` calls
# would override each other; bash only runs the most recent one.)
#
# FAIL_LINE is captured by a separate ERR trap rather than read from $LINENO
# inside cleanup(): $LINENO expands to the line where it is EVALUATED, so the
# banner used to report its own line ("line 60") for every failure in the
# script, which is worse than useless when a 500-line release dies mid-run.
# `fail()` sets it explicitly because an outright `exit 1` does not fire ERR.
WORKDIR=""
FAIL_LINE=""
trap 'FAIL_LINE=$LINENO' ERR
cleanup() {
  rc=$?
  if [ $rc -ne 0 ]; then
    echo -e "\n  ✗ Release failed at line ${FAIL_LINE:-unknown} (exit code $rc)\n" >&2
  fi
  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
if [ "${NO_COLOR:-0}" = "1" ] || [ ! -t 1 ]; then
  # CYAN belongs in this list: step() and every banner below use it, so
  # omitting it emitted raw ANSI into pipes and CI logs even under NO_COLOR=1.
  RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
# BASH_LINENO[0] is the line of the CALL to fail() -- an explicit `exit 1`
# never fires the ERR trap, so record the caller's line here instead.
fail() { FAIL_LINE="${BASH_LINENO[0]}"; echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# MCP publisher version -- pinned like any other tool we shell out to. The
# sha256 is fetched at release time from the registry's per-release
# `registry_<ver>_checksums.txt` (NOT a hard-coded constant), so the script
# works for any host platform and any future version bump (just update
# MCP_PUBLISHER_VERSION; the checksums file is the source of truth for both
# tarball selection and verification).
#
# `login github-oidc` is GitHub-Actions-only (requires `id-token: write`), so
# the script's workstation path uses the regular `login github` OAuth device
# flow. One-time interactive setup: `mcp-publisher login github` -- the JWT
# persists at ~/.config/mcp-publisher/token.json for every subsequent run.
MCP_PUBLISHER_VERSION="v1.7.9"

# MINGW64 on Windows ARM64 intermittently segfaults in npm's exit cleanup AFTER
# a tool has finished and printed its report. The tool's OUTPUT is authoritative:
# a 139/134 from `npm run` is tolerated only if the tool's own success marker is
# in the captured output (or a direct re-run bypasses the wrapper). Other
# platforms treat any non-zero as a hard failure.
IS_MINGW_ARM64=false
case "$(uname -s 2>/dev/null)" in
  MINGW*ARM64* | MSYS*ARM64* | CYGWIN*ARM64*) IS_MINGW_ARM64=true ;;
esac

# Run an npm-run-script tool that may segfault on this box. $1 label, $2 script,
# $3 ERE for real failures, $4 (opt) ERE proving the tool ran, $5 (opt) direct
# verify command (no npm-run wrapper) for tools that print no completion marker.
run_npm_check() {
  local label="$1" script="$2" fail_re="$3" done_re="${4:-}" verify_cmd="${5:-}" out rc=0
  # SKIP_LINT=1 escape hatch, matching every sibling @yawlabs release.sh. The
  # win32-arm64 biome binary segfaults (139) on THIS repo for every input --
  # `npm run lint`, `npx biome check src/`, a single file, and the direct
  # node_modules binary all die with zero output, so neither the done_re nor the
  # verify_cmd tolerance path below can ever engage. Types and tests still gate
  # the release; formatting goes unverified on this host.
  if [ "${SKIP_LINT:-}" = "1" ] && [[ "$script" == lint* ]]; then
    warn "SKIP_LINT=1 -- skipping '$label' (biome segfaults on win32-arm64)"
    return 0
  fi
  # `|| rc=$?` is load-bearing: under `set -e` a bare `out=$(npm run ...)` whose
  # command substitution exits non-zero aborts the function THERE, before the
  # analysis below runs.
  out=$(npm run "$script" 2>&1) || rc=$?
  printf '%s\n' "$out"
  if echo "$out" | grep -qE "$fail_re"; then
    fail "$label failed"
  fi
  [ "$rc" -eq 0 ] && return 0
  if [ "$IS_MINGW_ARM64" = true ] && { [ "$rc" -eq 139 ] || [ "$rc" -eq 134 ]; }; then
    if [ -n "$done_re" ] && echo "$out" | grep -qE "$done_re"; then
      warn "$label: npm exited $rc (ARM64 npm-run cleanup segfault) but the tool completed with no findings -- tolerating"
      return 0
    fi
    if [ -n "$verify_cmd" ] && $verify_cmd >/dev/null 2>&1; then
      warn "$label: npm exited $rc (ARM64 npm-run cleanup segfault); a direct re-run is clean -- tolerating"
      return 0
    fi
  fi
  # Refine the message when the failure is a toolchain that cannot resolve its
  # own executable: an empty node_modules (npm's cmd.exe wrapper prints
  # "'biome' is not recognized..."), or a missing OPTIONAL platform package
  # that leaves node_modules/.bin/<tool> in place while the binary it execs is
  # absent (@biomejs/cli-win32-arm64 backs lint, @rollup/rollup-win32-arm64-msvc
  # backs test). No fail_re or done_re matches those shapes, so they surfaced
  # as a bare "Lint failed (exit 1)" -- which is what sent the v0.80.0 release
  # down the segfault rabbit hole. Placed AFTER the ARM64 tolerance block so it
  # can only make an already-failing run legible, never turn a tolerated
  # segfault into a hard failure. The quote in "module '?@" is optional because
  # rollup prints its own unquoted variant; the colon in ": command not found"
  # is load-bearing against captured test output, same trap the test fail_re
  # comment documents. The step-2 build gate is a separate code path and is
  # NOT covered here.
  if echo "$out" | grep -qE "Cannot find module '?@|is not recognized as an internal|: command not found|installed .* for another platform"; then
    fail "$label failed (exit $rc) -- the toolchain could not resolve its own executable (see the error above). node_modules is missing or only partially installed. Run \`npm ci\`, then re-run ./release.sh ${VERSION}."
  fi
  fail "$label failed (exit $rc)"
}

# Arg parsing -- manual loop. Flags: -y/--yes. Version is positional and
# required. (The --build-only + --upload-asset subcommands were removed in
# v0.70.3 when the SEA binary track was dropped -- npm install is the install
# story now; see docs/v0.70.3-binary-track-decision.md.)
# Env may pre-set SKIP_CONFIRM=1 to skip the y/N prompt (e.g. CI, scripted
# release). Default off. The -y/--yes arg below overrides the env to true.
# Normalized here because the gate below compares against the literal
# "true" -- without this, the documented SKIP_CONFIRM=1 spelling still
# prompted (commit 3cbe778 changed only the default line, not the gate).
case "${SKIP_CONFIRM:-}" in
  1|true|yes|TRUE|YES) SKIP_CONFIRM=true ;;
  *) SKIP_CONFIRM=false ;;
esac
REMAINING=()
i=0
while [ $i -lt $# ]; do
  arg="${@:$((i+1)):1}"
  case "$arg" in
    -y|--yes) SKIP_CONFIRM=true ;;
    --*) fail "Unrecognized flag: '$arg' (--build-only and --upload-asset were removed in v0.70.3; npm install is the install story now)" ;;
    *) REMAINING+=("$arg") ;;
  esac
  i=$((i+1))
done

VERSION=""
if [ "${#REMAINING[@]}" -gt 0 ]; then
  for arg in "${REMAINING[@]}"; do
    case "$arg" in
      [0-9]*.[0-9]*.[0-9]*)
        [ -n "$VERSION" ] && fail "Multiple versions passed: '$VERSION' and '$arg'"
        VERSION="$arg"
        ;;
      *) fail "Unrecognized argument: '$arg' (expected version X.Y.Z)" ;;
    esac
  done
fi

[ -n "$VERSION" ] || fail "Usage: ./release.sh [-y] <version>"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm  >/dev/null || fail "npm not installed"
command -v git  >/dev/null || fail "git not installed"
# Step-5 tools (MCP registry publish), preflighted HERE: their first use is
# AFTER the tag push and the irreversible npm publish, so discovering one
# missing there strands the release at the registry step. sha256 accepts
# either binary -- macOS ships shasum, not sha256sum.
command -v curl >/dev/null || fail "curl not installed (needed for step 5, the MCP registry publish)"
command -v tar  >/dev/null || fail "tar not installed (needed for step 5, the MCP registry publish)"
{ command -v sha256sum >/dev/null || command -v shasum >/dev/null; } \
  || fail "sha256sum/shasum not installed (needed for step 5, the MCP registry publish)"

# --- Guard: the repo-local toolchain must actually be installed. The
# `command -v` checks above cover the PATH tools; these four live in
# node_modules/.bin and are exactly what package.json's scripts exec:
#   biome  -> "lint"      (step 1)   vitest -> "test"  (step 1)
#   tsc    -> "typecheck" (step 1)   tsup   -> "build" (step 2, and again via
#                                              prepublishOnly inside step 4)
# A present-but-EMPTY node_modules (npm ci never ran, or was interrupted)
# passes every other pre-flight check, survives the confirm prompt, and then
# dies in step 1 with npm's opaque "'biome' is not recognized as an internal
# or external command" plus a bare "Lint failed (exit 1)" -- after a git fetch
# and two npm view round-trips have already been paid for. Observed on the
# v0.80.0 release. These are O(1) stat calls, so they run ahead of all of it.
#
# The EXTENSIONLESS shim is the portable thing to test: npm's cmd-shim writes
# <bin>, <bin>.cmd and <bin>.ps1 as a set on Windows but only <bin> on POSIX,
# so testing <bin>.cmd would make this a silent no-op on the linux/darwin
# hosts step 5 supports. -e rather than -x: the question is "did the install
# happen", not "are the exec bits right" -- exec-bit reporting through MSYS on
# a Windows filesystem is not something to gate a release on.
MISSING_BINS=""
for REQUIRED_BIN in biome tsc vitest tsup; do
  # SKIP_LINT=1 takes biome out of the run entirely (see run_npm_check), so
  # do not block a release on a tool this run will never invoke.
  if [ "$REQUIRED_BIN" = "biome" ] && [ "${SKIP_LINT:-}" = "1" ]; then
    continue
  fi
  [ -e "node_modules/.bin/${REQUIRED_BIN}" ] || MISSING_BINS="${MISSING_BINS} ${REQUIRED_BIN}"
done
if [ -n "$MISSING_BINS" ]; then
  INSTALL_CMD="npm install"
  if [ -f package-lock.json ]; then INSTALL_CMD="npm ci"; fi
  fail "Dependencies are not installed -- missing node_modules/.bin/{${MISSING_BINS# }}. Step 1 would die with an opaque 'not recognized as an internal or external command'. Run \`${INSTALL_CMD}\`, then re-run ./release.sh ${VERSION}."
fi

# Re-read state from disk at every step boundary (per project rule: release
# scripts must not cache at script-start). Functions call these helpers to
# always reflect the current on-disk state.
current_pkg_version() { node -p "require('./package.json').version"; }
current_server_version() { node -p "require('./server.json').version"; }
# The registry-side identity pair: package.json's `mcpName` is what the MCP
# registry reads out of the published npm tarball to prove the publisher owns
# the server name in server.json. Drift between them is only discovered in
# step 5 -- after the irreversible npm publish.
current_pkg_mcp_name() { node -p "require('./package.json').mcpName || ''"; }
current_server_name() { node -p "require('./server.json').name || ''"; }
current_head_sha() { git rev-parse HEAD; }
current_branch() { git rev-parse --abbrev-ref HEAD; }

# Rewrite server.json's version + packages[0].version to $1. Used by both the
# fresh-bump path and the resume self-heal, so the two can never drift.
# mcp-publisher's `publish` validates that server.json's version matches what
# npm reports for the referenced package -- the registry 400s on drift.
write_server_version() {
  node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('server.json','utf-8')); j.version=process.argv[1]; if(j.packages&&j.packages[0]) j.packages[0].version=process.argv[1]; fs.writeFileSync('server.json', JSON.stringify(j, null, 2) + '\n');" "$1"
}

# ---------- Main path: full release -------------------------------------------
# 5 steps. The build is just `npm run build` (tsup -> dist/index.js); npm
# publish ships the tarball directly. Install method is
# `npm install -g @yawlabs/mcp` or `npx -y @yawlabs/mcp`. See
# docs/v0.70.3-binary-track-decision.md for the rationale and the
# install-store union follow-up.
TOTAL_STEPS=5

echo -e "${CYAN}Pre-flight checks...${NC}"
CURRENT_VERSION=$(current_pkg_version)
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  # A resume is not a licence to publish a dirty tree. The legitimate resume
  # case -- died between the bump and the commit -- dirties exactly
  # package.json, package-lock.json and server.json, so gate on everything
  # ELSE. Without this, a re-run packed and published whatever happened to be
  # in the working tree while the tag pointed at a commit that did not contain
  # it, and step 5 then attested that version to the MCP registry. npm forbids
  # overwriting a published version, so the irreproducible tarball is permanent.
  #
  # Pathspec exclusion, not a grep over the status codes: porcelain is
  # "XY <path>", so the staged form ("M  package.json" -- an interrupt in the
  # window between `git add` and `commit`) and the mixed "MM " form must be
  # tolerated too, and a code-shaped regex misses both. -uno keeps a stray
  # untracked scratch file from hard-failing the resume; it is warned about
  # below instead, because pressuring the operator toward `git stash -u`
  # mid-release is its own way to lose work.
  RESUME_DIRT=$(git status --porcelain -uno -- . \
    ':(exclude)package.json' ':(exclude)package-lock.json' ':(exclude)server.json')
  if [ -n "$RESUME_DIRT" ]; then
    printf '%s\n' "$RESUME_DIRT" >&2
    fail "Working directory has changes outside the version bump (listed above) -- commit or stash them before resuming. The tag would not contain them; the published tarball would."
  fi
  RESUME_UNTRACKED=$(git ls-files --others --exclude-standard)
  if [ -n "$RESUME_UNTRACKED" ]; then
    warn "Untracked files present -- not in the tag, but anything under package.json's \"files\" allow-list (dist, schemas, README.md, CHANGELOG.md) still gets packed: $(printf '%s' "$RESUME_UNTRACKED" | tr '\n' ' ')"
  fi
  info "Already at v${VERSION} -- resuming"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current: v${CURRENT_VERSION} -> v${VERSION}"
fi

# --- Guard: refuse to START from anywhere but main. Step 3 re-checks the
# branch right before the push (it can change between steps), but that check
# used to be the ONLY one, and it runs AFTER the bump commit and the annotated
# tag have landed on whatever branch is checked out. A feature branch sitting
# exactly at origin/main passes the HEAD comparison above, collects the
# v${VERSION} commit + tag, and only then dies -- and the re-run on main is not
# a resume (main's package.json is still the old version) so it trips the
# tag-collision guard below, leaving the operator to delete the stray tag and
# commit by hand. Failing here, before anything is written, is the cheap fix.
PREFLIGHT_BRANCH=$(current_branch)
if [ "$PREFLIGHT_BRANCH" != "main" ]; then
  if [ "$PREFLIGHT_BRANCH" = "HEAD" ]; then
    fail "Detached HEAD -- refusing to release. Check out main (git checkout main) and re-run ./release.sh ${VERSION}."
  fi
  fail "On branch '${PREFLIGHT_BRANCH}', not main -- refusing to release. The bump commit and tag would land on this branch and the push in step 3 would then refuse. Check out main and re-run ./release.sh ${VERSION}."
fi

# Pull the latest remote tags + commits so we can detect a stale local view of
# HEAD (e.g. a previous interrupted run that already pushed the bump).
git fetch --tags --prune origin >/dev/null 2>&1 || warn "git fetch failed (offline?) -- proceeding with local state"
LOCAL_HEAD=$(current_head_sha)
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  if [ "$RESUMING" = true ]; then
    info "Local HEAD differs from origin/main (resuming after a prior push) -- proceeding"
  elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD" 2>/dev/null; then
    # Strictly AHEAD: origin/main is an ancestor of HEAD, so there is nothing
    # to pull. Telling the operator to `git pull --ff-only` here is the wrong
    # instruction (it is a no-op) and hides the real state -- unpushed commits
    # that steps 3-5 would publish from a tree the remote has never seen.
    fail "Local main is AHEAD of origin/main (unpushed commits). Push them first: git push origin main"
  else
    fail "Local main is not at origin/main (behind or diverged). Pull first: git pull --ff-only origin main"
  fi
fi

# --- Guard: refuse a backward or duplicate version, BEFORE the expensive
# lint/test/build. npm only rejects a below-latest version at publish time
# (step 4), with a cryptic "Cannot implicitly apply the latest tag" error, after
# a full build + tag + push has already happened. Catch it here with a clear
# message. A version that is ALREADY published is a legitimate resume (later
# steps skip it), so only a not-yet-published version at or below the current
# npm latest is blocked.
LATEST_NPM=$(npm view "@yawlabs/mcp" version 2>/dev/null || echo "")
ALREADY_PUBLISHED=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ -n "$LATEST_NPM" ] && [ "$ALREADY_PUBLISHED" != "$VERSION" ]; then
  if node -e 'const a=process.argv[1].split(".").map(Number),b=process.argv[2].split(".").map(Number);for(let i=0;i<3;i++){if((a[i]||0)>(b[i]||0))process.exit(0);if((a[i]||0)<(b[i]||0))process.exit(1);}process.exit(1);' "$VERSION" "$LATEST_NPM"; then
    info "Version ${VERSION} > published latest ${LATEST_NPM}"
  else
    fail "Version ${VERSION} is not greater than the published latest ${LATEST_NPM} -- npm will not move the 'latest' tag backward. This is almost always a fat-finger; pick a version > ${LATEST_NPM}."
  fi
fi

# --- Guard: on a FRESH bump, a tag v${VERSION} that already exists is a
# collision (e.g. a fat-finger reusing an old release number, as 0.8.0 did with
# the 2026-04 tag). Step 3's "tag already exists" branch would silently keep
# the OLD tag and ship the wrong commit. On a resume the tag legitimately
# already points at the bump commit, so this only fires on a fresh bump.
if [ "$RESUMING" != true ] && git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null 2>&1; then
  EXISTING_TAG_COMMIT=$(git rev-list -n1 "v${VERSION}")
  fail "Tag v${VERSION} already exists (at ${EXISTING_TAG_COMMIT:0:9}) -- refusing to reuse an existing release number on a new commit. Pick an unused version, or delete the stale tag if it is wrong."
fi

# --- Guard: server.json must satisfy the MCP registry's own field limits
# BEFORE anything is built, committed, or published. The registry caps
# ServerDetail.description at 100 characters (and name at 3-200); it reports a
# violation as a 422 from `mcp-publisher publish` in STEP 5 -- which runs after
# the irreversible npm publish in step 4, stranding a version that is live on
# npm and can never be registered. Same class as the mcpName/version drift
# guards before the push in step 3, but a length violation is a STATIC property
# of a file this script never rewrites, so checking it here costs nothing and
# fails before the ~2-minute lint/typecheck/test/build block.
#
# Observed on v0.80.0, which died at step 5 with
#   {"message":"expected length <= 100","location":"body.description"}
# against a 121-character description, after npm had already accepted 0.80.0.
# The schema is the source of truth for these numbers:
# https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
REGISTRY_FIELD_ERRS=$(node -e '
const j = require("./server.json");
const errs = [];
const d = j.description;
if (typeof d !== "string" || d.length < 1) {
  errs.push("description is missing or empty (registry requires 1-100 chars)");
} else if (d.length > 100) {
  errs.push("description is " + d.length + " chars, registry cap is 100 -- trim " + (d.length - 100));
}
const n = j.name;
if (typeof n !== "string" || n.length < 3 || n.length > 200) {
  errs.push("name must be 3-200 chars, got " + (typeof n === "string" ? n.length : typeof n));
}
console.log(errs.join("; "));
') || fail "Could not read server.json to check the MCP-registry field limits -- is it valid JSON?"
if [ -n "$REGISTRY_FIELD_ERRS" ]; then
  fail "server.json violates the MCP registry schema: ${REGISTRY_FIELD_ERRS}. Fix server.json before releasing (package.json's description is meant to match it, so change both). Step 5 would otherwise 422 AFTER step 4's npm publish has already gone out, and npm forbids re-publishing a version."
fi
info "server.json passes the MCP-registry field limits"

if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + typecheck + tests"
  echo "  2. Build the bundled CLI (npm run build)"
  echo "  3. Bump version in package.json + server.json, commit, tag, push"
  echo "  4. Publish to npm (using ~/.npmrc automation token)"
  echo "  5. Publish server.json to the MCP registry (mcp-publisher)"
  echo ""
  echo -e "  Install method is ${CYAN}npm install -g @yawlabs/mcp${NC} (or ${CYAN}npx -y @yawlabs/mcp${NC})."
  echo ""
  # Non-interactive stdin (piped, nohup, an agent harness) gets EOF from
  # `read`, which returns non-zero -- under `set -e` that used to kill the run
  # with the generic "Release failed at line NNN" banner, as if a gate had
  # failed. Nothing has been mutated at this point, so say what happened and
  # exit the same clean way a declined prompt does. `|| REPLY=""` covers the
  # EOF-on-a-tty case (Ctrl-D) the same way.
  if [ ! -t 0 ]; then
    echo "Aborted: stdin is not a terminal, so the confirm prompt cannot be answered."
    echo "Re-run with -y (or SKIP_CONFIRM=1 ./release.sh ${VERSION}) to release non-interactively."
    exit 0
  fi
  read -p "Continue? (y/N) " -n 1 -r || REPLY=""
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

step 1 "Lint + typecheck + tests"
run_npm_check "Lint" lint 'Found [0-9]+ error' 'Checked [0-9]+ files'
run_npm_check "Type check" typecheck 'error TS[0-9]' '' 'npx tsc --noEmit'
# Tests go through the same wrapper as lint/typecheck: `npm test` is an
# npm-run script on the same host that segfaults (139/134) in npm's exit
# cleanup AFTER the tool has printed its report, so a bare `npm test || fail`
# turned a green suite into a failed release. vitest's own summary line is the
# authority. The failure pattern is anchored to that summary rather than the
# looser 'FAIL|[0-9]+ failed': a test NAME containing "FAILS" already exists
# (foundry-routing.test.ts) and captured console output is echoed verbatim, so
# a loose pattern can hard-fail a passing run.
# `Errors +N error` is vitest's UNHANDLED-error summary line (an unhandled
# rejection or an error thrown outside any test). vitest prints it beside a
# fully-green `Test Files N passed` and exits 1, so without it in fail_re the
# ARM64 tolerance path above -- done_re matches, rc is the segfault -- would
# wave a red run through. Same one-or-more-space shape as the sibling summary
# rows; what keeps a test that echoes captured output from false-matching it
# is the trailing `[0-9]+ error` shape, not the spacing.
run_npm_check "Tests" test 'Test Files +[0-9]+ failed|Tests +[0-9]+ failed|Errors +[0-9]+ error' 'Test Files +[0-9]+ passed'
info "Lint + typecheck + tests passed"

step 2 "Build"
# This build is deliberately belt-and-braces: package.json's `prepublishOnly`
# rebuilds again inside step 4's `npm publish`. Keeping it here fails a broken
# build BEFORE the irreversible commit+tag+push of step 3, which is worth one
# extra tsup run (a couple of seconds).
#
# Same ARM64 tolerance as run_npm_check, applied to the ARTIFACT rather than to
# a log marker: MINGW64 on Windows ARM64 can segfault (139/134) in npm's exit
# cleanup AFTER tsup has already written dist/index.js. tsup prints no stable
# completion marker, so the freshly-rewritten artifact is the evidence -- if
# dist/index.js is not newer than the moment this step started, the build
# really did fail.
BUILD_STARTED_AT=$(date +%s)
BUILD_RC=0
npm run build || BUILD_RC=$?
if [ "$BUILD_RC" -ne 0 ]; then
  BUILD_TOLERATED=false
  if [ "$IS_MINGW_ARM64" = true ] && { [ "$BUILD_RC" -eq 139 ] || [ "$BUILD_RC" -eq 134 ]; }; then
    DIST_MTIME=$(node -e 'try { process.stdout.write(String(Math.floor(require("fs").statSync("dist/index.js").mtimeMs / 1000))); } catch { process.stdout.write("0"); }')
    if [ "$DIST_MTIME" -ge "$BUILD_STARTED_AT" ]; then
      warn "Build: npm exited $BUILD_RC (ARM64 npm-run cleanup segfault) but dist/index.js was rewritten during this step -- tolerating"
      BUILD_TOLERATED=true
    fi
  fi
  [ "$BUILD_TOLERATED" = true ] || fail "Build failed (exit $BUILD_RC)"
fi
info "Build complete"

step 3 "Bump version to $VERSION, commit, tag, and push"
# Re-read current version (the resume path can skip a bump that's already done).
CURRENT_VERSION=$(current_pkg_version)
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "package.json already at v${VERSION} -- skipping bump"
  # ...but do NOT assume server.json came along. A tree where package.json was
  # bumped and server.json was not (an interrupted prior run, a hand-run
  # `npm version`, a bad merge) hits this branch, skips the bump entirely, and
  # then dies at the lockstep guard below with no way forward except editing
  # the file by hand. Re-read it here and self-heal.
  SERVER_VERSION=$(current_server_version)
  if [ "$SERVER_VERSION" = "$VERSION" ]; then
    info "server.json already at v${VERSION} -- skipping bump"
  else
    warn "server.json is at v${SERVER_VERSION} but package.json is v${VERSION} -- rewriting server.json to match"
    write_server_version "$VERSION"
    info "server.json bumped"
  fi
else
  # The one MUTATING npm call in the script, and the only one with no ARM64
  # segfault tolerance until now: `set -e` turned a 139 from npm's exit
  # cleanup into an abort AFTER package.json had already been rewritten. The
  # resume path recovers (package.json is excluded from the dirt check, and
  # server.json self-heals above), but the first run on the ARM box died here
  # every time. Same rule as run_npm_check: the tool's OUTPUT -- here the
  # version the file now carries -- is authoritative, not npm's exit code.
  bump_rc=0
  npm version "$VERSION" --no-git-tag-version || bump_rc=$?
  if [ "$bump_rc" -ne 0 ]; then
    BUMPED_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
    if [ "$IS_MINGW_ARM64" = true ] && { [ "$bump_rc" -eq 139 ] || [ "$bump_rc" -eq 134 ]; } && [ "$BUMPED_VERSION" = "$VERSION" ]; then
      warn "npm version exited $bump_rc (ARM64 npm exit-cleanup segfault) but package.json now reads v${VERSION} -- tolerating"
    else
      fail "npm version failed (exit $bump_rc); package.json reads '${BUMPED_VERSION:-unreadable}'"
    fi
  fi
  info "package.json bumped"
  # Keep server.json in lockstep. The script is the single source of truth
  # now; CI no longer rewrites server.json.
  write_server_version "$VERSION"
  info "server.json bumped"
fi

if [ -n "$(git status --porcelain package.json package-lock.json server.json 2>/dev/null)" ]; then
  git add package.json package-lock.json server.json
  # core.hooksPath is pointed at a path with no hooks in it, so the bump commit
  # cannot be rewritten or rejected by a local hook (the gates it would re-run
  # are step 1's, already green). MSYS_NO_PATHCONV=1 is load-bearing on this
  # script's primary host: Git Bash rewrites a Unix-shaped argument into a
  # Windows path before git.exe sees it, so `/dev/null` arrives as
  # C:/Users/<user>/scoop/apps/git/<ver>/dev/null. The effect happens to be the
  # same (both are hook-free), but the config value git records is not the one
  # written here -- pin it so the line means what it reads as on every host.
  MSYS_NO_PATHCONV=1 git -c core.hooksPath=/dev/null commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Nothing to commit (already at v${VERSION})"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "Tag v${VERSION} already exists"
else
  # Annotated (-a) so --follow-tags picks it up; lightweight tags are ignored
  # by --follow-tags and would silently fail to push.
  git tag -a "v${VERSION}" -m "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# Re-verify package.json matches the tag BEFORE pushing -- catching a stale
# local index that was bumped-after-tag here prevents the "tag pushed without
# the matching version bump" failure mode.
PKG_NOW=$(current_pkg_version)
if [ "$PKG_NOW" != "$VERSION" ]; then
  fail "package.json shows $PKG_NOW but tag is v${VERSION} -- refusing to push"
fi
SERVER_NOW=$(current_server_version)
if [ "$SERVER_NOW" != "$VERSION" ]; then
  fail "server.json shows $SERVER_NOW but tag is v${VERSION} -- refusing to push (registry would 400 on drift)"
fi
# The other half of the registry contract, checked in the same place and for
# the same reason: mcp-publisher proves ownership by reading `mcpName` out of
# the published npm package and comparing it to server.json's `name`. A
# mismatch is only surfaced in step 5, which runs AFTER the irreversible npm
# publish -- stranding the release with a version on npm that can never be
# registered. Version drift already fails here; name drift now does too.
MCPNAME_NOW=$(current_pkg_mcp_name)
SERVER_NAME_NOW=$(current_server_name)
if [ "$MCPNAME_NOW" != "$SERVER_NAME_NOW" ]; then
  fail "package.json mcpName (${MCPNAME_NOW:-<unset>}) != server.json name (${SERVER_NAME_NOW:-<unset>}) -- refusing to push. The MCP registry would reject the ownership check in step 5, after npm publish has already gone out."
fi

# Re-read the branch here (not at script start -- it can change between steps)
# and refuse to run the push from anywhere but main. `git push origin main`
# pushes the LOCAL main ref, not HEAD: from a feature branch it would push a
# main that does not contain the bump commit, and --follow-tags would skip
# v${VERSION} because the tag is not reachable from the pushed ref. The push
# "succeeds", nothing lands, and steps 4-5 publish a version whose commit and
# tag exist only on this workstation.
CURRENT_BRANCH=$(current_branch)
if [ "$CURRENT_BRANCH" != "main" ]; then
  if [ "$CURRENT_BRANCH" = "HEAD" ]; then
    fail "Detached HEAD -- refusing to push. Check out main (git checkout main) and re-run ./release.sh ${VERSION}."
  fi
  fail "On branch '${CURRENT_BRANCH}', not main -- refusing to run 'git push origin main --follow-tags'. It would push the local main ref (which does NOT contain the v${VERSION} bump commit) and silently skip the tag. Merge or check out main, then re-run ./release.sh ${VERSION}."
fi

git push origin main --follow-tags
info "Pushed to origin"

step 4 "Publish to npm"
# The script is the publisher now. ~/.npmrc must carry the automation token
# (NOT a WebAuthn web session -- the npm publishing rule in CLAUDE.md is
# explicit on this: `npm login --auth-type=web` overwrites the automation
# token and the next publish EOTPs on WebAuthn).
PUBLISHED_VERSION=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "@yawlabs/mcp@${VERSION} already on npm -- skipping"
else
  # Retry up to 3 times on EOTP/EAUTH/OTP (WebAuthn-fresh sessions sometimes
  # need ~30s for the auth backend to propagate); fail fast on everything else
  # so a packaging error or duplicate-version doesn't waste 60s spinning.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    # `|| PUBLISH_RC=$?` rather than `if npm publish ...; then`: the exit code
    # itself is needed below, and under `set -o pipefail` the pipeline carries
    # npm's code, not tee's.
    PUBLISH_RC=0
    npm publish --access public 2>&1 | tee "$PUBLISH_LOG" || PUBLISH_RC=$?
    if [ "$PUBLISH_RC" -eq 0 ]; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    # Same ARM64 tolerance the build and the step-1 gates get, applied to the
    # one command where a false failure is most expensive: npm can segfault
    # (139/134) in its exit cleanup AFTER the tarball has been accepted, and
    # npm forbids re-publishing a version, so a re-run of a "failed" publish
    # dies on EPUBLISHCONFLICT with the release half-done. The registry is the
    # authority -- ask it, with a short poll for the read path's lag.
    if [ "$IS_MINGW_ARM64" = true ] && { [ "$PUBLISH_RC" -eq 139 ] || [ "$PUBLISH_RC" -eq 134 ]; }; then
      PUBLISH_PROBE=""
      for PROBE_TRY in 1 2 3; do
        PUBLISH_PROBE=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
        [ "$PUBLISH_PROBE" = "$VERSION" ] && break
        sleep 6
      done
      if [ "$PUBLISH_PROBE" = "$VERSION" ]; then
        warn "npm publish exited $PUBLISH_RC (ARM64 npm exit-cleanup segfault) but @yawlabs/mcp@${VERSION} is live on npm -- tolerating"
        rm -f "$PUBLISH_LOG"
        break
      fi
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, your ~/.npmrc session is stale: see CLAUDE.md npm-token-restore."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  info "Published @yawlabs/mcp@${VERSION} to npm"
fi

step 5 "Publish server.json to MCP registry"
# Idempotence, per the header claim that every step is re-runnable: the
# registry rejects a duplicate (name, version), so a re-run after a COMPLETED
# step 5 died here. Ask the registry whether this exact version is already
# listed and skip the whole step (download, auth, publish) when it is.
# Probe-only by design: any failure -- offline, API change, unparseable body
# -- leaves REGISTRY_HAS_VERSION false and falls through to the publish path,
# which is exactly the pre-probe behavior.
REGISTRY_JSON=$(curl -fsSL --max-time 20 "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.YawLabs/mcp&version=${VERSION}" 2>/dev/null || echo "")
REGISTRY_HAS_VERSION=false
if [ -n "$REGISTRY_JSON" ] && printf %s "$REGISTRY_JSON" | node -e '
  let s = "";
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => {
    try {
      const j = JSON.parse(s);
      const hit = (j.servers || []).some((e) => e && e.server && e.server.version === process.argv[1]);
      process.exit(hit ? 0 : 1);
    } catch { process.exit(1); }
  });
' "$VERSION"; then
  REGISTRY_HAS_VERSION=true
fi

if [ "$REGISTRY_HAS_VERSION" = true ]; then
  info "io.github.YawLabs/mcp@${VERSION} already on the MCP registry -- skipping publish"
else
  # Check the published-npm first; mcp-publisher's `publish` validates that the
  # referenced npm package exists, and the registry mirror can lag the write
  # path by seconds.
  NPM_NOW=""
  for POLL_TRY in 1 2 3 4 5 6 7 8 9 10; do
    NPM_NOW=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
    [ "$NPM_NOW" = "$VERSION" ] && break
    sleep 6
  done
  if [ "$NPM_NOW" != "$VERSION" ]; then
    fail "npm does not show @yawlabs/mcp@${VERSION} after 60s -- refusing to publish to MCP registry (it would 400)"
  fi

  # Download + sha256-verify mcp-publisher to a temp dir. Pinned + digest-verified
  # the same way the old CI workflow did.
  WORKDIR=$(mktemp -d)
  # mcp-publisher ships a tarball per (platform, arch). Map the current host to
  # the matching tarball name so this works on a Linux, macOS, or Windows
  # release-driver machine.
  #
  # We use node (already a hard dep) rather than `uname` because MINGW64 on
  # Windows ARM64 reports x86_64 via `uname -m` even when the kernel is arm64,
  # which would pick the wrong Windows binary.
  HOST_INFO=$(node -e 'process.stdout.write(process.platform + " " + process.arch)')
  case "$HOST_INFO" in
    "linux x64")    GOOS=linux;   GOARCH=amd64 ;;
    "linux arm64")  GOOS=linux;   GOARCH=arm64 ;;
    "darwin x64")   GOOS=darwin;  GOARCH=amd64 ;;
    "darwin arm64") GOOS=darwin;  GOARCH=arm64 ;;
    "win32 x64")    GOOS=windows; GOARCH=amd64 ;;
    "win32 arm64")  GOOS=windows; GOARCH=arm64 ;;
    *) fail "Unsupported host for mcp-publisher: $HOST_INFO" ;;
  esac
  TARBALL="mcp-publisher_${GOOS}_${GOARCH}.tar.gz"
  info "Downloading mcp-publisher ${MCP_PUBLISHER_VERSION} (${GOOS}/${GOARCH})"
  curl -fsSL -o "${WORKDIR}/${TARBALL}" \
    "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/${TARBALL}"

  # Verify against the registry's per-release checksums file. This is the
  # source of truth (signed via the release's attestation) and is the only
  # correct sha256 to check against for the per-platform tarball we picked.
  info "Verifying ${TARBALL} against the release's checksums.txt"
  curl -fsSL -o "${WORKDIR}/checksums.txt" \
    "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/registry_${MCP_PUBLISHER_VERSION#v}_checksums.txt"
  # sha256sum on Linux/Git-Bash; shasum -a 256 is the macOS stock spelling.
  if command -v sha256sum >/dev/null; then
    (cd "$WORKDIR" && sha256sum -c --ignore-missing < checksums.txt) || fail "sha256 verification failed for ${TARBALL} -- refusing to run an unverified binary"
  else
    (cd "$WORKDIR" && shasum -a 256 -c --ignore-missing < checksums.txt) || fail "sha256 verification failed for ${TARBALL} -- refusing to run an unverified binary"
  fi

  # Windows tarballs extract to mcp-publisher.exe, POSIX ones to mcp-publisher.
  BIN_NAME="mcp-publisher"
  if [ "$GOOS" = "windows" ]; then BIN_NAME="mcp-publisher.exe"; fi
  tar -xzf "${WORKDIR}/${TARBALL}" -C "$WORKDIR" "$BIN_NAME"
  chmod +x "${WORKDIR}/${BIN_NAME}"
  "${WORKDIR}/${BIN_NAME}" --help >/dev/null
  info "mcp-publisher ${MCP_PUBLISHER_VERSION} ready (sha256 verified)"

  # Auth: the registry's `login github` accepts a pre-set GitHub token via
  # `MCP_GITHUB_TOKEN` (or `--token`) and skips the OAuth device flow -- it
  # exchanges the GitHub token for a fresh Registry JWT and writes it to
  # ~/.config/mcp-publisher/token.json.
  TOKEN_FILE="${HOME}/.config/mcp-publisher/token.json"
  # Return 0 (true in shell `if`) iff the persisted token is missing, unparseable,
  # or expired. Reads the JWT's `exp` claim via node so we don't reinvent the
  # JWT parser in bash.
  TOKEN_STATUS=$(mktemp)
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    if (!fs.existsSync(path)) { process.stdout.write("missing"); process.exit(0); }
    let t;
    try { t = JSON.parse(fs.readFileSync(path, "utf-8")); } catch { process.stdout.write("unparseable"); process.exit(0); }
    const p = (t.token || "").split(".")[1];
    if (!p) { process.stdout.write("unparseable"); process.exit(0); }
    let claims;
    try { claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { process.stdout.write("unparseable"); process.exit(0); }
    if (typeof claims.exp === "number" && claims.exp * 1000 > Date.now()) {
      process.stdout.write("valid");
    } else {
      process.stdout.write("expired");
    }
  ' "$TOKEN_FILE" > "$TOKEN_STATUS" 2>/dev/null || echo "unparseable" > "$TOKEN_STATUS"
  TOKEN_STATE=$(cat "$TOKEN_STATUS")
  rm -f "$TOKEN_STATUS"
  if [ "$TOKEN_STATE" != "valid" ]; then
    # Token refresh needs a GitHub token with publish rights on
    # `io.github.YawLabs/*` (per the prior release memory for the parallel
    # ssh-mcp repo, the MCP Registry `mcp-publisher` auth needs `read:org`).
    # Resolution order:
    #   1. $GITHUB_TOKEN (explicit env, takes priority -- the operator's
    #      workstation with a fine-grained PAT)
    #   2. $MCP_REGISTRY_TOKEN (an explicit override name some setups use)
    #   3. `gh auth token` (works on any host that has the `gh` CLI
    #      authenticated -- the established fallback for the parallel
    #      ssh-mcp / npmjs-mcp release scripts per their memory)
    # The mcp-publisher binary only needs a GitHub token at login time; it
    # persists its own registry JWT to ${TOKEN_FILE} afterward, so the
    # GitHub token does NOT need to be in env for subsequent releases.
    REGISTRY_GH_TOKEN="${GITHUB_TOKEN:-${MCP_REGISTRY_TOKEN:-}}"
    if [ -z "$REGISTRY_GH_TOKEN" ] && command -v gh >/dev/null 2>&1; then
      if REGISTRY_GH_TOKEN=$(gh auth token 2>/dev/null) && [ -n "$REGISTRY_GH_TOKEN" ]; then
        info "MCP-registry auth: using \`gh auth token\` (fallback)"
      else
        REGISTRY_GH_TOKEN=""
      fi
    fi
    if [ -z "$REGISTRY_GH_TOKEN" ]; then
      fail "mcp-publisher token ${TOKEN_STATE} and no GitHub token available. Set GITHUB_TOKEN (a PAT with publish rights on io.github.YawLabs/*), or run \`gh auth login\` so the \`gh auth token\` fallback works, or run once interactively: ${WORKDIR}/${BIN_NAME} login github"
    fi
    info "MCP-registry token ${TOKEN_STATE} -- refreshing via \`mcp-publisher login github\`"
    MCP_GITHUB_TOKEN="$REGISTRY_GH_TOKEN" "${WORKDIR}/${BIN_NAME}" login github
  else
    info "Reusing persisted mcp-publisher token at ${TOKEN_FILE}"
  fi

  "${WORKDIR}/${BIN_NAME}" publish
  info "Published server.json to MCP registry"
fi

# Final verification across the channels this script owns: npm, the
# MCP registry, and the local git tag.
echo ""
echo -e "${CYAN}Verifying...${NC}"
NPM_FINAL=$(npm view "@yawlabs/mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_FINAL" = "$VERSION" ]; then
  info "npm: @yawlabs/mcp@${NPM_FINAL}"
else
  warn "npm shows ${NPM_FINAL:-nothing} (expected $VERSION)"
fi

PKG_FINAL=$(current_pkg_version)
if [ "$PKG_FINAL" = "$VERSION" ]; then
  info "package.json: ${PKG_FINAL}"
else
  warn "package.json shows ${PKG_FINAL} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

echo ""
echo -e "${GREEN}  v${VERSION} released to npm + MCP registry.${NC}"
echo ""
echo -e "  npm:        https://www.npmjs.com/package/@yawlabs/mcp"
echo -e "  registry:   https://registry.modelcontextprotocol.io"
echo ""
echo -e "  Install:    ${CYAN}npm install -g @yawlabs/mcp${NC}"
echo -e "  Or run:     ${CYAN}npx -y @yawlabs/mcp${NC}"
echo ""
