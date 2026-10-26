#!/usr/bin/env bash
# FlowDeck hook relay: forwards a Claude Code hook event to the FlowDeck app.
# Usage: hook.sh <EventName>   (hook JSON arrives on stdin)
#
# - Inert outside FlowDeck: exits immediately when FLOWDECK_NODE_ID is not set.
# - Never blocks Claude: 1 s timeout and always exits 0.
# - The node token is read from the node's 0600 identity file and travels in a header read from
#   a file descriptor: it is never in argv or in the environment.
# - When the app is closed, the last event name is spooled so the canvas is right on reopen.
[ -z "${FLOWDECK_NODE_ID:-}" ] && exit 0
case "$FLOWDECK_NODE_ID" in *[!A-Za-z0-9_-]*) exit 0 ;; esac

event="${1:-}"
case "$event" in
  SessionStart|UserPromptSubmit|PostToolUse|Stop|Notification|SessionEnd|PermissionRequest|Interrupt) ;;
  *) exit 0 ;;
esac

if [ "$event" = "PostToolUse" ]; then
  # Only the transition matters; tool input/output never leaves Claude.
  cat >/dev/null
  body='{}'
else
  body="$(head -c 262144)"
fi

token=""
if [ -n "${FLOWDECK_IDENTITY:-}" ] && [ -f "$FLOWDECK_IDENTITY" ]; then
  token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$FLOWDECK_IDENTITY" | head -n 1)"
fi
[ -z "$token" ] && token="${FLOWDECK_NODE_TOKEN:-}" # sessions started by FlowDeck 0.1.0

spool() {
  # The periodic idle reminder is not a state change worth remembering.
  case "$body" in *'"notification_type"'*'"idle_prompt"'*) return ;; esac
  [ -n "${FLOWDECK_SPOOL:-}" ] && [ -d "$FLOWDECK_SPOOL" ] || return
  (umask 077 && printf '%s\n' "$event" >"$FLOWDECK_SPOOL/$FLOWDECK_NODE_ID") 2>/dev/null
}

if [ -z "${FLOWDECK_SOCK:-}" ] || [ ! -S "$FLOWDECK_SOCK" ]; then
  spool
  exit 0
fi

printf '%s' "$body" | curl -sf --max-time 1 --unix-socket "$FLOWDECK_SOCK" \
  -H @<(printf 'X-FlowDeck-Node: %s\nX-FlowDeck-Token: %s\n' "$FLOWDECK_NODE_ID" "$token") \
  -H 'Content-Type: application/json' \
  --data-binary @- "http://flowdeck/event/$event" >/dev/null 2>&1 || spool
exit 0
