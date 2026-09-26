import type {
  BrailleSegment,
  BrailleToken,
  ProofIssue,
  ProjectState,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
} from './types';

/** 默认纸张：每行 32 格。 */
export const DEFAULT_CELLS_PER_LINE = 32;
export const MIN_CELLS_PER_LINE = 4;
export const MAX_CELLS_PER_LINE = 120;
/** 折行后续行段开头的续行标记（占 1 格）。 */
export const CONTINUATION_MARK = '↳';
const CONTINUATION_MARK_WIDTH = 1;

/** 单元所占盲文格数：按盲文字符计，分词空格不计格。 */
export function tokenWidth(token: BrailleToken): number {
  return [...token.braille.replace(/\s/gu, '')].length;
}

export function clampCellsPerLine(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CELLS_PER_LINE;
  return Math.min(MAX_CELLS_PER_LINE, Math.max(MIN_CELLS_PER_LINE, Math.round(value)));
}

function segmentWidth(tokens: BrailleToken[], continued: boolean): number {
  return (continued ? CONTINUATION_MARK_WIDTH : 0) + tokens.reduce((total, token) => total + tokenWidth(token), 0);
}

/**
 * 按盲文单元把一行 token 折成若干物理行。
 * 缩写、字母组合和数字串本身是一个不可拆分的单元；放不下时单独占一行并标注溢出。
 */
export function wrapTokens(tokensInput: BrailleToken[], cellsPerLine: number): BrailleSegment[] {
  const width = cellsPerLine > 0 ? cellsPerLine : DEFAULT_CELLS_PER_LINE;

  // 去掉行首尾及连续重复的分词空格；保留的行内空格作为折行点。
  const tokens: BrailleToken[] = [];
  for (const token of tokensInput) {
    if (token.text === ' ') {
      if (tokens.length === 0 || tokens[tokens.length - 1].text === ' ') continue;
      tokens.push(token);
    } else {
      tokens.push(token);
    }
  }
  while (tokens.length > 0 && tokens[tokens.length - 1].text === ' ') tokens.pop();

  const segments: BrailleSegment[] = [];
  let current: BrailleToken[] = [];
  let currentWidth = 0;

  const pushSegment = (segmentTokens: BrailleToken[], continued: boolean): BrailleSegment => {
    const overflowUnits: { token: BrailleToken; width: number }[] = [];
    let overflow = false;
    for (const token of segmentTokens) {
      const cellWidth = tokenWidth(token);
      // 放在续行段上时可用宽度还要扣除续行标记；放整行都放不下即标注。
      if (cellWidth > width || (continued && cellWidth > width - CONTINUATION_MARK_WIDTH)) {
        overflow = true;
        overflowUnits.push({ token, width: cellWidth });
      }
    }
    const segment: BrailleSegment = {
      tokens: segmentTokens,
      continued,
      width: segmentWidth(segmentTokens, continued),
      overflow,
      overflowUnits,
    };
    segments.push(segment);
    return segment;
  };

  for (const token of tokens) {
    const cellWidth = tokenWidth(token);
    // 尚未产生任何物理段时当前是第一段（无续行标记）；一旦已有段，当前填充的就是续行段。
    const continued = segments.length > 0;
    const capacity = continued ? width - CONTINUATION_MARK_WIDTH : width;

    if (current.length > 0 && currentWidth + cellWidth > capacity) {
      // 当前单元放不下：另起一段。原子单元绝不拆开；整行都放不下时由该段标注溢出。
      pushSegment(current, segments.length > 0);
      current = [];
      currentWidth = 0;
    }
    current.push(token);
    currentWidth += cellWidth;
  }

  if (current.length > 0 || segments.length === 0) {
    pushSegment(current, segments.length > 0);
  }

  return segments;
}

/** 折行签名：只记录每段的单元数与溢出标记，折行边界或溢出状态一变即不同。 */
export function wrapSignature(tokens: BrailleToken[], cellsPerLine: number): string {
  return wrapTokens(tokens, cellsPerLine)
    .map((segment) => `${segment.tokens.length}${segment.overflow ? '!' : ''}`)
    .join('/');
}

