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

# Tag and push a CLI release (triggers the cli-release workflow)
[group("ship")]
release-cli version:
    git tag "cli-v{{version}}"
    git push origin "cli-v{{version}}"

# Trigger the Fly.io server deploy workflow
[group("ship")]
release-server:
    gh workflow run fly-deploy.yml
