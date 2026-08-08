# List available commands
default:
    @just --list

# Install dependencies and bootstrap the local environment
[group("dev")]
setup:
    pnpm install
    pnpm run setup

# Run the unit test suite
[group("dev")]
test:
    pnpm run test

# Typecheck every workspace package
[group("dev")]
lint:
    pnpm run check

# Build the Next.js server
[group("dev")]
build:
    pnpm run build

# Start the dev server
[group("dev")]
run:
    pnpm run dev

# Release the CLI: bump cli/package.json on main and push (triggers cli-release.yml)
[group("ship")]
release-cli version:
    #!/usr/bin/env bash
    set -euo pipefail

    # The guarded release path. The two numbered checks below mirror the ones
    # in cli-release.yml's resolve job, so a bad version fails here in a second
    # rather than thirty seconds into CI. The workflow still re-runs them
    # itself — these are fast feedback, not the security boundary.

    VERSION="{{version}}"
    TAG="cli-v${VERSION}"

    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "error: version must look like 1.2.3 (got: ${VERSION})" >&2
      exit 1
    fi

    BRANCH="$(git branch --show-current)"
    if [[ "$BRANCH" != "main" ]]; then
      echo "error: releases are cut from main (currently on: ${BRANCH:-detached HEAD})" >&2
      exit 1
    fi

    if [[ -n "$(git status --porcelain)" ]]; then
      echo "error: working tree is dirty — commit or stash before releasing" >&2
      exit 1
    fi

    git fetch --quiet origin main --tags

    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
      echo "error: local main has diverged from origin/main — pull first" >&2
      exit 1
    fi

    CURRENT="$(jq -r .version cli/package.json)"
    if [[ "$CURRENT" == "$VERSION" ]]; then
      echo "error: cli/package.json is already ${VERSION}, so there is nothing to push." >&2
      echo "       If that release never completed, re-run it from the Actions tab" >&2
      echo "       (Release CLI → Run workflow) or use: just release-cli-retag ${VERSION}" >&2
      exit 1
    fi

    # Guard 1 (idempotency), mirroring cli-release.yml: the tag must not exist.
    if git ls-remote --tags --exit-code origin "refs/tags/${TAG}" >/dev/null 2>&1; then
      echo "error: ${TAG} already exists on origin — that version is already released." >&2
      exit 1
    fi

    # Guard 2 (regression), mirroring cli-release.yml: must beat the highest
    # released tag. sort -V so 0.1.10 sorts above 0.1.9.
    HIGHEST="$(git ls-remote --tags origin 'refs/tags/cli-v*' \
      | awk -F/ '{print $NF}' \
      | grep -v '\^{}$' \
      | sed 's/^cli-v//' \
      | sort -V \
      | tail -n1)"
    if [[ -n "$HIGHEST" ]]; then
      WINNER="$(printf '%s\n%s\n' "$VERSION" "$HIGHEST" | sort -V | tail -n1)"
      if [[ "$WINNER" != "$VERSION" ]]; then
        echo "error: ${VERSION} is not newer than the released cli-v${HIGHEST}." >&2
        echo "       To deliberately re-cut an older line, use: just release-cli-retag ${VERSION}" >&2
        exit 1
      fi
    fi

    jq --arg v "$VERSION" '.version = $v' cli/package.json > cli/package.json.tmp
    mv cli/package.json.tmp cli/package.json

    git add cli/package.json
    git commit --quiet -m "chore(cli): release v${VERSION}"
    git push --quiet origin main

    echo "pushed ${CURRENT} -> ${VERSION}. cli-release.yml will build and publish ${TAG}."
    echo "watch it:  gh run watch \$(gh run list --workflow=cli-release.yml -L1 --json databaseId -q '.[0].databaseId')"

# Re-cut an already-released line (skips both guards — see release-cli first)
[group("ship")]
release-cli-retag version commit="HEAD":
    #!/usr/bin/env bash
    set -euo pipefail

    # For patching an older line, e.g. 0.1.x after 0.2.0 shipped. Pushes a
    # cli-v* tag directly; cli-release.yml treats a tag push as explicit intent
    # and SKIPS both guards — no already-released check, no regression check —
    # and cli/package.json is left untouched, so the repo goes on recording
    # whatever version main is on. Use `release-cli` for normal releases.

    VERSION="{{version}}"
    TAG="cli-v${VERSION}"
    TARGET="$(git rev-parse --short "{{commit}}")"

    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "error: version must look like 1.2.3 (got: ${VERSION})" >&2
      exit 1
    fi

    echo "About to tag ${TARGET} as ${TAG} and push it."
    echo "This bypasses the already-released and version-regression checks,"
    echo "and does NOT update cli/package.json."
    read -r -p "Continue? [y/N] " reply
    [[ "$reply" =~ ^[yY]([eE][sS])?$ ]] || { echo "aborted."; exit 1; }

    git tag "$TAG" "{{commit}}"
    git push origin "$TAG"

# Trigger the Fly.io server deploy workflow
[group("ship")]
release-server:
    gh workflow run fly-deploy.yml
