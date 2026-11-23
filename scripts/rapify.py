"""Reader for Bohemia's binarised config format (config.bin, "raP").

    root = parse(data)          # nested dicts; arrays become lists
    root["CfgWorlds"]["ChernarusPlus"]["Names"]

Layout: "\\0raP", uint32 0, uint32 8, uint32 enum offset, then the root class body.
A class body is an asciiz parent name, a varint entry count and entries; class entries
point to their bodies by absolute offset.
"""

from __future__ import annotations

import struct


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def byte(self) -> int:
        b = self.data[self.pos]
        self.pos += 1
        return b

    def u32(self) -> int:
        (v,) = struct.unpack_from("<I", self.data, self.pos)
        self.pos += 4
        return v

    def i32(self) -> int:
        (v,) = struct.unpack_from("<i", self.data, self.pos)
        self.pos += 4
        return v

    def f32(self) -> float:
        (v,) = struct.unpack_from("<f", self.data, self.pos)
        self.pos += 4
        return v

    def asciiz(self) -> str:
        end = self.data.index(b"\0", self.pos)
        s = self.data[self.pos:end].decode("utf-8", "replace")
        self.pos = end + 1
        return s

    def varint(self) -> int:
        value = shift = 0
        while True:
            b = self.byte()
            value |= (b & 0x7F) << shift
            if not b & 0x80:
                return value
            shift += 7


def _array(r: _Reader) -> list:
    out = []
    for _ in range(r.varint()):
        kind = r.byte()
        if kind == 0:
            out.append(r.asciiz())
        elif kind == 1:
            out.append(r.f32())
        elif kind == 2:
            out.append(r.i32())
        elif kind == 3:
            out.append(_array(r))
        elif kind == 4:  # variable reference
            out.append(r.asciiz())
        else:
            raise ValueError(f"unknown array element type {kind} at {r.pos}")
    return out


def _class(r: _Reader, offset: int) -> dict:
    saved, r.pos = r.pos, offset
    body: dict = {"__parent__": r.asciiz()}
    for _ in range(r.varint()):
        kind = r.byte()
        if kind == 0:  # class
            name = r.asciiz()
            body[name] = _class(r, r.u32())
        elif kind == 1:  # value
            sub = r.byte()
            name = r.asciiz()
            body[name] = r.asciiz() if sub == 0 else r.f32() if sub == 1 else r.i32() if sub == 2 else r.asciiz()
        elif kind == 2:  # array
            name = r.asciiz()
            body[name] = _array(r)
        elif kind in (3, 4):  # extern / delete class
            body[r.asciiz()] = None
        elif kind == 5:  # array append (+=)
            r.u32()
            name = r.asciiz()
            body[name] = _array(r)
        else:
            raise ValueError(f"unknown entry type {kind} at {r.pos}")
    r.pos = saved
    return body


def parse(data: bytes) -> dict:
    if data[:4] != b"\0raP":
        raise ValueError("not a binarised config (missing raP signature)")
    r = _Reader(data)
    return _class(r, 16)


def find_ci(d: dict, key: str):
    """Case-insensitive lookup (config class names are case-insensitive)."""
    for k, v in d.items():
        if k.lower() == key.lower():
            return v
    return None
