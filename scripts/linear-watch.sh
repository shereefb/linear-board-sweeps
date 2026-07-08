#!/bin/zsh
# launchd env shim for the auto-sweep launcher. launchd starts jobs with a minimal
# environment (no ~/.zshrc, a bare PATH), so set PATH for node/git/codex/claude here
# and hand off to the Node engine. Per-anchor LINEAR_API_KEY is loaded by the engine
# from each anchor's own .env — nothing secret lives in this file.
#
# Resolve our real directory even when invoked via a symlink (zsh :A resolves it).
set -u
HERE="${0:A:h}"

# Adjust these to the machine if node/codex/claude live elsewhere. Homebrew + a
# common nvm path + the Codex.app bundle cover the usual cases.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/Applications/Codex.app/Contents/Resources:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

exec node "$HERE/linear-watch.mjs" tick "$@"
