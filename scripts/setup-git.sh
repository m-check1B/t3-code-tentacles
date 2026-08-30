#!/bin/sh
# Wire the repo-local git identity (.gitidentity) and hooks (.githooks).
# Idempotent; safe to re-run. Run once after clone. Never use --no-verify.
set -eu

git rev-parse --show-toplevel >/dev/null 2>&1 || {
	echo "setup-git.sh: not inside a git repository" >&2
	exit 1
}

# Single identity authority: .gitidentity via include.path.
git config --local --unset-all user.name >/dev/null 2>&1 || true
git config --local --unset-all user.email >/dev/null 2>&1 || true
if ! git config --local --get-all include.path 2>/dev/null | grep -qxF '../.gitidentity'; then
	git config --local --add include.path "../.gitidentity"
fi

# Versioned hooks.
git config --local core.hooksPath .githooks

chmod +x .githooks/pre-commit .githooks/commit-msg .githooks/pre-merge-commit

echo "setup-git.sh: core.hooksPath=.githooks include.path=../.gitidentity"
echo "resolved identity:"
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
