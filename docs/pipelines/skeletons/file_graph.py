"""The file graph shape: rules that each declare a command, the files it reads
and the files it writes; only what's stale reruns.

A skeleton to copy into a factory once and then own (docs/pipelines/README.md).
A build tool or library of this kind can replace run() below; the rules stay.
Run it beside the layout below: python file_graph.py [<outputs dir>]
(default work/out). Building into another folder is how the drill rebuilds:
file_graph.py /tmp/drill, then compare the two folders, stamps included.

Layout it assumes:
  entries/<entry>.json   one config file per entry, found by name (written, in git)
  inputs/<entry>.txt     the fetched input (not in git; its own step fetches it)
  steps/*.py             one script per kind of step (in git)
  fixes/<entry>.json     a hand fix as data, applied by the fix step (in git)
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "work/out")
ENTRIES = sorted(p.stem for p in Path("entries").glob("*.json"))
PY = sys.executable


def rules():
    """Every rule: (name, files it reads, files it writes, command)."""
    for e in ENTRIES:
        conv, final = OUT / e / "converted.json", OUT / e / "final.json"
        yield (f"convert:{e}", [f"entries/{e}.json", f"inputs/{e}.txt", "steps/convert.py"],
               [conv], [PY, "steps/convert.py", e, str(OUT)])
        # A hand fix is a rule like any other: its input is committed, so every
        # rebuild makes it again. An entry with no fix file copies through.
        fix = Path(f"fixes/{e}.json")
        yield (f"fix:{e}", [conv, "steps/fix.py"] + ([fix] if fix.exists() else []),
               [final], [PY, "steps/fix.py", e, str(OUT)])


def rel(f):
    """A path as the stamps record it: relative to the outputs folder when it's
    in there, so a build into another folder (the drill) stamps the same."""
    p = Path(f)
    return "$OUT/" + str(p.relative_to(OUT)) if p.is_relative_to(OUT) else str(p)


def digest(reads, cmd):
    """Stale by content, never by file times: a copy or a checkout changes
    times without changing a byte. The command is part of it too (with the
    outputs folder and the interpreter's path left out)."""
    h = hashlib.sha256(json.dumps([rel(c) for c in cmd[1:]]).encode())
    for f in reads:
        h.update(rel(f).encode() + Path(f).read_bytes())
    return h.hexdigest()


def run():
    if not ENTRIES:
        sys.exit("file_graph: no entries/*.json here")
    stamps_file = OUT / ".stamps.json"
    stamps = json.loads(stamps_file.read_text()) if stamps_file.exists() else {}
    for name, reads, writes, cmd in rules():  # listed in order; a tool would sort the graph
        d = digest(reads, cmd)
        if stamps.get(name, {}).get("digest") == d and all(Path(w).exists() for w in writes):
            continue
        print(name)
        subprocess.run(cmd, check=True)
        # The run record `just rebuildable` reads: which rule made which files.
        stamps[name] = {"digest": d, "writes": [rel(w) for w in writes]}
        OUT.mkdir(parents=True, exist_ok=True)
        stamps_file.write_text(json.dumps(stamps, indent=1, sort_keys=True) + "\n")


if __name__ == "__main__":
    run()
