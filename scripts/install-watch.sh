#!/bin/zsh
# Install the auto-sweep launcher: symlink the wrapper onto PATH and materialize the
# launchd plist into ~/Library/LaunchAgents with real paths. Does NOT activate
# anything — it prints the launchctl command so you flip the schedule on deliberately.
set -eu

HERE="${0:A:h}"                       # scripts/
KIT="${HERE:h}"                       # repo root
BIN="$HOME/.local/bin"
AGENTS="$HOME/Library/LaunchAgents"
STATE="$HOME/.local/state/linear-board-sweeps"
PLIST="com.linear-board-sweeps.watch.plist"

mkdir -p "$BIN" "$AGENTS" "$STATE" "$HOME/.config/linear-board-sweeps"
chmod +x "$HERE/linear-watch.sh" "$HERE/linear-watch.mjs"

# Symlink the wrapper (zsh :A in it resolves back here, so linear-watch.mjs is found).
ln -sf "$HERE/linear-watch.sh" "$BIN/linear-watch.sh"
echo "linked $BIN/linear-watch.sh -> $HERE/linear-watch.sh"

# Materialize the plist with real paths (the template ships with __PLACEHOLDERS__).
sed -e "s#__BIN__#$BIN#g" -e "s#__STATE__#$STATE#g" "$KIT/templates/launchd/$PLIST" > "$AGENTS/$PLIST"
echo "installed $AGENTS/$PLIST"

cat <<EOF

Installed. Nothing is scheduled yet.

1) Register each workspace anchor (the repo holding .claude/linear-sweep.json):
     node "$HERE/linear-watch.mjs" register /path/to/workspace/anchor-repo

2) Point the launcher at your kit clone for auto-update (edit the registry):
     ~/.config/linear-board-sweeps/registry.json
     -> set "kitPath" to this repo ($KIT) and, optionally, "kitRemote" to its origin URL

3) Add the 'auto-sweep' project label in Linear to each project you want swept.

4) Dry-run against the live board (spends NO tokens — logs what it would dispatch):
     node "$HERE/linear-watch.mjs" tick --dry-run

5) Activate the 10-min schedule:
     launchctl bootstrap gui/\$(id -u) "$AGENTS/$PLIST"
     launchctl kickstart -k gui/\$(id -u)/com.linear-board-sweeps.watch   # run once now

   Health / stop:
     node "$HERE/linear-watch.mjs" health
     launchctl bootout gui/\$(id -u)/com.linear-board-sweeps.watch
EOF
