# Merge Verdict Task Runner

default:
    @just --list

# Run unit tests
test:
    pnpm test

# Run linter checks
lint:
    pnpm run lint

# Automatically format codebase
format:
    pnpm run format

# Run TypeScript typechecker
typecheck:
    pnpm run typecheck

# Verify markdown files for broken links, em dashes, and emojis
check-docs:
    python3 scripts/check-docs.py
