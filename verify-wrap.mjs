import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/braille.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
writeFileSync('/tmp/braille.mjs', result.outputFiles[0].text);

const {
  transcribeLine,
  wrapTokens,
  wrapSignature,
  analyzeProject,
  segmentBraille,
  tokenWidth,
  CONTINUATION_MARK,
} = await import('file:///tmp/braille.mjs');

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('').map((l, i) => ({
  id: `letter-${l}`, source: l,
  output: '⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵'[i],
  kind: 'letter', enabled: true, suspicious: false, description: '',
}));
const ruleSet = {
  id: 'r', name: 'test', description: '', contractions: true, hyphenMode: 'inline',
  cellsPerLine: 32,
  rules: [
    ...letters,
    { id: 'and', source: 'and', output: '⠯', kind: 'contraction', enabled: true, suspicious: false, description: '' },
    { id: 'the', source: 'the', output: '⠮', kind: 'contraction', enabled: true, suspicious: false, description: '' },
    { id: 'ch', source: 'ch', output: '⠡', kind: 'contraction', enabled: true, suspicious: false, description: '' },
    { id: 'th', source: 'th', output: '⠹', kind: 'contraction', enabled: true, suspicious: false, description: '' },
    { id: 'num', source: '#', output: '⠼', kind: 'number', enabled: true, suspicious: false, description: '' },
    { id: 'cap', source: 'capital', output: '⠠', kind: 'special', enabled: true, suspicious: false, description: '' },
  ],
};

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

// --- Case 1: long line wraps at 32 cells, continuation mark on 2nd segment ---
{
  const source = 'The quick brown fox jumps and the lazy dog runs fast through the green field today.';
  const tokens = transcribeLine(source, ruleSet);
  const segments = wrapTokens(tokens, 12);
  console.log('Case 1 segments at 12 cells:');
  segments.forEach((s, i) => console.log(`   ${i + 1}: w=${s.width} cont=${s.continued} over=${s.overflow} | ${JSON.stringify(segmentBraille(s))}`));
  check('产生多段', segments.length >= 3);
  check('第一段无续行标记', segments[0].continued === false);
  check('第二段起带续行标记', segments.slice(1).every((s) => s.continued === true));
  check('每段宽度（除超宽外）不超容量', segments.filter((s) => !s.overflow).every((s) => s.width <= (s.continued ? 12 : 12)));
  check('续行段宽度扣掉标记后 ≤ 12', segments.filter((s) => s.continued && !s.overflow).every((s) => s.width <= 12));
}

// --- Case 2: contractions / number strings never split ---
{
  const tokens = transcribeLine('and the 12345 ch th', ruleSet);
  const atomic = tokens.filter((t) => ['contraction', 'number'].includes(t.kind));
  console.log('Case 2 atomic units:', atomic.map((t) => `${t.text}(${tokenWidth(t)})`).join(' '));
  check('and 是 1 格单元', atomic.find((t) => t.text === 'and') && tokenWidth(atomic.find((t) => t.text === 'and')) === 1);
  const num = atomic.find((t) => t.text === '12345');
  check('数字串 12345 是一个单元、6 格（含数字符）', num && tokenWidth(num) === 6);
  // very narrow width forces wrap; each atomic token must appear whole in one segment
  const segments = wrapTokens(tokens, 2);
  const allWhole = atomic.every((a) => segments.some((s) => s.tokens.some((t) => t.id === a.id)));
  check('原子单元整体出现在某一段中（未被切开）', allWhole);
}

// --- Case 3: oversized unit alone on a line, marked overflow ---
{
  const tokens = transcribeLine('123456789012345', ruleSet); // 15 digits + sign = 16 cells
  const segments = wrapTokens(tokens, 8);
  console.log('Case 3:', segments.map((s) => `w=${s.width} over=${s.overflow} units=${s.overflowUnits.length}`).join(' | '));
  check('数字串超宽时标注 overflow', segments.length === 1 && segments[0].overflow === true);
  check('记录了超宽单元格数', segments[0].overflowUnits[0]?.width === 16);
  // with surrounding letters, overflowing number occupies its own segment
  const mixed = transcribeLine('abc 123456789012345 xyz', ruleSet);
  const seg2 = wrapTokens(mixed, 8);
  console.log('Case 3b:', seg2.map((s, i) => `${i + 1}:${s.tokens.map((t) => t.text || '_').join('')} over=${s.overflow}`).join(' || '));
  const numSeg = seg2.find((s) => s.overflow);
  check('超宽单元单独占一段', numSeg && numSeg.tokens.filter((t) => t.text !== ' ').length === 1);
}

