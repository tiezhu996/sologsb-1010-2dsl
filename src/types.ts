export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  /** 纸张每行可容纳的盲文格数，默认 32。 */
  cellsPerLine: number;
  rules: TranscriptionRule[];
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

/** 折好后的一个物理行；缩写、字母组合与数字串等原子单元不会被拆到两段之间。 */
export interface BrailleSegment {
  tokens: BrailleToken[];
  /** 从第二段起为续行，行首带续行标记。 */
  continued: boolean;
  /** 本行实际占用的格数（含续行标记，不含分词空格）。 */
  width: number;
  /** 为 true 表示存在超出整行容量、无法容纳的单元，已单独占本行。 */
  overflow: boolean;
  overflowUnits: { token: BrailleToken; width: number }[];
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
  /** 当前折行结果的签名，用于在每行格数或规则变化后判断折行是否改变。 */
  wrapSignature: string;
  /** 因每行格数调整导致折行改变、等待重新确认（原为已批准）。 */
  wrapPending: boolean;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  action: string;
  snapshot: Omit<ProjectState, 'versions'>;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
