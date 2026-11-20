/**
 * Go's own function table (`pclntab`), read from the file. Release Go binaries
 * strip their symbol table, and Ghidra 12.1.4 names almost none of their
 * functions (FUN_<address>), but the runtime's table keeps every name with
 * its source file and line. A port of the Go 1.18+ part of Go's
 * `debug/gosym`; checked against it on real binaries (gosym.live.test.ts).
 *
 * Names found here are a lookup in the file, not REA evidence: callers check
 * the entry against Ghidra's function and confirm the name's bytes with REA.
 */
import { readFileSync } from "node:fs";

export interface GoFunc {
  /** Entry address. */
  entry: number;
  /** End address (the next function's entry). */
  end: number;
  name: string;
  /** Virtual address of the NUL-terminated name inside the table. */
  nameAddress: number;
}

export interface GoFuncAt extends GoFunc {
  file?: string;
  line?: number;
}

interface Section {
  addr: number;
  offset: number;
  size: number;
}

const GO118_MAGIC = 0xfffffff0;
const PSEUDO = new Set(["runtime.text", "go:buildid"]);
const GO120_MAGIC = 0xfffffff1;

/** Finds a section by name in a 64-bit little-endian Mach-O or ELF file. */
export function findSection(file: Buffer, name: string): Section | undefined {
  if (file.length >= 32 && file.readUInt32LE(0) === 0xfeedfacf) {
    const ncmds = file.readUInt32LE(16);
    let at = 32;
    for (let i = 0; i < ncmds && at + 8 <= file.length; i++) {
      const cmd = file.readUInt32LE(at);
      const size = file.readUInt32LE(at + 4);
      if (cmd === 0x19) {
        const nsects = file.readUInt32LE(at + 64);
        for (let s = 0; s < nsects; s++) {
          const sect = at + 72 + s * 80;
          if (cString(file, sect, 16) === name) {
            return {
              addr: Number(file.readBigUInt64LE(sect + 32)),
              size: Number(file.readBigUInt64LE(sect + 40)),
              offset: file.readUInt32LE(sect + 48),
            };
          }
        }
      }
      at += size;
    }
    return undefined;
  }
  if (file.length >= 64 && file.readUInt32BE(0) === 0x7f454c46 && file[4] === 2 && file[5] === 1) {
    const shoff = Number(file.readBigUInt64LE(0x28));
    const shentsize = file.readUInt16LE(0x3a);
    const shnum = file.readUInt16LE(0x3c);
    const shstrndx = file.readUInt16LE(0x3e);
    const header = (i: number) => shoff + i * shentsize;
    const strtab = Number(file.readBigUInt64LE(header(shstrndx) + 0x18));
    for (let i = 0; i < shnum; i++) {
      const h = header(i);
      if (cString(file, strtab + file.readUInt32LE(h), 64) === name) {
        return {
          addr: Number(file.readBigUInt64LE(h + 0x10)),
          offset: Number(file.readBigUInt64LE(h + 0x18)),
          size: Number(file.readBigUInt64LE(h + 0x20)),
        };
      }
    }
  }
  return undefined;
}

function cString(
  buf: Buffer,
  at: number,
  max: number,
  encoding: BufferEncoding = "latin1",
): string {
  const end = buf.indexOf(0, at);
  return buf.toString(
    encoding,
    at,
    end === -1 ? Math.min(buf.length, at + max) : Math.min(end, at + max),
  );
}

/** A Go binary's function table, or undefined when it has none Binlight can read. */
export class GoFuncTable {
  private constructor(
    private readonly tab: Buffer,
    private readonly tabAddr: number,
    private readonly textStart: number,
    private readonly quantum: number,
    readonly count: number,
    private readonly funcnametab: number,
    private readonly cutab: number,
    private readonly filetab: number,
    private readonly pctab: number,
    private readonly functab: number,
  ) {}

  static fromFile(path: string): GoFuncTable | undefined {
    return GoFuncTable.fromBuffer(readFileSync(path));
  }

