"""The records shape: many small records through a chain of modules of a few kinds.

A skeleton to copy into a factory once and then own (docs/pipelines/README.md).
Runs as it is: python records.py <records dir> <outputs dir>
  <records dir>/<id>.json    one file per record (written, in git, or fetched)
  overrides/<id>.json        one record's quirk, read by the module it names (in git)
  <outputs dir>/<module>/<id>.json   one product per record per module, with provenance
"""

from __future__ import annotations

import hashlib
import inspect
import json
import shutil
import sys
from pathlib import Path
from typing import Any, ClassVar

Record = dict[str, Any]


# The one layer of polymorphism: the module kind. A producer adds a product to
# the record, a filter drops records, an analyzer reads and reports. Concrete
# modules are one class each, under one of the three, no deeper.
class Module:
    name: ClassVar[str]

    def version(self) -> str:
        return hashlib.sha256(inspect.getsource(type(self)).encode()).hexdigest()[:12]

    def override(self, rec: Record) -> dict:
        p = Path("overrides") / f"{rec['id']}.json"
        return json.loads(p.read_text()).get(self.name, {}) if p.exists() else {}


class Producer(Module):
    def produce(self, rec: Record) -> Any:
        raise NotImplementedError


class Filter(Module):
    def keep(self, rec: Record) -> bool:
        raise NotImplementedError


class Analyzer(Module):
    def analyze(self, recs: list[Record]) -> Any:
        raise NotImplementedError


class HasText(Filter):
    name = "has-text"

    def keep(self, rec):
        return bool(rec.get("text"))


class WordCount(Producer):
    name = "words"

    def produce(self, rec):
        # A record's quirk is data in its override file, never `if rec["id"] == …` here.
        return self.override(rec).get("count", len(rec["text"].split()))


class Totals(Analyzer):
    name = "totals"

    def analyze(self, recs):
        return {"records": len(recs), "words": sum(r["words"] for r in recs)}


# The chain is configuration: the order modules run in.
CHAIN: list[Module] = [HasText(), WordCount(), Totals()]


def run(records: Path, out: Path) -> None:
    # Every product is remade from scratch, so one whose record no longer
    # passes the filters doesn't linger with provenance that still looks valid.
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    recs = [json.loads(p.read_text()) for p in sorted(records.glob("*.json"))]
    for m in CHAIN:
        if isinstance(m, Filter):
            recs = [r for r in recs if m.keep(r)]
        elif isinstance(m, Producer):
            for r in recs:
                r[m.name] = m.produce(r)
                # Provenance on each product: which module version made it from
                # which record. `just rebuildable` checks every output names a
                # record that exists and a module in the chain.
                f = out / m.name / f"{r['id']}.json"
                f.parent.mkdir(parents=True, exist_ok=True)
                prov = {"module": m.name, "version": m.version(), "record": r["id"]}
                f.write_text(json.dumps({"value": r[m.name], "made_by": prov}) + "\n")
        elif isinstance(m, Analyzer):
            prov = {"module": m.name, "version": m.version(), "records": [r["id"] for r in recs]}
            (out / f"{m.name}.json").write_text(json.dumps({"value": m.analyze(recs), "made_by": prov}) + "\n")


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]))
