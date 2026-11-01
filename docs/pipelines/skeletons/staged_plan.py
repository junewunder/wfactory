"""The staged plan shape: typed stages over one case, one class per kind of case.

A skeleton to copy into a factory once and then own (docs/pipelines/README.md).
Runs as it is: python staged_plan.py <subject> <inputs dir> <outputs dir>
with <inputs dir>/<subject>.json holding {"parts": {"lid": {"size": 3}, ...}}.
"""

from __future__ import annotations

import hashlib
import inspect
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar


@dataclass
class Ctx:
    inputs: Path  # fetched inputs, read-only
    out: Path  # work/out, or the drill's scratch folder


# The one layer of polymorphism: Subject, and one subclass per subject, no deeper.
# A subject changes the pipeline through three doors only:
#   attributes  facts shared stages ask about (declared in a stage's reads_attrs);
#   methods     work that is wholly the subject's own;
#   hooks       fixes: pre_<stage>, post_<stage>, and post_<item> per item of a list.
# Shared code never asks which subject it has.
class Subject:
    name: ClassVar[str]
    metric: ClassVar[bool] = True

    def extras(self, ctx: Ctx) -> dict[str, Any]:
        return {}


# One file per subject in a real factory (subjects/<name>.py, imported by name),
# so two lanes on two subjects never touch the same file.
class Teapot(Subject):
    name = "teapot"
    metric = False

    def extras(self, ctx: Ctx) -> dict[str, Any]:
        return {"strainer": {"size": 2}}

    def post_part(self, ctx: Ctx, key: str, spec: dict) -> dict:
        if key == "lid":  # a hand fix, as code that runs on every rebuild
            spec["clearance"] = 0.5
        return spec


SUBJECTS = {s.name: s for s in (Teapot,)}


# Stages are the framework's own, a closed set; they never vary per subject.
class Stage:
    name: ClassVar[str]
    reads_attrs: ClassVar[tuple[str, ...]] = ()
    calls: ClassVar[tuple[str, ...]] = ()  # subject methods it calls
    item: ClassVar[str | None] = None  # the per-item hook's name, for stages that make a list

    def inputs(self, ctx: Ctx, s: Subject) -> dict[str, Any]:
        raise NotImplementedError

    def run(self, ctx: Ctx, inp: dict[str, Any], s: Subject) -> dict[str, Any]:
        raise NotImplementedError


class Specs(Stage):
    name = "specs"
    reads_attrs = ("metric",)
    calls = ("extras",)
    item = "part"

    def inputs(self, ctx, s):
        return json.loads((ctx.inputs / f"{s.name}.json").read_text())

    def run(self, ctx, inp, s):
        unit = "mm" if s.metric else "in"
        parts = {k: {**v, "unit": unit} for k, v in inp["parts"].items()}
        return {"parts": parts, "extras": s.extras(ctx)}


PLAN: list[Stage] = [Specs()]


def key(stage: Stage, s: Subject, inp: dict[str, Any]) -> str:
    """What the stamp holds: the inputs' content (never their times), the stage's
    code, the attributes it reads, and the source of each subject method it calls."""
    parts = [json.dumps(inp, sort_keys=True), inspect.getsource(type(stage))]
    parts += [f"attr {a} {getattr(s, a)!r}" for a in stage.reads_attrs]
    for m in (*stage.calls, f"pre_{stage.name}", f"post_{stage.name}", f"post_{stage.item}"):
        if hasattr(s, m):
            parts.append(f"code {m} {inspect.getsource(getattr(s, m))}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def run_stage(ctx: Ctx, stage: Stage, s: Subject) -> None:
    out = ctx.out / s.name / f"{stage.name}.json"
    stamp = ctx.out / s.name / ".stamps" / f"{stage.name}.json"
    inp = stage.inputs(ctx, s)
    k = key(stage, s, inp)
    if out.exists() and stamp.exists() and json.loads(stamp.read_text())["key"] == k:
        return
    if pre := getattr(s, f"pre_{stage.name}", None):
        inp = pre(ctx, inp)
    res = stage.run(ctx, inp, s)
    if stage.item and (hook := getattr(s, f"post_{stage.item}", None)):
        lst = stage.item + "s"  # the output field holding the list of items
        res[lst] = {k2: hook(ctx, k2, v) for k2, v in res[lst].items()}
    if post := getattr(s, f"post_{stage.name}", None):
        res = post(ctx, res)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(res, indent=2, sort_keys=True) + "\n")
    # The run record: what made each output. `just rebuildable` calls a file
    # under the outputs root unowned when no record names it.
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(json.dumps({"key": k, "outs": [str(out.relative_to(ctx.out))]}) + "\n")


def main(name: str, inputs: str, out: str) -> None:
    ctx, s = Ctx(Path(inputs), Path(out)), SUBJECTS[name]()
    for stage in PLAN:
        run_stage(ctx, stage, s)


if __name__ == "__main__":
    main(*sys.argv[1:4])
