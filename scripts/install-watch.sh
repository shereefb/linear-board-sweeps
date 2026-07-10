#!/bin/zsh
# Install the auto-sweep launcher: symlink the wrapper onto PATH and materialize the
# launchd plist into ~/Library/LaunchAgents with real paths. Does NOT activate
# anything — it prints the launchctl command so you flip the schedule on deliberately.
set -eu

SOURCE_HERE="${0:A:h}"                # scripts/
SOURCE_KIT="${SOURCE_HERE:h}"         # repo root
RUNTIME_KIT="${LINEAR_SWEEP_RUNTIME_KIT:-$HOME/.local/share/linear-board-sweeps/kit}"
KIT_REMOTE="${LINEAR_SWEEP_KIT_REMOTE:-$(git -C "$SOURCE_KIT" remote get-url origin 2>/dev/null || printf '%s' "$SOURCE_KIT")}"
BIN="$HOME/.local/bin"
AGENTS="$HOME/Library/LaunchAgents"
STATE="$HOME/.local/state/linear-board-sweeps"
PLIST="com.linear-board-sweeps.watch.plist"

mkdir -p "$BIN" "$AGENTS" "$STATE" "$HOME/.config/linear-board-sweeps"

if [[ "${RUNTIME_KIT:A}" != "${SOURCE_KIT:A}" ]]; then
  mkdir -p "${RUNTIME_KIT:h}"
  if [[ -d "$RUNTIME_KIT/.git" ]]; then
    git -C "$RUNTIME_KIT" fetch origin main
    git -C "$RUNTIME_KIT" merge --ff-only origin/main
    echo "updated managed kit $RUNTIME_KIT"
  else
    git clone "$KIT_REMOTE" "$RUNTIME_KIT"
    echo "cloned managed kit $RUNTIME_KIT"
  fi
  KIT="$RUNTIME_KIT"
  HERE="$KIT/scripts"
else
  KIT="$SOURCE_KIT"
  HERE="$SOURCE_HERE"
fi

chmod +x "$HERE/linear-watch.sh" "$HERE/linear-watch.mjs"

# Symlink the wrapper (zsh :A in it resolves back here, so linear-watch.mjs is found).
ln -sf "$HERE/linear-watch.sh" "$BIN/linear-watch.sh"
echo "linked $BIN/linear-watch.sh -> $HERE/linear-watch.sh"

node - "$KIT" "$KIT_REMOTE" <<'NODE'
const fs = require("fs");
const path = require("path");
const [kitPath, kitRemote] = process.argv.slice(2);
const configDir = path.join(process.env.HOME, ".config", "linear-board-sweeps");
const registryPath = path.join(configDir, "registry.json");
let registry = { autoUpdate: true, kitPath: null, kitRef: "main", kitRemote: null, shipRunner: false, capacity: { maxActiveChildren: 10 }, repos: [], managedAnchors: {} };
if (fs.existsSync(registryPath)) registry = { ...registry, ...JSON.parse(fs.readFileSync(registryPath, "utf8")) };
const rawCapacity = registry.capacity?.maxActiveChildren;
const configuredCapacity = rawCapacity === null || rawCapacity === "" ? Number.NaN : Number(rawCapacity);
registry = { ...registry, capacity: { ...(registry.capacity || {}), maxActiveChildren: Number.isFinite(configuredCapacity) ? Math.max(1, Math.floor(configuredCapacity)) : 10 } };
registry.kitPath = kitPath;
registry.kitRemote = kitRemote || registry.kitRemote;
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
NODE
echo "registry kitPath -> $KIT"

# Materialize the plist with real paths (the template ships with __PLACEHOLDERS__).
sed -e "s#__BIN__#$BIN#g" -e "s#__STATE__#$STATE#g" "$KIT/templates/launchd/$PLIST" > "$AGENTS/$PLIST"
echo "installed $AGENTS/$PLIST"

cat <<EOF

Installed. Nothing is scheduled yet.

1) Register each workspace anchor (the repo holding .claude/linear-sweep.json):
     node "$HERE/linear-watch.mjs" register /path/to/workspace/anchor-repo

2) The launcher now runs from a managed clean kit clone:
     ~/.config/linear-board-sweeps/registry.json
     -> kitPath is $KIT

3) Register creates managed workspace metadata under:
     ~/.local/share/linear-board-sweeps/workspaces/<anchor>/

   Scheduled dispatch uses those managed clones; source checkout dirtiness is
   advisory after pushed commits are available on origin.

4) Add the 'auto-sweep' project label in Linear to each project you want swept.

5) Validate the host and managed workspaces:
     node "$HERE/linear-watch.mjs" doctor

6) Dry-run against the live board (spends NO tokens — logs what it would dispatch):
     node "$HERE/linear-watch.mjs" tick --dry-run

7) Activate the 10-min schedule:
     launchctl bootstrap gui/\$(id -u) "$AGENTS/$PLIST"
     launchctl kickstart -k gui/\$(id -u)/com.linear-board-sweeps.watch   # run once now

   Health / stop:
     node "$HERE/linear-watch.mjs" health
     node "$HERE/linear-watch.mjs" doctor --json
     launchctl bootout gui/\$(id -u)/com.linear-board-sweeps.watch
EOF
