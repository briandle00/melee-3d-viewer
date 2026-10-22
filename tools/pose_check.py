#!/usr/bin/env python3
"""The pose check: every joint's world matrix, the simulator's against the viewer's, frame by frame, bit for bit.

    python tools/pose_check.py <folder> [--top N] [--pairs N]
    python tools/pose_check.py --self-test

The folder holds, per game, the simulator's viewer track made with MSL_VIEWER_TRACK_WORLD=1 (its "wf", "wi" and
"ws" lines: patch 0010 of docs/cloud-patches/round3) and the viewer's pose log of the same game (?poselog, or
__viewer3d.poseLog({ start: true }) then { take: true }: src/render3d/poselog.ts), named

    <game>.track.vtb    the compact form (VTB1, gzipped), or
    <game>.track.json   the track as JSON ({"events": [...]}), or
    <game>.track.jsonl  the simulator's own lines, one JSON array a line
    <game>.poselog.jsonl

A line's twelve values are rows 0 to 2 of the joint's 3 x 4 world matrix, row by row, each kept as its float32's
bits; mask bit k says value k follows, and a value holds until its next line; a joint with mask 0 is left out from
that frame on (the simulator no longer makes its matrix: a constraint put on it, as a held fighter's XRotN), until
a line has it again. The two are compared at every frame the viewer logged ("wn"), for every joint both sides have
of each owner the viewer drew that frame: the log has a line for each owner it drew (its head alone when nothing
changed), and none for one it did not (a fighter KO'd, off the screen, hidden), whose held values are its last
drawn pose, not this frame's. Those owner-frames are counted apart, by class.

It prints, per cause group (object class, joint, which values - the 3 x 3's scale (its columns' lengths) or turn
(their directions), the translation - and how the error goes over the frames it is wrong: constant, growing or
swinging), the joints, the first frame each goes wrong and the largest error, with raw pairs for the top groups;
then the joints only one side has. Standard library only.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import struct
import sys
from collections import defaultdict

KINDS = ("wf", "wi", "ws")


# ---------------------------------------------------------------- reading

def word(v) -> int:
    """a value as its float32's bits: a "0x" word, or a number (an exact float the compact form read back)"""
    if isinstance(v, str):
        return int(v, 16) & 0xFFFFFFFF
    return struct.unpack("<I", struct.pack("<f", float(v)))[0]


def as_float(w: int) -> float:
    return struct.unpack("<f", struct.pack("<I", w))[0]


class _Reader:
    def __init__(self, b: bytes):
        self.b, self.o = b, 0

    def byte(self) -> int:
        c = self.b[self.o]
        self.o += 1
        return c

    def varint(self) -> int:
        x, scale = 0, 1
        while True:
            c = self.byte()
            x += (c & 0x7F) * scale
            scale *= 128
            if c < 0x80:
                return x

    def zigzag(self) -> int:
        x = self.varint()
        return x // 2 if x % 2 == 0 else -(x + 1) // 2

    def text(self) -> str:
        n = self.varint()
        s = self.b[self.o:self.o + n].decode("utf-8")
        self.o += n
        return s


def _column(r: _Reader, n: int) -> list:
    """src/render3d/trackcodec.ts column(); exact floats (kind 4) kept as their words, as "0x" strings"""
    kind = r.byte()
    if kind in (0, 1):
        k = r.byte() if kind == 1 else 0
        last, out = 0, []
        for _ in range(n):
            last += r.zigzag()
            out.append(last / 10 ** k if k else last)
        return out
    if kind == 4:
        last, out = 0, []
        for _ in range(n):
            last += r.zigzag()
            out.append("0x%08x" % (last & 0xFFFFFFFF))
        return out
    table = [json.loads(t) if kind == 3 else t for t in (r.text() for _ in range(r.varint()))]
    return [table[r.varint()] for _ in range(n)]


def read_vtb1(b: bytes) -> list:
    """the events of a track's compact form (trackcodec.ts readTrack), in the track's order"""
    if b[:2] == b"\x1f\x8b":
        b = gzip.decompress(b)
    if b[:4] != b"VTB1":
        raise ValueError("not a VTB1 track")
    r = _Reader(b)
    r.o = 4
    r.text()  # (the track's own fields)
    names = [r.text() for _ in range(r.varint())]
    total = r.varint()
    order = [r.varint() for _ in range(total)]
    counts = [0] * len(names)
    for t in order:
        counts[t] += 1
    rows = []
    for t, name in enumerate(names):
        n = counts[t]
        same = r.byte() == 0
        lengths = [r.varint()] * n if same else [r.varint() for _ in range(n)]
        events, last = [], 0
        for _ in range(n):
            last += r.zigzag()
            events.append([last, name])
        for j in range(max(lengths, default=0)):
            have = [events[i] for i in range(n) if lengths[i] > j]
            for e, v in zip(have, _column(r, len(have))):
                e.append(v)
        rows.append(events)
    at = [0] * len(names)
    out = []
    for t in order:
        out.append(rows[t][at[t]])
        at[t] += 1
    return out