// --- Case 4: signature changes when width shrinks; approved line returns to questionable; unchanged stays approved ---
{
  const source = 'The quick brown fox jumps over the lazy dog and runs across the meadow.';
  const makeState = (width, status, sig) => ({
    id: 'p', title: 't', author: '', activeRuleSetId: 'r',
    ruleSets: [{ ...ruleSet, cellsPerLine: width }],
    lines: [{ id: 'l1', source, tokens: [], status, note: '', continuesPrevious: false, continuesNext: false, wrapSignature: sig, wrapPending: false }],
    selectedLineId: '', issues: [], versions: [], lastCheckedAt: '', updatedAt: '',
  });

  const baseline = analyzeProject(makeState(32, 'approved', ''), false);
  const baseSig = baseline.lines[0].wrapSignature;
  check('基线折行后仍为 approved', baseline.lines[0].status === 'approved');

  // shrink: layoutChanged=true
  const shrunk = analyzeProject({
    ...baseline,
    ruleSets: [{ ...ruleSet, cellsPerLine: 10 }],
  }, true);
  console.log('Case 4 sigs:', baseSig, '->', shrunk.lines[0].wrapSignature);
  check('改小格数后签名变化', shrunk.lines[0].wrapSignature !== baseSig);
  check('原批准行退回 questionable', shrunk.lines[0].status === 'questionable');
  check('wrapPending=true', shrunk.lines[0].wrapPending === true);
  check('生成 wrap-changed 问题', shrunk.issues.some((i) => i.code === 'wrap-changed'));

  // line that wraps identically at new width stays approved
  const short = 'abc';
  const base2 = analyzeProject({
    id: 'p2', title: 't', author: '', activeRuleSetId: 'r', ruleSets: [{ ...ruleSet, cellsPerLine: 32 }],
    lines: [{ id: 's', source: short, tokens: [], status: 'approved', note: '', continuesPrevious: false, continuesNext: false, wrapSignature: '', wrapPending: false }],
    selectedLineId: '', issues: [], versions: [], lastCheckedAt: '', updatedAt: '',
  });
  const same = analyzeProject({
    ...base2,
    ruleSets: [{ ...ruleSet, cellsPerLine: 16 }],
  }, true);
  check('折行没变的行照旧批准', same.lines[0].status === 'approved' && same.lines[0].wrapPending === false);

  // editing source (layoutChanged=false) must not mark wrap-changed
  const edited = analyzeProject({ ...baseline }, false);
  check('普通重新分析不产生 wrap-changed', !edited.issues.some((i) => i.code === 'wrap-changed'));
}

// --- Case 5: default 32 ---
{
  const rs = { ...ruleSet, cellsPerLine: undefined };
  const tokens = transcribeLine('short line', rs);
  const segs = wrapTokens(tokens, 32);
  check('短行在 32 格内只占一段', segs.length === 1);
  check('续行标记常量为 ↳', CONTINUATION_MARK === '↳');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// extra edge cases
{
  const empty = wrapTokens([], 32);
  check('空行返回单段且无标记', empty.length === 1 && empty[0].continued === false && empty[0].tokens.length === 0);

  const tokens8 = transcribeLine('abcdefgh', ruleSet); // exactly 8 letters
  const segs = wrapTokens(tokens8, 8);
  check('恰好 8 格的内容首段放下', segs.length === 1 && segs[0].overflow === false);

  // 9 letters: first segment holds 7 (capacity 8-1 for continuation), second has 2 with mark
  const tokens9 = transcribeLine('abcdefghi', ruleSet);
  const segs9 = wrapTokens(tokens9, 8);
  check('续行段首件 = 容量的单元不重复拆', segs9.length === 2 && segs9[1].tokens.length === 2 && segs9[1].continued);
}
console.log(`FINAL ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
