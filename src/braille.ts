import type {
  BrailleRow,
  BrailleToken,
  ProofIssue,
  ProjectState,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

/** 盲文纸默认每行格数 */
export const DEFAULT_CELLS_PER_LINE = 32;
/** 折行后续行开头的续行标记（注记，不占格） */
export const CONTINUATION_MARK = '↳';
/** 真正的盲文点位字符（⠀-⣿），注记文字不计格 */
const BRAILLE_PATTERN_RE = /[⠀-⣿]/gu;

const LETTERS: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚',
  k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞',
  u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

const DEFAULT_PUNCTUATION: Record<string, string> = {
  ',': '⠂', ';': '⠆', ':': '⠒', '.': '⠲', '!': '⠖', '?': '⠦', '(': '⠐⠣', ')': '⠐⠜',
  '-': '⠤', '—': '⠠⠤', '"': '⠦', "'": '⠄', '/': '⠸⠌', '&': '⠈⠯', '@': '⠈⠁',
};

const DIGITS: Record<string, string> = {
  '0': '⠚', '1': '⠁', '2': '⠃', '3': '⠉', '4': '⠙', '5': '⠑', '6': '⠋', '7': '⠛', '8': '⠓', '9': '⠊',
};

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function activeRule(ruleSet: RuleSet, source: string, kind: TranscriptionRule['kind']): TranscriptionRule | undefined {
  return ruleSet.rules.find((rule) => rule.enabled && rule.kind === kind && rule.source.toLocaleLowerCase() === source.toLocaleLowerCase());
}

function matchContraction(ruleSet: RuleSet, source: string, index: number): TranscriptionRule | undefined {
  if (!ruleSet.contractions) return undefined;
  const before = source[index - 1] ?? '';
  if (/[\p{L}\p{N}]/u.test(before)) return undefined;

  const candidates = ruleSet.rules
    .filter((rule) => rule.enabled && rule.kind === 'contraction')
    .sort((a, b) => b.source.length - a.source.length);

  const rest = source.slice(index).toLocaleLowerCase();
  return candidates.find((rule) => rest.startsWith(rule.source.toLocaleLowerCase()));
}

function addToken(
  tokens: BrailleToken[],
  text: string,
  braille: string,
  kind: BrailleToken['kind'],
  offset: number,
  rule?: TranscriptionRule,
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
  });
}

export function transcribeLine(source: string, ruleSet: RuleSet, continuesPrevious = false): BrailleToken[] {
  const tokens: BrailleToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const lower = char.toLocaleLowerCase();

    if (/\s/u.test(char)) {
      addToken(tokens, char, ' ', 'special', index);
      index += 1;
      continue;
    }

    const contraction = matchContraction(ruleSet, source, index);
    if (contraction) {
      addToken(tokens, source.slice(index, index + contraction.source.length), contraction.output, 'contraction', index, contraction);
      index += contraction.source.length;
      continue;
    }

    if (/\d/u.test(char)) {
      const start = index;
      let number = '';
      while (index < source.length && /\d/u.test(source[index])) {
        number += source[index];
        index += 1;
      }
      const numberRule = activeRule(ruleSet, '#', 'number');
      addToken(tokens, number, `${numberRule?.output ?? '⠼'}${[...number].map((digit) => DIGITS[digit]).join('')}`, 'number', start, numberRule);
      continue;
    }

    if (/[A-Z]/u.test(char)) {
      const capitalRule = activeRule(ruleSet, 'capital', 'special');
      addToken(tokens, char, `${capitalRule?.output ?? '⠠'}${LETTERS[lower]}`, 'letter', index, capitalRule);
      index += 1;
      continue;
    }

    if (/[a-z]/iu.test(char)) {
      const rule = activeRule(ruleSet, lower, 'letter');
      const output = rule?.output ?? LETTERS[lower] ?? '⠿';
      addToken(tokens, char, output, 'letter', index, rule);
      if (!rule) {
        addToken(tokens, '', '⟦未配置⟧', 'special', index);
      }
      index += 1;
      continue;
    }

    const punctuation = activeRule(ruleSet, char, 'punctuation') ?? activeRule(ruleSet, char.toLocaleLowerCase(), 'punctuation');
    if (punctuation) {
      addToken(tokens, char, punctuation.output, 'punctuation', index, punctuation);
      index += 1;
      continue;
    }

    const fallback = DEFAULT_PUNCTUATION[char];
    addToken(tokens, char, fallback ?? '⠿', 'punctuation', index);
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', ruleSet.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1));
  }

  if (continuesPrevious) {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
    });
  }

  return tokens;
}

/** 一个转写单元占用的盲文格数；缩写、字母组合、数字串等整体计格，不可拆开 */
function tokenCells(token: BrailleToken): number {
  return (token.braille.match(BRAILLE_PATTERN_RE) ?? []).length;
}

/**
 * 把一行的盲文单元按每行格数折成若干段落。
 * 缩写、字母组合和数字串各自是一个单元，绝不从中间切开；
 * 单元本身超过行宽时单独占一行并标记 overflow。
 */
