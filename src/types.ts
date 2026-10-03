export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  /** 轮号：系列赛中的第几轮 */
  roundNo: number;
  /** 该轮成绩是否被作废（抗议成立、重赛等） */
  invalidated: boolean;
}

export interface RaceEntry {
  id: string;
  /** 所属轮次 */
  raceId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
  /** 修订号：乐观并发控制，每次写入 +1 */
  revision: number;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  penaltySeconds?: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

/** 单轮积分（名次记分法：第 1 名 1 分，低分优先） */
export interface StandingRoundScore {
  raceId: string;
  roundNo: number;
  /** 该轮所得分数（等于名次） */
  points: number;
  /** 该轮名次 */
  rank: number;
  /** 是否被剔除（最差一轮） */
  discarded: boolean;
  /** 该轮是否已作废 */
  invalidated: boolean;
}

export interface StandingRow {
  boat: string;
  sailNo: string;
  skipper: string;
  /** 总积分（剔除最差轮后剩余有效轮次积分之和） */
  totalPoints: number;
  rank: number;
  roundScores: StandingRoundScore[];
  /** 第 1 名次数，平分时的判定依据 */
  wins: number;
}

export type StandingTrigger = 'publish' | 'penalty' | 'invalidate' | 'recalculate';

/** 总名次发布版本：每次重算留存一个版本，旧版供审计 */
export interface StandingVersion {
  id: string;
  version: number;
  publishedAt: string;
  trigger: StandingTrigger;
  reason: string;
  /** 重算时的轮次快照 */
  rounds: { raceId: string; roundNo: number; invalidated: boolean }[];
  standings: StandingRow[];
}
