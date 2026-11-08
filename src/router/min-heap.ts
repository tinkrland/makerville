/**
 * Ported from tscircuit/single-layer-grid-router (lib/min-heap.ts), MIT,
 * Copyright (c) 2026 tscircuit. See NOTICE.md.
 */
export type HeapEntry = { id: number; score: number; cost: number }

/** Stable binary heap keeps A* deterministic when scores tie. */
export class MinHeap {
  private entries: HeapEntry[] = []
  get length() {
    return this.entries.length
  }
  push(entry: HeapEntry) {
    this.entries.push(entry)
    let i = this.entries.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.entries[parent]!.score <= entry.score) break
      this.entries[i] = this.entries[parent]!
      i = parent
    }
    this.entries[i] = entry
  }
  pop(): HeapEntry {
    const first = this.entries[0]!
    const last = this.entries.pop()!
    if (this.entries.length) {
      let i = 0
      while (i * 2 + 1 < this.entries.length) {
        let child = i * 2 + 1
        if (child + 1 < this.entries.length && this.entries[child + 1]!.score < this.entries[child]!.score) child++
        if (this.entries[child]!.score >= last.score) break
        this.entries[i] = this.entries[child]!
        i = child
      }
      this.entries[i] = last
    }
    return first
  }
}
