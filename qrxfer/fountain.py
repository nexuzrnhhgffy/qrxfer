"""Luby Transform fountain codec with an integer-only PRNG.

The encoder and decoder MUST match the JavaScript port in pwa/js/protocol.js.
No floating-point math is used in neighbor selection so Python and JS
produce identical block subsets for a given (session_id, seq, k).
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Sequence, Set


def isqrt(n: int) -> int:
    if n < 2:
        return n
    x = n
    y = (x + 1) // 2
    while y < x:
        x = y
        y = (x + n // x) // 2
    return x


class XorShift32:
    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF
        if self.state == 0:
            self.state = 0xA3C59AC3

    def next_u32(self) -> int:
        x = self.state
        x ^= (x << 13) & 0xFFFFFFFF
        x ^= (x >> 17) & 0xFFFFFFFF
        x ^= (x << 5) & 0xFFFFFFFF
        self.state = x & 0xFFFFFFFF
        return self.state

    def next_bounded(self, n: int) -> int:
        if n <= 1:
            return 0
        return self.next_u32() % n


def mix32(session_id: int, seq: int) -> int:
    x = (session_id + 0x9E3779B9) & 0xFFFFFFFF
    x ^= (seq * 0x85EBCA77) & 0xFFFFFFFF
    x ^= (x >> 16) & 0xFFFFFFFF
    x = (x * 0x7FEB352D) & 0xFFFFFFFF
    x ^= (x >> 15) & 0xFFFFFFFF
    if x == 0:
        x = 0xA511E9B3
    return x


def sample_degree(rng: XorShift32, k: int) -> int:
    """Integer mix of ideal soliton + extra degree-1 + sqrt(k) spike."""
    if k <= 1:
        return 1
    extra = rng.next_u32() % 1000
    if extra < 120:
        return 1
    if extra < 160:
        spike = isqrt(k)
        if spike < 2:
            return 2
        return spike if spike <= k else k
    u = rng.next_u32()
    if u < (0xFFFFFFFF // k):
        return 1
    if u == 0:
        u = 1
    d = 0xFFFFFFFF // u
    if d < 2:
        d = 2
    if d > k:
        d = k
    return d


def neighbors(session_id: int, seq: int, k: int) -> List[int]:
    """Return sorted source-block indices XOR-ed into this encoding symbol."""
    if k <= 0:
        raise ValueError("k must be positive")
    if seq < k:
        return [seq]
    rng = XorShift32(mix32(session_id, seq))
    degree = sample_degree(rng, k)
    if degree >= k:
        return list(range(k))
    picked: List[int] = []
    seen: Set[int] = set()
    guard = 0
    limit = degree * 16 + 8
    while len(picked) < degree and guard < limit:
        guard += 1
        i = rng.next_bounded(k)
        if i not in seen:
            seen.add(i)
            picked.append(i)
    if not picked:
        picked = [seq % k]
    picked.sort()
    return picked


def xor_inplace(dst: bytearray, src: Sequence[int]) -> None:
    for i, b in enumerate(src):
        dst[i] ^= b


def xor_bytes(parts: Iterable[bytes]) -> bytes:
    iterator = iter(parts)
    acc = bytearray(next(iterator))
    for part in iterator:
        xor_inplace(acc, part)
    return bytes(acc)


class LTEncoder:
    def __init__(self, source: bytes, block_size: int, session_id: int):
        if block_size < 1:
            raise ValueError("block_size must be positive")
        self.block_size = block_size
        self.session_id = session_id & 0xFFFFFFFF
        self.total_len = len(source)
        padded_len = ((len(source) + block_size - 1) // block_size) * block_size
        if padded_len == 0:
            padded_len = block_size
        padded = source + bytes(padded_len - len(source))
        self.k = padded_len // block_size
        self.blocks = [
            padded[i * block_size : (i + 1) * block_size] for i in range(self.k)
        ]

    def symbol(self, seq: int) -> bytes:
        idxs = neighbors(self.session_id, seq, self.k)
        acc = bytearray(self.blocks[idxs[0]])
        for i in idxs[1:]:
            xor_inplace(acc, self.blocks[i])
        return bytes(acc)


class LTDecoder:
    def __init__(self):
        self.session_id: Optional[int] = None
        self.k: Optional[int] = None
        self.block_size: Optional[int] = None
        self.total_len: Optional[int] = None
        self.recovered: List[Optional[bytes]] = []
        self.recovered_count = 0
        self.pending: List[tuple] = []
        self.seen: Set[int] = set()
        self.packets_accepted = 0

    @property
    def ready(self) -> bool:
        return self.k is not None and self.recovered_count >= self.k

    @property
    def progress(self) -> float:
        if not self.k:
            return 0.0
        return min(1.0, self.recovered_count / self.k)

    def add(
        self,
        session_id: int,
        seq: int,
        k: int,
        block_size: int,
        total_len: int,
        payload: bytes,
    ) -> bool:
        if self.k is None:
            self.session_id = session_id
            self.k = k
            self.block_size = block_size
            self.total_len = total_len
            self.recovered = [None] * k
        elif (
            session_id != self.session_id
            or k != self.k
            or block_size != self.block_size
            or total_len != self.total_len
        ):
            return False
        if seq in self.seen:
            return False
        if len(payload) != self.block_size:
            return False
        self.seen.add(seq)
        self.packets_accepted += 1
        idxs = neighbors(session_id, seq, k)
        data = bytearray(payload)
        unknown = []
        for i in idxs:
            if self.recovered[i] is not None:
                xor_inplace(data, self.recovered[i])
            else:
                unknown.append(i)
        if not unknown:
            return True
        if len(unknown) == 1:
            self._set_block(unknown[0], bytes(data))
            self._peel()
        else:
            self.pending.append((unknown, data))
        if self.recovered_count < self.k and self.packets_accepted % 8 == 0:
            self._gaussian()
        return True

    def finish(self) -> bool:
        if self.k is None:
            return False
        self._peel()
        if self.recovered_count < self.k:
            self._gaussian()
        return self.ready

    def assemble(self) -> bytes:
        if not self.finish():
            missing = [i for i, b in enumerate(self.recovered) if b is None]
            raise ValueError(f"Incomplete fountain decode, missing {len(missing)} blocks")
        blob = b"".join(self.recovered)  # type: ignore[arg-type]
        return blob[: self.total_len]

    def _set_block(self, index: int, data: bytes) -> None:
        if self.recovered[index] is None:
            self.recovered[index] = data
            self.recovered_count += 1

    def _peel(self) -> None:
        changed = True
        while changed:
            changed = False
            still = []
            for idxs, data in self.pending:
                unknown = []
                reduced = bytearray(data)
                for i in idxs:
                    if self.recovered[i] is not None:
                        xor_inplace(reduced, self.recovered[i])
                    else:
                        unknown.append(i)
                if len(unknown) == 1:
                    self._set_block(unknown[0], bytes(reduced))
                    changed = True
                elif len(unknown) > 1:
                    still.append((unknown, reduced))
            self.pending = still

    def _gaussian(self) -> None:
        """Solve leftover equations over GF(2) when peeling stalls."""
        self._peel()
        if self.k is None or self.recovered_count >= self.k or not self.pending:
            return
        eqs = []
        for idxs, data in self.pending:
            unknown = []
            reduced = bytearray(data)
            for i in idxs:
                if self.recovered[i] is not None:
                    xor_inplace(reduced, self.recovered[i])
                else:
                    unknown.append(i)
            if unknown:
                eqs.append((unknown, reduced))
        if not eqs:
            self.pending = []
            return
        unknowns = sorted({i for u, _ in eqs for i in u})
        col_of = {idx: c for c, idx in enumerate(unknowns)}
        n = len(unknowns)
        width = (n + 31) // 32
        rows_bits = []
        rows_data = []
        for u, d in eqs:
            bits = [0] * width
            for i in u:
                c = col_of[i]
                bits[c >> 5] |= 1 << (c & 31)
            rows_bits.append(bits)
            rows_data.append(bytearray(d))
        m = len(rows_bits)
        row = 0
        for col in range(n):
            pivot = None
            for r in range(row, m):
                if (rows_bits[r][col >> 5] >> (col & 31)) & 1:
                    pivot = r
                    break
            if pivot is None:
                continue
            rows_bits[row], rows_bits[pivot] = rows_bits[pivot], rows_bits[row]
            rows_data[row], rows_data[pivot] = rows_data[pivot], rows_data[row]
            for r in range(m):
                if r != row and ((rows_bits[r][col >> 5] >> (col & 31)) & 1):
                    for w in range(width):
                        rows_bits[r][w] ^= rows_bits[row][w]
                    xor_inplace(rows_data[r], rows_data[row])
            row += 1
            if row >= m:
                break
        recovered_any = False
        still = []
        for r in range(m):
            ones = []
            for c in range(n):
                if (rows_bits[r][c >> 5] >> (c & 31)) & 1:
                    ones.append(c)
            if len(ones) == 1:
                idx = unknowns[ones[0]]
                if self.recovered[idx] is None:
                    self._set_block(idx, bytes(rows_data[r]))
                    recovered_any = True
            elif len(ones) > 1:
                still.append(([unknowns[c] for c in ones], rows_data[r]))
        self.pending = still
        if recovered_any:
            self._peel()