def read_events(path: str) -> list:
    with open(path, "rb") as f:
        b = f.read()
    if path.endswith(".vtb") or b[:2] == b"\x1f\x8b" or b[:4] == b"VTB1":
        return read_vtb1(b)
    text = b.decode("utf-8")
    if path.endswith(".json"):
        doc = json.loads(text)
        return doc["events"] if isinstance(doc, dict) else doc
    return [json.loads(line) for line in text.splitlines() if line.strip().startswith("[")]


# ---------------------------------------------------------------- the streams

def owner_of(e: list) -> tuple[tuple, int]:
    """a line's owner (kind and its numbers) and where its joints start"""
    if e[1] == "wf":
        return ("wf", e[2], e[3], e[4]), 5
    return (e[1], e[2]), 3


def joints_of(e: list, start: int):
    """(joint, {value index: word}) for each joint a line has"""
    i = start
    while i + 1 < len(e):
        joint, mask = int(e[i]), int(e[i + 1])
        i += 2
        vals = {}
        for k in range(12):
            if mask & (1 << k):
                vals[k] = word(e[i])
                i += 1
        yield joint, vals


class Stream:
    """one side's world matrices, played forward frame by frame"""

    def __init__(self, events: list):
        self.lines = sorted((e for e in events if len(e) > 1 and e[1] in KINDS), key=lambda e: e[0])
        self.at = 0
        self.state: dict[tuple, dict[int, list]] = defaultdict(dict)
        # (the owners with a line on the frame played to: in the viewer's log, the ones it drew that frame)
        self.drawn: set[tuple] = set()
        self.kinds = {e[2]: e[3] for e in events if len(e) > 3 and e[1] == "wk"}
        self.frames = sorted({e[0] for e in events if len(e) > 1 and e[1] == "wn"})

    def to(self, frame: int):
        self.drawn = set()
        while self.at < len(self.lines) and self.lines[self.at][0] <= frame:
            e = self.lines[self.at]
            self.at += 1
            owner, start = owner_of(e)
            if e[0] == frame:
                self.drawn.add(owner)
            have = self.state[owner]
            for joint, vals in joints_of(e, start):
                if not vals:
                    # (mask 0: the joint left out from this frame on - a constraint, IK, a cold part - until it
                    # is written whole again; its held values are no longer its pose)
                    have[joint] = [None] * 12
                    continue
                m = have.setdefault(joint, [None] * 12)
                for k, w in vals.items():
                    m[k] = w


# ---------------------------------------------------------------- comparing

def describe_owner(owner: tuple, kinds: dict) -> str:
    if owner[0] == "wf":
        return "fighter f%d (port %d%s)" % (owner[3], owner[1], " follower" if owner[2] else "")
    if owner[0] == "wi":
        kind = kinds.get(owner[1])
        return "item 0x%x" % kind if kind is not None else "item spawn %d" % owner[1]
    return "stage part %d" % owner[1]


def owner_class(owner: tuple, kinds: dict) -> str:
    if owner[0] == "wf":
        return "f%d" % owner[3]
    if owner[0] == "wi":
        kind = kinds.get(owner[1])
        return "item 0x%x" % kind if kind is not None else "item"
    return "stage part %d" % owner[1]


def what_differs(a: list, b: list) -> str:
    """which of the matrix's values differ: the translation, the 3 x 3's scale or its turn"""
    fa, fb = [as_float(w) for w in a], [as_float(w) for w in b]
    parts = []
    if any(a[r * 4 + 3] != b[r * 4 + 3] for r in range(3)):
        parts.append("translation")
    if any(a[r * 4 + c] != b[r * 4 + c] for r in range(3) for c in range(3)):
        la = [math.sqrt(sum(fa[r * 4 + c] ** 2 for r in range(3))) for c in range(3)]
        lb = [math.sqrt(sum(fb[r * 4 + c] ** 2 for r in range(3))) for c in range(3)]
        scale_off = any(abs(x - y) > 1e-6 * max(1.0, abs(x)) for x, y in zip(la, lb))
        dirs_off = False
        for c in range(3):
            if la[c] > 1e-12 and lb[c] > 1e-12:
                dot = sum(fa[r * 4 + c] * fb[r * 4 + c] for r in range(3)) / (la[c] * lb[c])
                if dot < 1 - 1e-9:
                    dirs_off = True
        if scale_off:
            parts.append("scale")
        if dirs_off or not scale_off:
            parts.append("turn")
    return "+".join(parts) or "none"