/** 一段渲染出的盲文文本（续行段带标记前缀）。 */
export function segmentBraille(segment: BrailleSegment): string {
  return `${segment.continued ? CONTINUATION_MARK : ''}${segment.tokens.map((token) => token.braille).join('')}`;
}

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

function analyzeLine(
  line: TextbookLine,
  ruleSet: RuleSet,
  previousLine?: TextbookLine,
  options: { layoutChanged?: boolean } = {},
): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));

  const cellsPerLine = ruleSet.cellsPerLine;
  const segments = wrapTokens(line.tokens, cellsPerLine);
  const signature = wrapSignature(line.tokens, cellsPerLine);

  // 改了每行格数（或其它引起重排的变化）后，原本已批准但折行结果变化的行退回待核对；
  // 折行没变的行照旧批准。
  const layoutChanged = Boolean(options.layoutChanged);
  const changedAfterApproval = layoutChanged && line.status === 'approved' && line.wrapSignature !== '' && signature !== line.wrapSignature;
  let wrapPending = changedAfterApproval;

  const nextLine: TextbookLine = {
    ...line,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
    wrapSignature: signature,
    wrapPending,
  };

  if (changedAfterApproval) {
    nextLine.status = 'questionable';
    issues.push(issue(nextLine, 'wrap-changed', `每行改为 ${cellsPerLine} 格后折行结果变化，请重新核对。`, 'warning'));
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

  for (const segment of segments) {
    for (const overflowUnit of segment.overflowUnits) {
      issues.push(
        issue(
          nextLine,
          'unit-overflow',
          `单元“${overflowUnit.token.text || overflowUnit.token.braille}”需 ${overflowUnit.width} 格，超过每行 ${cellsPerLine} 格，已单独成行；请人工核对或缩小该单元。`,
          'error',
          overflowUnit.token,
        ),
      );
    }
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

/**
 * 重新转录并分析全部行。
 * @param layoutChanged 每行格数等影响折行的设置发生变化时置 true：已批准但折行变化的行会退回待核对。
 */
export function analyzeProject(state: ProjectState, layoutChanged = false): ProjectState {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
    const analyzed = analyzeLine({ ...line, tokens }, ruleSet, state.lines[index - 1], { layoutChanged });
    nextLines.push(analyzed.line);
    issues.push(...analyzed.issues);
  });

  return {
    ...state,
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

/** 取一行在当前规则集格数下折好的物理行。 */
export function wrappedLine(line: TextbookLine, ruleSet: RuleSet): BrailleSegment[] {
  return wrapTokens(line.tokens, clampCellsPerLine(ruleSet.cellsPerLine));
}

export function outputText(state: ProjectState): string {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const rows: string[] = [];
  state.lines.forEach((line, index) => {
    const number = String(index + 1).padStart(3, '0');
    wrappedLine(line, ruleSet).forEach((segment, segmentIndex) => {
      const prefix = segmentIndex === 0 ? `${number}  ` : '     ↳ ';
      const notice = segment.overflow
        ? `  ⚠ 超宽单元 ${segment.overflowUnits.map((unit) => `${unit.width}格`).join('、')}（每行 ${ruleSet.cellsPerLine} 格，已单独成行）`
        : '';
      rows.push(`${prefix}${segment.tokens.map((token) => token.braille).join('')}${notice}`);
    });
  });
  return rows.join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + tokenWidth(token), 0), 0);
}

/** 兼容旧草稿：补齐每行格数与折行签名等新增字段。 */
export function migrateProject(state: ProjectState): ProjectState {
  const ruleSets = state.ruleSets.map((ruleSet) => ({
    ...ruleSet,
    cellsPerLine: clampCellsPerLine(ruleSet.cellsPerLine ?? DEFAULT_CELLS_PER_LINE),
  }));
  const ruleSetById = new Map(ruleSets.map((ruleSet) => [ruleSet.id, ruleSet]));
  const activeRuleSet = ruleSetById.get(state.activeRuleSetId) ?? ruleSets[0];
  const lines = state.lines.map((line) => ({
    ...line,
    wrapPending: line.wrapPending ?? false,
    wrapSignature: line.wrapSignature ?? (activeRuleSet ? wrapSignature(line.tokens, activeRuleSet.cellsPerLine) : ''),
  }));
  return { ...state, ruleSets, lines };
}
