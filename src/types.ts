export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';
export type RaceVoidState = 'valid' | 'voided';

export interface Race {
  id: string;
  /** 轮号，系列赛中的第几次比赛 */
  roundNo: number;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  /** valid=成绩有效；voided=该轮作废，不参与总名次 */
  voidState: RaceVoidState;
  /** 乐观锁：该轮成绩每写入一次就递增 */
  revision: number;
}

export interface RaceEntry {
  id: string;
  /** 所属轮次；旧数据可能缺失，迁移时挂到唯一有效轮 */
  raceId?: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

/** 单船在总名次中的一行 */
export interface BoatStanding {
  sailNo: string;
  boat: string;
  skipper: string;
  /** 各有效轮得分（名次分，1 名 = 1 分），键为 raceId */
  roundScores: Record<string, number>;
  /** 被剔除的最差轮（有效轮不足 2 个时为 null，全部重新参与比较） */
  droppedRaceId: string | null;
  droppedScore: number | null;
  total: number;
  rank: number;
}

/** 总名次版本：处罚改判 / 成绩更正 / 轮次作废都会让在版版本退回，重发新版 */
export interface StandingsVersion {
  id: string;
  revision: number;
  reason: string;
  createdAt: string;
  /** 重算时各轮的修订号，留档备查 */
  raceRevisions: Record<string, number>;
  includedRaceIds: string[];
  voidedRaceIds: string[];
  rows: BoatStanding[];
}

/** 一轮中某条船的批量保存载荷 */
export interface RoundResultPatch {
  entryId: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  note: string;
}

export interface SaveRoundResultsArg {
  raceId: string;
  /** 客户端读取时的修订号，与当前不一致则拒绝整批 */
  expectedRevision: number;
  patches: RoundResultPatch[];
  /** 演示用：本次提交里模拟“瞬时写入失败”的条目，重试时不再失败 */
  transientFailIds?: string[];
}

export interface SaveRoundResultsResult {
  kind: 'applied' | 'partial' | 'conflict' | 'missing' | 'voided';
  raceId: string;
  /** applied 之后的新修订号 */
  revision?: number;
  /** 仍未写入、需要重试的条目 */
  failedIds: string[];
  /** 冲突时服务端当前的修订号，调用方必须刷新后再改 */
  currentRevision?: number;
}
