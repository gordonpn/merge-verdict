# Merge Verdict Task Runner

default:
    @just --list

# Build standalone ESM and CommonJS distributions
build:
    pnpm run build

# Verify standalone distribution bundle integrity in an isolated directory
test-build:
    pnpm run test:build

# Run unit tests
test:
    pnpm test

# Run unit tests with code coverage report
test-coverage:
    pnpm run test:coverage

# Lint GitHub Actions workflow definitions
lint-workflows:
    actionlint

# Audit production dependencies; set audit-level=low to also fail on lower severities
audit audit-level="high":
    pnpm audit --prod --audit-level={{quote(audit-level)}}

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