def size_of(a: list, b: list) -> float:
    return max(abs(as_float(x) - as_float(y)) for x, y in zip(a, b))


def trend(errs: list) -> str:
    """how the error goes over the frames it is wrong: constant, growing or swinging"""
    if len(errs) < 3:
        return "constant"
    lo, hi = min(errs), max(errs)
    if hi - lo <= 0.1 * hi:
        return "constant"
    n = len(errs)
    xs = range(n)
    mx, my = (n - 1) / 2, sum(errs) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, errs))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in errs)
    r = sxy / math.sqrt(sxx * syy) if sxx > 0 and syy > 0 else 0
    return "growing" if r > 0.8 else "swinging"


def compare_game(track_path: str, log_path: str) -> dict:
    sim, view = Stream(read_events(track_path)), Stream(read_events(log_path))
    joints: dict[tuple, dict] = {}
    only = {"simulator": set(), "viewer": set()}
    undrawn: dict[tuple, int] = defaultdict(int)
    compared = exact = 0
    for frame in view.frames:
        sim.to(frame)
        view.to(frame)
        for owner, vj in view.state.items():
            if owner not in view.drawn:
                if owner in sim.state:
                    undrawn[owner] += 1
                continue
            sj = sim.state.get(owner, {})
            for joint, vm in vj.items():
                sm = sj.get(joint)
                if sm is None or None in sm or None in vm:
                    only["viewer"].add((owner, joint))
                    continue
                compared += 1
                key = (owner, joint)
                if sm == vm:
                    exact += 1
                    continue
                j = joints.get(key)
                if j is None:
                    j = joints[key] = {"first": frame, "errs": [], "what": set(), "pair": (frame, sm[:], vm[:]),
                                       "worst": 0.0}
                err = size_of(sm, vm)
                j["errs"].append(err)
                j["what"].add(what_differs(sm, vm))
                if err > j["worst"]:
                    j["worst"], j["pair"] = err, (frame, sm[:], vm[:])
        for owner, sj in sim.state.items():
            for joint in sj:
                if joint not in view.state.get(owner, {}):
                    only["simulator"].add((owner, joint))
    return {"joints": joints, "only": only, "compared": compared, "exact": exact, "undrawn": undrawn,
            "kinds": {**sim.kinds, **view.kinds}}


def fmt_matrix(m: list) -> str:
    f = [as_float(w) for w in m]
    return "[" + ", ".join("[" + ", ".join("%.6g" % f[r * 4 + c] for c in range(4)) + "]" for r in range(3)) + "]"


def find_games(folder: str) -> list[tuple[str, str, str]]:
    names = os.listdir(folder)
    out = []
    for n in sorted(names):
        if not n.endswith(".poselog.jsonl"):
            continue
        game = n[: -len(".poselog.jsonl")]
        track = next((os.path.join(folder, game + ext) for ext in (".track.vtb", ".track.json", ".track.jsonl")
                      if game + ext in names), None)
        if track:
            out.append((game, track, os.path.join(folder, n)))
        else:
            print("(no track for %s)" % game, file=sys.stderr)
    return out


