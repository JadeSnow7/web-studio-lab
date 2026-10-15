import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
assert re.fullmatch(r"/home/agent/workspace/\.wsl-apps/[a-f0-9-]{36}", str(root))
assert not root.is_symlink() and root.resolve() == root and os.geteuid() != 0
os.chdir(root)
sys.path.insert(0, str(root))
payload = json.load(sys.stdin)
db = root / ".data/edu.db"
assert db.is_file() and not db.is_symlink() and db.stat().st_nlink == 1
if payload["seed"]:
    from server.app import create_admin

    create_admin(db, payload["username"], payload["password"])
connection = sqlite3.connect("file:" + str(db) + "?mode=ro", uri=True)
count = connection.execute("SELECT COUNT(*) FROM admins WHERE username=?", (payload["username"],)).fetchone()[0]
connection.close()
processes = []
registered = []
for process in Path("/proc").iterdir():
    if not process.name.isdigit() or int(process.name) == os.getpid():
        continue
    try:
        if process.stat().st_uid != os.geteuid():
            continue
        fields = (process / "stat").read_text().rsplit(") ", 1)[1].split()
        identity = {"pid": int(process.name), "startTime": fields[19], "group": int(fields[2])}
        if any(identity == expected for expected in payload.get("expected", [])):
            registered.append(identity)
        cwd = (process / "cwd").resolve(strict=True)
        if cwd == root or root in cwd.parents:
            processes.append(identity)
    except (FileNotFoundError, ProcessLookupError):
        continue
print(json.dumps({
    "database": {
        "inode": db.stat().st_ino,
        "sha256": hashlib.sha256(db.read_bytes()).hexdigest(),
        "databaseMode": stat.S_IMODE(db.stat().st_mode),
        "dataMode": stat.S_IMODE(db.parent.stat().st_mode),
        "adminCount": count,
    },
    "appProcesses": processes,
    "registeredProcessesRemaining": registered,
}))
