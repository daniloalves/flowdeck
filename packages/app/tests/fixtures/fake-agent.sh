#!/usr/bin/env bash
# Stand-in for the agent CLIs used by FlowDeck's integration and E2E tests. The personality comes
# from the name it is called by (fake-claude.sh, fake-codex.sh, fake-kiro.sh are symlinks):
#
#   claude  honours --session-id/--resume/--continue/--settings; fires hooks from the --settings
#           file; SessionStart at startup; writes a transcript with one usage line per prompt.
#   codex   honours `resume <id>` / `resume --last`; finds hooks in the -c overrides; like the
#           real Codex, SessionStart and the session id only appear with the first prompt.
#   kiro    honours `chat [--resume]`; no hooks at all; prints output while "working".
#
# Prompts (one per line on stdin):
#   PERMISSION ...  -> permission event (Notification / PermissionRequest); next line approves
#   SLOW ...        -> stays busy for 3 s
#   INTERRUPT ...   -> (codex) ends the turn with Interrupt instead of Stop
#   exit            -> process exits (pane becomes dead)
#
# Every invocation appends its argv and selected env facts to $FAKE_AGENT_LOG.
set -u

personality="$(basename "$0" .sh)"
personality="${personality#fake-}"
args=("$@")
settings="" session="" mode="new"

case "$personality" in
  claude)
    while [ $# -gt 0 ]; do
      case "$1" in
        --settings) settings="$2"; shift 2 ;;
        --mcp-config) shift 2 ;;
        --session-id) session="$2"; mode="new"; shift 2 ;;
        --resume|-r) session="$2"; mode="resume"; shift 2 ;;
        --continue|-c) mode="continue"; shift ;;
        *) shift ;;
      esac
    done
    config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    ;;
  codex)
    if [ "${1:-}" = "resume" ]; then
      if [ "${2:-}" = "--last" ]; then mode="continue"; else session="${2:-}"; mode="resume"; fi
    fi
    config_dir="${CODEX_HOME:-$HOME/.codex}"
    ;;
  kiro)
    [ "${1:-}" = "chat" ] || { echo "fake-kiro: expected 'chat'" >&2; exit 2; }
    for a in "$@"; do [ "$a" = "--resume" ] && mode="continue"; done
    config_dir="$HOME/.kiro"
    ;;
  *) echo "unknown personality $personality" >&2; exit 2 ;;
esac

if [ -n "${FAKE_AGENT_LOG:-}" ]; then
  {
    printf 'ARGS %s' "$personality"; printf ' %q' "${args[@]}"; printf '\n'
    printf 'ENV %s node=%s identity=%s token=%s config=%s codex_home=%s apikey=%s mode=%s\n' "$personality" \
      "${FLOWDECK_NODE_ID:-}" "${FLOWDECK_IDENTITY:+set}" "${FLOWDECK_NODE_TOKEN:+leaked}" "${CLAUDE_CONFIG_DIR:-<unset>}" \
      "${CODEX_HOME:-<unset>}" "${ANTHROPIC_API_KEY:+set}${OPENAI_API_KEY:+set}" "$mode"
  } >>"$FAKE_AGENT_LOG"
fi

# Hook relay: from the --settings file (claude) or the -c overrides (codex).
hook_script=""
case "$personality" in
  claude) [ -n "$settings" ] && [ -f "$settings" ] && hook_script="$(grep -o "'[^']*hook.sh'" "$settings" | head -1 | tr -d "'")" ;;
  codex) hook_script="$(printf '%s\n' "${args[@]}" | grep -o "'[^']*hook.sh'" | head -1 | tr -d "'")" ;;
esac

fire() { # fire <event> <json>
  [ -n "$hook_script" ] || return 0
  printf '%s' "$2" | "$hook_script" "$1"
}

new_uuid() { cat /proc/sys/kernel/random/uuid; }

mkdir -p "$config_dir"
transcript_for() {
  case "$personality" in
    claude) mkdir -p "$config_dir/projects/-fake-project"; echo "$config_dir/projects/-fake-project/$1.jsonl" ;;
    *) mkdir -p "$config_dir/fake-sessions"; echo "$config_dir/fake-sessions/$1.jsonl" ;;
  esac
}

usage_line() {
  local id="msg_$(date +%s%N)"
  printf '{"type":"assistant","timestamp":"%s","requestId":"req_%s","message":{"id":"%s","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":10}}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$id" "$id" >>"$(transcript_for "$session")"
}

started=0
session_start() { # codex: lazily, with the first prompt
  [ "$started" = 1 ] && return
  started=1
  [ -z "$session" ] && session="$(new_uuid)"
  local source="startup"; [ "$mode" = "resume" ] && source="resume"
  fire SessionStart "{\"session_id\":\"$session\",\"hook_event_name\":\"SessionStart\",\"source\":\"$source\"}"
}

case "$personality" in
  claude) [ -z "$session" ] && session="$(new_uuid)"; session_start ;;
  kiro) session="kiro-$$" ;;
esac
echo "fake-$personality ready ($mode)"

busy() { # busy <seconds>: kiro prints while working so the activity monitor sees output
  if [ "$personality" = "kiro" ]; then
    local ticks; ticks="$(awk -v s="$1" 'BEGIN { print int(s / 0.4) + 1 }')"
    for _ in $(seq 1 "$ticks"); do printf '.'; sleep 0.4; done; echo
  else
    sleep "$1"
  fi
}

while IFS= read -r line; do
  [ -z "$line" ] && continue
  [ "$line" = "exit" ] && exit 0
  [ "$personality" = "codex" ] && session_start
  echo "> $line"
  printf '%s\n' "$line" >>"$(transcript_for "$session").prompts"
  fire UserPromptSubmit "{\"session_id\":\"$session\",\"hook_event_name\":\"UserPromptSubmit\"}"
  case "$line" in
    PERMISSION*)
      if [ "$personality" = "codex" ]; then
        fire PermissionRequest "{\"session_id\":\"$session\",\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"Bash\",\"tool_input\":{\"description\":\"run the test suite\"}}"
      else
        fire Notification "{\"session_id\":\"$session\",\"hook_event_name\":\"Notification\",\"notification_type\":\"permission_prompt\",\"message\":\"Claude needs your permission to use Bash\"}"
      fi
      echo "Allow Bash? (type anything)"
      IFS= read -r _answer
      fire PostToolUse "{\"session_id\":\"$session\",\"tool_name\":\"Bash\"}"
      busy 0.3
      ;;
    SLOW*) busy 3 ;;
    *) busy 0.3 ;;
  esac
  [ "$personality" = "claude" ] && usage_line
  echo "done: $line"
  case "$line" in
    INTERRUPT*) fire Interrupt "{\"session_id\":\"$session\",\"hook_event_name\":\"Interrupt\"}" ;;
    *) fire Stop "{\"session_id\":\"$session\",\"hook_event_name\":\"Stop\"}" ;;
  esac
done
