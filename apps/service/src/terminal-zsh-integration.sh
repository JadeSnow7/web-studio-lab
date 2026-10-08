# Session-only ZDOTDIR. Built-in zsh hooks preserve full entered command text.
preexec() {
  local command64 cwd64
  command64=$(printf '%s' "$1" | base64 | tr -d '\n')
  cwd64=$(printf '%s' "$PWD" | base64 | tr -d '\n')
  printf '\033]777;wsl;start_full;%s;%s\007' "$command64" "$cwd64"
  __wsl_active=1
}
precmd() {
  local result=$?
  if [[ ${__wsl_active:-0} == 1 ]]; then
    printf '\033]777;wsl;end;%s\007' "$result"
  fi
  __wsl_active=0
}