  static fromBuffer(file: Buffer): GoFuncTable | undefined {
    const pcln = findSection(file, "__gopclntab") ?? findSection(file, ".gopclntab");
    const text = findSection(file, "__text") ?? findSection(file, ".text");
    if (!pcln || !text) return undefined;
    const tab = file.subarray(pcln.offset, pcln.offset + pcln.size);
    if (tab.length < 16) return undefined;
    const magic = tab.readUInt32LE(0);
    if ((magic !== GO118_MAGIC && magic !== GO120_MAGIC) || tab[4] !== 0 || tab[5] !== 0) {
      return undefined; // Go before 1.18, or big-endian: not supported.
    }
    const quantum = tab[6] as number;
    const ptrsize = tab[7] as number;
    if (ptrsize !== 8 || ![1, 2, 4].includes(quantum)) return undefined;
    const word = (i: number) => Number(tab.readBigUInt64LE(8 + i * ptrsize));
    // As Go's debug/gosym does for 1.18+: the text section start, not the
    // header's (possibly unrelocated) textStart.
    return new GoFuncTable(
      tab,
      pcln.addr,
      text.addr,
      quantum,
      word(0),
      word(3),
      word(4),
      word(5),
      word(6),
      word(7),
    );
  }

  private pc(i: number): number {
    return this.textStart + this.tab.readUInt32LE(this.functab + i * 8);
  }

  private funcOff(i: number): number {
    return this.tab.readUInt32LE(this.functab + i * 8 + 4);
  }

  /** Field n (1-based) of the _func struct for function i (Go 1.18+ layout). */
  private field(i: number, n: number): number {
    return this.tab.readUInt32LE(this.functab + this.funcOff(i) + 4 + (n - 1) * 4);
  }

  private func(i: number): GoFunc {
    const nameOff = this.field(i, 1);
    const at = this.funcnametab + nameOff;
    return {
      entry: this.pc(i),
      end: this.pc(i + 1),
      name: cString(this.tab, at, 4096, "utf8"),
      nameAddress: this.tabAddr + at,
    };
  }

  /** Every function, in address order. */
  *funcs(): Generator<GoFunc> {
    for (let i = 0; i < this.count; i++) yield this.func(i);
  }

  /** The function containing an address, with its source file and line. */
  at(address: number): GoFuncAt | undefined {
    if (this.count === 0 || address < this.pc(0) || address >= this.pc(this.count))
      return undefined;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pc(mid) <= address) lo = mid;
      else hi = mid - 1;
    }
    const f = this.func(lo);
    // Linker markers, not code: their line tables are not meaningful.
    if (PSEUDO.has(f.name)) return f;
    // Like Go's debug/gosym, a malformed entry (e.g. runtime.text) has no file or line.
    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };
    const line = safe(() => this.pcvalue(this.field(lo, 6), f.entry, address), -1);
    const file = safe(() => {
      const fileNo = this.pcvalue(this.field(lo, 5), f.entry, address);
      if (fileNo < 0) return undefined;
      const fnoff = this.tab.readUInt32LE(this.cutab + (this.field(lo, 8) + fileNo) * 4);
      return fnoff === 0xffffffff
        ? undefined
        : cString(this.tab, this.filetab + fnoff, 4096, "utf8");
    }, undefined);
    return { ...f, ...(file && { file }), ...(line >= 0 && { line }) };
  }

  private pcvalue(off: number, entry: number, target: number): number {
    let p = this.pctab + off;
    let pc = entry;
    let val = -1;
    const varint = () => {
      let v = 0;
      let shift = 0;
      for (;;) {
        const b = this.tab[p++] as number;
        v += (b & 0x7f) * 2 ** shift;
        if ((b & 0x80) === 0) return v;
        shift += 7;
      }
    };
    for (let first = true; ; first = false) {
      const uv = varint();
      if (uv === 0 && !first) return -1;
      const delta = uv % 2 === 1 ? -Math.floor(uv / 2) - 1 : uv / 2;
      pc += varint() * this.quantum;
      val += delta;
      if (target < pc) return val;
    }
  }
}
