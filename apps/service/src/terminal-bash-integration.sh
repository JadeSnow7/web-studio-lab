# Per-session rc, never sourced from or written into user global shell configuration.
# OSC metadata is observation data, not a trusted execution/authorization receipt.
__wsl_active=0
__wsl_start() {
  if [[ $__wsl_active == 0 && $BASH_COMMAND != __wsl_prompt* ]]; then
    __wsl_active=1
    local command64 cwd64
    command64=$(printf '%s' "$BASH_COMMAND" | base64 | tr -d '\n')
    cwd64=$(printf '%s' "$PWD" | base64 | tr -d '\n')
    printf '\033]777;wsl;start;%s;%s\007' "$command64" "$cwd64"
  fi
}
__wsl_prompt() {
  local result=$?
  if [[ $__wsl_active == 1 ]]; then
    printf '\033]777;wsl;end;%s\007' "$result"
  fi
  __wsl_active=0
}
PROMPT_COMMAND=__wsl_prompt
trap '__wsl_start' DEBUG
