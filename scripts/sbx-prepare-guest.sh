#!/usr/bin/env bash
set -euo pipefail

# 仅在已创建的 Linux arm64 guest 中执行；不处理认证、模型或网络策略。
test "$(uname -s)" = Linux
test "$(uname -m)" = aarch64
sbx_prepare_dir=$(mktemp -d)
trap 'rm -rf -- "$sbx_prepare_dir"' EXIT
sbx_node_archive="$sbx_prepare_dir/node-v24.21.0-linux-arm64.tar.gz"
curl --fail --location \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz \
  --output "$sbx_node_archive"
printf '%s  %s\n' \
  724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 \
  "$sbx_node_archive" | sha256sum --check -
sudo -n tar -xzf "$sbx_node_archive" -C /usr/local --strip-components=1
export PATH="/usr/local/bin:/usr/local/share/npm-global/bin:$PATH"
test "$(node --version)" = v24.21.0
npm install --global --prefix /usr/local/share/npm-global \
  @openai/codex@0.160.0 pnpm@10.34.6
test "$(codex --version)" = 'codex-cli 0.160.0'
test "$(pnpm --version)" = 10.34.6
node --version
npm --version
codex --version
pnpm --version