def report(folder: str, top: int, pairs: int) -> int:
    games = find_games(folder)
    if not games:
        print("no <game>.poselog.jsonl with a <game>.track.(vtb|json|jsonl) in %s" % folder)
        return 1
    groups: dict[tuple, list] = defaultdict(list)
    compared = exact = 0
    only_counts = {"simulator": defaultdict(int), "viewer": defaultdict(int)}
    undrawn: dict[str, int] = defaultdict(int)
    for game, track, log in games:
        r = compare_game(track, log)
        for owner, n in r["undrawn"].items():
            undrawn[owner_class(owner, r["kinds"])] += n
        compared += r["compared"]
        exact += r["exact"]
        for (owner, joint), j in r["joints"].items():
            cls = owner_class(owner, r["kinds"])
            key = (cls, joint, "/".join(sorted(j["what"])), trend(j["errs"]))
            groups[key].append((game, describe_owner(owner, r["kinds"]), j))
        for side in ("simulator", "viewer"):
            for owner, joint in r["only"][side]:
                only_counts[side][owner_class(owner, r["kinds"])] += 1
    pct = 100.0 * exact / compared if compared else 100.0
    print("pose check: %d games, %d joint-frames compared, %d bit-exact (%.3f%%), %d joints wrong in %d groups"
          % (len(games), compared, exact, pct, sum(len(v) for v in groups.values()), len(groups)))
    ranked = sorted(groups.items(), key=lambda kv: (-sum(len(j["errs"]) for _, _, j in kv[1]),
                                                     -max(j["worst"] for _, _, j in kv[1])))
    for i, ((cls, joint, what, how), items) in enumerate(ranked[:top]):
        frames = sum(len(j["errs"]) for _, _, j in items)
        worst = max(j["worst"] for _, _, j in items)
        first = min(items, key=lambda t: (t[0], t[2]["first"]))
        print("\n%d. %s joint %d: %s, %s - %d joint(s), %d frames wrong, worst %.4g; first: %s %s frame %d"
              % (i + 1, cls, joint, what, how, len(items), frames, worst, first[0], first[1], first[2]["first"]))
        if i < pairs:
            for game, who, j in sorted(items, key=lambda t: -t[2]["worst"])[:2]:
                frame, sm, vm = j["pair"]
                print("   %s, %s, frame %d:\n     game %s\n     ours %s" % (game, who, frame, fmt_matrix(sm),
                                                                          fmt_matrix(vm)))
    if len(ranked) > top:
        print("\n(%d more groups)" % (len(ranked) - top))
    for side in ("simulator", "viewer"):
        if only_counts[side]:
            print("\nonly the %s has (joint-frames by class): %s" % (
                side, ", ".join("%s %d" % kv for kv in sorted(only_counts[side].items(), key=lambda kv: -kv[1]))))
    if undrawn:
        print("\nnot compared, the simulator's on a frame the viewer did not draw them (owner-frames by class): %s" % (
            ", ".join("%s %d" % kv for kv in sorted(undrawn.items(), key=lambda kv: -kv[1]))))
    return 0


# ---------------------------------------------------------------- self-test

def self_test() -> int:
    import tempfile

    one = "0x3f800000"
    ident = [one, "0x00000000", "0x00000000", "0x00000000", "0x00000000", one, "0x00000000", "0x00000000",
             "0x00000000", "0x00000000", one, "0x00000000"]
    moved = ident[:]
    moved[3] = "0x40000000"  # (translation x 2 instead of 0)
    sim = [[0, "wf", 1, 0, 2, 0, 4095, *ident, 3, 4095, *ident],
           [5, "wf", 1, 0, 2, 3, 1 << 3, moved[3]],
           [7, "wf", 1, 0, 2, 0, 1 << 3, moved[3]],
           [8, "wf", 1, 0, 2, 0, 1 << 3, ident[3], 3, 0]]
    # (frame 7: the viewer did not draw it - no line - so its held pose is not this frame's and is not compared)
    view = [[0, "wn"], [0, "wf", 1, 0, 2, 0, 4095, *ident, 3, 4095, *ident],
            [5, "wn"], [5, "wf", 1, 0, 2],
            [6, "wn"], [6, "wf", 1, 0, 2],
            [7, "wn"],
            [8, "wn"], [8, "wf", 1, 0, 2]]
    # (frame 8: joint 3 left out by the simulator - mask 0 - so not compared, joint 0 is)
    with tempfile.TemporaryDirectory() as d:
        with open(os.path.join(d, "g.track.jsonl"), "w") as f:
            f.write("\n".join(json.dumps(e) for e in sim))
        with open(os.path.join(d, "g.poselog.jsonl"), "w") as f:
            f.write("\n".join(json.dumps(e) for e in view))
        r = compare_game(os.path.join(d, "g.track.jsonl"), os.path.join(d, "g.poselog.jsonl"))
    joints = r["joints"]
    assert list(joints) == [(("wf", 1, 0, 2), 3)], joints
    j = joints[(("wf", 1, 0, 2), 3)]
    assert j["first"] == 5 and j["what"] == {"translation"} and trend(j["errs"]) == "constant", j
    assert r["compared"] == 7 and r["exact"] == 5, r
    assert (("wf", 1, 0, 2), 3) in r["only"]["viewer"], r["only"]
    assert dict(r["undrawn"]) == {("wf", 1, 0, 2): 1}, r["undrawn"]
    # (the compact form: one exact-float column read back as its words)
    w = _Reader(bytes([4 * 2]))
    assert w.zigzag() == 4
    print("self-test passed")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__)
        return 2

    def opt(name: str, default: int) -> int:
        for a in argv:
            if a.startswith(name + "="):
                return int(a.split("=", 1)[1])
        return default

    return report(args[0], opt("--top", 40), opt("--pairs", 10))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
