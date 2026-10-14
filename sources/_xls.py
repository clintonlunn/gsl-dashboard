"""Minimal stdlib reader for legacy Excel .xls (OLE2 compound file, BIFF8): cell values only."""
import struct


def ole_stream(data, want="Workbook"):
    if data[:8] != b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
        raise ValueError("not an OLE2 compound file")
    ssz = 1 << struct.unpack_from("<H", data, 30)[0]
    n_fat, dir_start = struct.unpack_from("<I", data, 44)[0], struct.unpack_from("<i", data, 48)[0]
    mini_cut, mini_fat_start = struct.unpack_from("<I", data, 56)[0], struct.unpack_from("<i", data, 60)[0]
    difat_start, n_difat = struct.unpack_from("<iI", data, 68)
    sec = lambda i: data[512 + i * ssz: 512 + (i + 1) * ssz]
    difat = list(struct.unpack_from("<109i", data, 76))
    s = difat_start
    for _ in range(n_difat):
        if s < 0:
            break
        blk = struct.unpack(f"<{ssz // 4}i", sec(s))
        difat += blk[:-1]
        s = blk[-1]
    fat = []
    for i in difat[:n_fat]:
        fat += struct.unpack(f"<{ssz // 4}i", sec(i))

    def chain(start):
        out, s, guard = [], start, 0
        while s >= 0 and guard < len(fat) + 1:
            out.append(sec(s)); s = fat[s]; guard += 1
        return b"".join(out)

    d = chain(dir_start)
    entries = []
    for off in range(0, len(d), 128):
        e = d[off:off + 128]
        nl = struct.unpack_from("<H", e, 64)[0]
        name = e[:max(nl - 2, 0)].decode("utf-16-le")
        start, size = struct.unpack_from("<iI", e, 116)
        entries.append((name, e[66], start, size))
    for name, typ, start, size in entries:
        if name in (want, "Book") and typ == 2:
            if size >= mini_cut:
                return chain(start)[:size]
            root = entries[0]
            mini = chain(root[2])
            mfat = struct.unpack(f"<{len(chain(mini_fat_start)) // 4}i", chain(mini_fat_start))
            out, s = [], start
            while s >= 0:
                out.append(mini[s * 64:(s + 1) * 64]); s = mfat[s]
            return b"".join(out)[:size]
    raise ValueError("no Workbook stream")


def records(wb):
    i = 0
    while i + 4 <= len(wb):
        t, n = struct.unpack_from("<HH", wb, i)
        yield i, t, wb[i + 4:i + 4 + n]
        i += 4 + n


def rk(v):
    x = struct.unpack("<d", struct.pack("<Q", (v & 0xFFFFFFFC) << 32))[0] if not v & 2 else float(struct.unpack("<i", struct.pack("<I", v))[0] >> 2)
    return x / 100 if v & 1 else x


class _Chunks:
    """Walks string data that may continue across CONTINUE records (each restarts the char flags)."""
    def __init__(self, chunks):
        self.c, self.k, self.p = chunks, 0, 0

    def take(self, n):
        out = b""
        while n:
            if self.p >= len(self.c[self.k]):
                self.k += 1; self.p = 0
            m = min(n, len(self.c[self.k]) - self.p)
            out += self.c[self.k][self.p:self.p + m]; self.p += m; n -= m
        return out

    def string(self):
        cch, flags = struct.unpack("<HB", self.take(3))
        runs = struct.unpack("<H", self.take(2))[0] if flags & 8 else 0
        ext = struct.unpack("<I", self.take(4))[0] if flags & 4 else 0
        wide, parts = flags & 1, []
        while cch:
            if self.p >= len(self.c[self.k]):
                self.k += 1; self.p = 0
                wide = self.take(1)[0] & 1
            avail = (len(self.c[self.k]) - self.p) // (2 if wide else 1)
            m = min(cch, avail)
            raw = self.take(m * (2 if wide else 1))
            parts.append(raw.decode("utf-16-le") if wide else raw.decode("latin-1"))
            cch -= m
        self.take(runs * 4 + ext)
        return "".join(parts)


def _ustr(b, off, lenbytes=2):
    cch = b[off] if lenbytes == 1 else struct.unpack_from("<H", b, off)[0]
    off += lenbytes
    flags = b[off]; off += 1
    if flags & 8: off += 2
    if flags & 4: off += 4
    return b[off:off + cch * 2].decode("utf-16-le") if flags & 1 else b[off:off + cch].decode("latin-1")


def read_xls(data):
    """Return {sheet name: {(row, col): value}} with str or float values."""
    wb = ole_stream(data)
    recs = list(records(wb))
    sheets, sst = [], []
    for j, (off, t, b) in enumerate(recs):
        if t == 0x0085:
            sheets.append((struct.unpack_from("<I", b, 0)[0], _ustr(b, 6, 1)))
        elif t == 0x00FC:
            chunks, k = [b[8:]], j + 1
            while k < len(recs) and recs[k][1] == 0x003C:
                chunks.append(recs[k][2]); k += 1
            ch, n = _Chunks(chunks), struct.unpack_from("<I", b, 4)[0]
            sst = [ch.string() for _ in range(n)]
        elif t == 0x000A:
            break  # end of workbook globals
    by_off = {off: j for j, (off, _, _) in enumerate(recs)}
    out = {}
    for start, name in sheets:
        cells, j, pending = {}, by_off[start] + 1, None
        while j < len(recs) and recs[j][1] != 0x000A:
            _, t, b = recs[j]
            if t in (0x00FD, 0x0203, 0x027E, 0x0204, 0x0006, 0x00BD):
                r, c = struct.unpack_from("<HH", b, 0)
            if t == 0x00FD:
                cells[(r, c)] = sst[struct.unpack_from("<I", b, 6)[0]]
            elif t == 0x0203:
                cells[(r, c)] = struct.unpack_from("<d", b, 6)[0]
            elif t == 0x027E:
                cells[(r, c)] = rk(struct.unpack_from("<I", b, 6)[0])
            elif t == 0x0204:
                cells[(r, c)] = _ustr(b, 6)
            elif t == 0x00BD:
                last = struct.unpack_from("<H", b, len(b) - 2)[0]
                for i, cc in enumerate(range(c, last + 1)):
                    cells[(r, cc)] = rk(struct.unpack_from("<I", b, 4 + i * 6 + 2)[0])
            elif t == 0x0006:
                res = b[6:14]
                if res[6:8] != b"\xff\xff":
                    cells[(r, c)] = struct.unpack("<d", res)[0]
                elif res[0] == 0:
                    pending = (r, c)
            elif t == 0x0207 and pending:
                cells[pending] = _ustr(b, 0); pending = None
            j += 1
        out[name] = cells
    return out
