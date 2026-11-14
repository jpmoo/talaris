// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Jeff Moore

/**
 * Three-way merge of a page's words, line by line (docs/SYNC.md, *Page text*):
 * the text both machines last had (`base`), and each machine's since. Lines one
 * side changed and the other did not take that side's change; where both
 * changed the same lines differently, the merge says it could not (`clean:
 * false`) and the caller keeps one whole and the other in the page's versions.
 */

export interface Merged { text: string; clean: boolean }

/** The longest common subsequence of two line lists, as matched index pairs. */
function matches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++; else j++;
  }
  return out;
}

/** For each base line, the line it is in `other`, if it stayed the same there. */
function stable(base: string[], other: string[]): Int32Array {
  const map = new Int32Array(base.length).fill(-1);
  for (const [i, j] of matches(base, other)) map[i] = j;
  return map;
}

/** Too long to merge line by line in reasonable time: the caller keeps one. */
const MAX_LINES = 3000;

export function merge3(base: string, ours: string, theirs: string): Merged {
  if (ours === theirs) return { text: ours, clean: true };
  if (base === ours) return { text: theirs, clean: true };
  if (base === theirs) return { text: ours, clean: true };
  const B = base.split("\n"), O = ours.split("\n"), T = theirs.split("\n");
  if (B.length > MAX_LINES || O.length > MAX_LINES || T.length > MAX_LINES) return { text: ours, clean: false };
  const inO = stable(B, O), inT = stable(B, T);
  const out: string[] = [];
  let clean = true;
  let b = 0, o = 0, t = 0;
  // Walk the base lines both sides kept unchanged: between two of them is a stretch each side may have changed.
  const anchors: number[] = [];
  for (let i = 0; i < B.length; i++) if (inO[i]! >= 0 && inT[i]! >= 0) anchors.push(i);
  anchors.push(B.length);
  for (const a of anchors) {
    const oEnd = a < B.length ? inO[a]! : O.length;
    const tEnd = a < B.length ? inT[a]! : T.length;
    const baseChunk = B.slice(b, a), oChunk = O.slice(o, oEnd), tChunk = T.slice(t, tEnd);
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, k) => l === y[k]);
    if (same(oChunk, tChunk)) out.push(...oChunk);
    else if (same(baseChunk, oChunk)) out.push(...tChunk);
    else if (same(baseChunk, tChunk)) out.push(...oChunk);
    else { clean = false; out.push(...oChunk); }
    if (a < B.length) out.push(B[a]!);
    b = a + 1; o = oEnd + 1; t = tEnd + 1;
  }
  return { text: out.join("\n"), clean };
}