export function wrapLineTokens(tokens: BrailleToken[], cellsPerLine: number): BrailleRow[] {
  const width = Math.max(1, Math.round(cellsPerLine) || DEFAULT_CELLS_PER_LINE);
  const rows: BrailleRow[] = [];
  let current: BrailleToken[] = [];
  let cells = 0;

  const flush = () => {
    while (current.length > 0 && current[current.length - 1].text === ' ') current.pop();
    if (current.length === 0) return;
    rows.push({
      index: rows.length + 1,
      continued: rows.length > 0,
      tokens: current,
      cells,
      overflow: false,
    });
    current = [];
    cells = 0;
  };

  for (const token of tokens) {
    if (token.text === ' ') {
      // 分词空格：行首丢弃；放得下就留在行内，放不下就作为折行点
      if (current.length === 0) continue;
      if (cells < width) {
        current.push(token);
        cells += tokenCells(token);
      } else {
        flush();
      }
      continue;
    }

    const cost = tokenCells(token);
    if (cost > width) {
      // 单元本身超过行宽：单独占一行，行上另行注明
      flush();
      rows.push({ index: rows.length + 1, continued: rows.length > 0, tokens: [token], cells: cost, overflow: true });
      continue;
    }
    if (cells + cost > width) flush();
    current.push(token);
    cells += cost;
  }
  flush();

  return rows;
}

/** 一段盲文行的可打印内容（含续行标记，超宽行附注记） */
export function rowBraille(row: BrailleRow): string {
  const body = row.tokens.map((token) => token.braille).join('');
  const note = row.overflow ? ` ⟦超宽单元 ${row.cells} 格，单独占一行⟧` : '';
  return `${row.continued ? `${CONTINUATION_MARK} ` : ''}${body}${note}`;
}

/** 折行结果签名：按单元在原文行内的下标边界划分，用于判断折行是否变化 */
function wrapSignature(rows: BrailleRow[]): string {
  let cursor = 0;
  return rows
    .map((row) => {
      const start = cursor;
      cursor += row.tokens.length;
      return `${start}-${cursor}${row.overflow ? '!' : ''}`;
    })
    .join('|');
}

function issue(
  line: TextbookLine,
  code: string,
  message: string,
  severity: ProofIssue['severity'],
  token?: BrailleToken,
): ProofIssue {
  return {
    id: uid('issue'),
    lineId: line.id,
    tokenId: token?.id,
    ruleId: token?.ruleId,
    severity,
    code,
    message,
    resolved: false,
  };
}

function analyzeLine(line: TextbookLine, cellsPerLine: number, previousLine?: TextbookLine): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
  const rows = wrapLineTokens(line.tokens, cellsPerLine);
  const previousSignature = (line.rows ?? []).length > 0 ? wrapSignature(line.rows) : '';
  const wrapChanged = Boolean(previousSignature) && previousSignature !== wrapSignature(rows);
  const nextLine: TextbookLine = {
    ...line,
    rows,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
  };

  if (wrapChanged && nextLine.status === 'approved') {
    nextLine.status = 'questionable';
    nextLine.reconfirm = true;
    issues.push(issue(
      nextLine,
      'wrap-changed',
      rows.length > 1
        ? `折行结果已变化（现为 ${rows.length} 行），原批准已退回，请重新确认。`
        : '折行结果已变化，原批准已退回，请重新确认。',
      'warning',
    ));
  }

  for (const row of rows) {
    if (row.overflow) {
      const token = row.tokens[0];
      issues.push(issue(
        nextLine,
        'unit-overflow',
        `单元“${token.text || token.braille}”共 ${row.cells} 格，超过每行 ${cellsPerLine} 格，已单独占一行，不可拆开。`,
        'warning',
        token,
      ));
    }
  }

  if (hasContinuation) {
    issues.push(issue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(issue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(issue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(issue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

export function analyzeProject(state: ProjectState): ProjectState {
  const ruleSets = state.ruleSets.map((ruleSet) => ({
    ...ruleSet,
    cellsPerLine: Math.max(1, Math.round(ruleSet.cellsPerLine) || DEFAULT_CELLS_PER_LINE),
  }));
  const ruleSet = ruleSets.find((item) => item.id === state.activeRuleSetId) ?? ruleSets[0];
  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
    const analyzed = analyzeLine({ ...line, tokens }, ruleSet.cellsPerLine, state.lines[index - 1]);
    nextLines.push(analyzed.line);
    issues.push(...analyzed.issues);
  });

  return {
    ...state,
    ruleSets,
    lines: nextLines,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => (rule.id === ruleId ? { ...rule, ...patch } : rule)),
  };
}

export function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
  return {
    id: uid('rule'),
    source,
    output,
    kind,
    enabled: true,
    suspicious,
    description: '自定义规则',
  };
}

export function outputText(state: ProjectState): string {
  const parts: string[] = [];
  state.lines.forEach((line, index) => {
    const number = String(index + 1).padStart(3, '0');
    if (line.rows.length === 0) {
      parts.push(`${number}  （空行）`);
      return;
    }
    line.rows.forEach((row, rowIndex) => {
      parts.push(`${rowIndex === 0 ? number : '   '}  ${rowBraille(row)}`);
    });
  });
  return parts.join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + token.braille.replace(/\s/g, '').length, 0), 0);
}
