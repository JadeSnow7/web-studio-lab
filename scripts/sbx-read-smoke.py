#!/usr/bin/env python3
"""仅在 Linux guest 执行一次真实 Codex 文件读取 smoke，证据保留在新目录。"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("probe_dir", type=Path, help="必须为尚不存在的 guest 绝对目录")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("此脚本仅在 Linux guest 中执行")
    probe_dir = args.probe_dir
    if not probe_dir.is_absolute():
        parser.error("probe_dir 必须是绝对路径")
    probe_dir.mkdir(mode=0o700)
    nonce_path = probe_dir / "nonce.txt"
    nonce = secrets.token_hex(32)
    nonce_path.write_text(nonce + "\n", encoding="utf-8")
    prompt = f"读取文件 {nonce_path}，只回复文件中的 nonce，不添加任何解释。"
    (probe_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
    command = [
        "codex", "exec", "--json", "--skip-git-repo-check",
        "--sandbox", "read-only", "-C", str(probe_dir), prompt,
    ]
    summary = {
        "ordinary_read": False,
        "command_execution": False,
        "agent_message": False,
        "turn_completed": False,
        "process_exit_zero": False,
        "timed_out": False,
        "passed": False,
        "command": command,
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
    }
    try:
        with (probe_dir / "shell-read.txt").open("w", encoding="utf-8") as output:
            subprocess.run(["cat", str(nonce_path)], stdout=output, check=True)
        summary["ordinary_read"] = (probe_dir / "shell-read.txt").read_text(encoding="utf-8").strip() == nonce
        with (probe_dir / "codex.jsonl").open("w", encoding="utf-8") as output, (probe_dir / "codex.stderr").open("w", encoding="utf-8") as error:
            child = subprocess.Popen(command, cwd=probe_dir, stdin=subprocess.DEVNULL, stdout=output, stderr=error, start_new_session=True)
            try:
                exit_code = child.wait(timeout=180)
            except subprocess.TimeoutExpired:
                summary["timed_out"] = True
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                exit_code = child.returncode
        (probe_dir / "exit-code.txt").write_text(str(exit_code) + "\n", encoding="utf-8")
        summary["process_exit_zero"] = exit_code == 0
        for line in (probe_dir / "codex.jsonl").read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError("Codex JSONL 事件必须是对象")
            if event.get("type") == "turn.completed":
                summary["turn_completed"] = True
            if event.get("type") != "item.completed":
                continue
            item = event["item"]
            if item.get("type") == "command_execution":
                if item.get("exit_code") == 0 and str(nonce_path) in item.get("command", "") and item.get("aggregated_output", "").strip() == nonce:
                    summary["command_execution"] = True
            if item.get("type") == "agent_message" and item.get("text", "").strip() == nonce:
                summary["agent_message"] = True
        summary["passed"] = all(summary[key] for key in ["ordinary_read", "command_execution", "agent_message", "turn_completed", "process_exit_zero"]) and not summary["timed_out"]
    finally:
        (probe_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not summary["passed"]:
        raise RuntimeError(f"Codex 文件读取验证失败，证据保留在 {probe_dir}")
    print(probe_dir)


if __name__ == "__main__":
    main()
