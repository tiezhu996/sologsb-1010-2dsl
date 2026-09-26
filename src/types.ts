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
  /** 每行盲文纸放得下的格数，默认 32 */
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

export interface BrailleRow {
  /** 本段落在盲文纸上的第几行（从 1 开始） */
  index: number;
  /** 是否承接上一行（第二段起为 true，预览和导出时带续行标记） */
  continued: boolean;
  tokens: BrailleToken[];
  /** 实际占用的盲文格数（不含续行标记等注记） */
  cells: number;
  /** 单个不可拆单元超过行宽而单独占一行 */
  overflow: boolean;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  /** 按规则集每行格数折好的盲文段落 */
  rows: BrailleRow[];
  status: LineStatus;
  note: string;
  /** 每行格数变化导致折行结果改变，原批准作废，需重新确认 */
  reconfirm?: boolean;
  continuesPrevious: boolean;
  continuesNext: boolean;
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
