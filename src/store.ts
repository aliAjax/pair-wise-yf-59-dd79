import { configureStore, createSlice, nanoid, type PayloadAction } from '@reduxjs/toolkit';
import type {
  Protest,
  ProtestStatus,
  Race,
  RaceEntry,
  StandingTrigger,
  StandingVersion,
  TimelineEvent
} from './types';
import { computeStandings } from './standings';
import { raceApi } from './api';

export interface PendingWrite {
  id: string;
  expectedRevision: number;
  elapsedSeconds: number;
  penaltySeconds: number;
  note: string;
}

export interface LastBatch {
  written: string[];
  failed: string[];
  at: string;
}

export interface ConflictInfo {
  entryId: string;
  expected: number;
  current: number;
  at: string;
}

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  /** 总名次版本列表，最新在前 */
  standingVersions: StandingVersion[];
  /** 批量保存后未写入、待重试的成绩（只重试这些） */
  pendingWrites: PendingWrite[];
  lastBatch: LastBatch | null;
  lastConflict: ConflictInfo | null;
}

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialRaces: Race[] = [
  { id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled', roundNo: 1, invalidated: false }
];

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '', revision: 1 },
  { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议', revision: 1 },
  { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '', revision: 1 }
];

const initialState: AppState = {
  races: initialRaces,
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  standingVersions: [],
  pendingWrites: [],
  lastBatch: null,
  lastConflict: null
};

/**
 * 旧数据迁移：
 * - 没有轮号的比赛按顺序补轮号；
 * - 没有关联轮次（raceId）的单场成绩升级为唯一有效轮（首轮）；
 * - 没有修订号的成绩补修订号 1。
 */
function migrate(raw: Partial<AppState> | undefined): AppState {
  if (!raw || (!raw.races && !raw.entries)) return initialState;

  const races: Race[] = (raw.races ?? []).map((race, index) => ({
    ...race,
    roundNo: typeof race.roundNo === 'number' ? race.roundNo : index + 1,
    invalidated: race.invalidated ?? false
  }));

  const firstRaceId = races[0]?.id ?? 'race-1';
  const entries: RaceEntry[] = (raw.entries ?? []).map((entry) => ({
    ...entry,
    raceId: entry.raceId ?? firstRaceId,
    revision: typeof entry.revision === 'number' ? entry.revision : 1
  }));

  return {
    races,
    entries,
    protests: raw.protests ?? [],
    timeline: raw.timeline ?? [],
    standingVersions: raw.standingVersions ?? [],
    pendingWrites: raw.pendingWrites ?? [],
    lastBatch: null,
    lastConflict: null
  };
}

/** 重算总名次并留存一个新版本；旧版本全部保留供审计。 */
function pushStandingVersion(state: AppState, trigger: StandingTrigger, reason: string) {
  const standings = computeStandings(state.races, state.entries);
  const version = (state.standingVersions[0]?.version ?? 0) + 1;
  state.standingVersions.unshift({
    id: nanoid(),
    version,
    publishedAt: new Date().toISOString(),
    trigger,
    reason,
    rounds: state.races.map((race) => ({ raceId: race.id, roundNo: race.roundNo, invalidated: !!race.invalidated })),
    standings
  });
}

function applyWrite(state: AppState, entry: RaceEntry, payload: { elapsedSeconds: number; penaltySeconds: number; note: string }) {
  entry.elapsedSeconds = payload.elapsedSeconds;
  entry.penaltySeconds = payload.penaltySeconds;
  entry.note = payload.note;
  entry.revision += 1;
  entry.resultStatus = 'corrected';
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    /** 新增一轮：轮号自动递增，并为所有参赛船生成该轮成绩记录（初始未完成）。 */
    addRace(state, action: PayloadAction<{ name: string; fleet: string; course: string; startsAt: string }>) {
      const roundNo = state.races.length + 1;
      const race: Race = {
        id: nanoid(),
        name: action.payload.name,
        fleet: action.payload.fleet,
        course: action.payload.course,
        startsAt: action.payload.startsAt,
        status: 'scheduled',
        roundNo,
        invalidated: false
      };
      state.races.push(race);
      const boats = new Map<string, { boat: string; sailNo: string; skipper: string }>();
      for (const entry of state.entries) {
        boats.set(entry.sailNo || entry.boat, { boat: entry.boat, sailNo: entry.sailNo, skipper: entry.skipper });
      }
      for (const boat of boats.values()) {
        state.entries.push({
          id: nanoid(),
          raceId: race.id,
          boat: boat.boat,
          sailNo: boat.sailNo,
          skipper: boat.skipper,
          elapsedSeconds: 0,
          penaltySeconds: 0,
          resultStatus: 'provisional',
          note: '',
          revision: 1
        });
      }
      state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'race', message: `第 ${roundNo} 轮已发布：${race.name}` });
    },
    /**
     * 单条成绩更正（乐观并发控制）：
     * 提交时携带期望修订号，与当前修订号不一致则拒绝写入，
     * 后到的修改者能看到修订号已变更。
     */
    updateResult(state, action: PayloadAction<{ id: string; expectedRevision: number; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      if (entry.revision !== action.payload.expectedRevision) {
        state.lastConflict = { entryId: entry.id, expected: action.payload.expectedRevision, current: entry.revision, at: new Date().toISOString() };
        state.timeline.unshift({
          id: nanoid(),
          time: new Date().toISOString(),
          type: 'system',
          message: `成绩修订冲突：${entry.boat} 当前修订号 R${entry.revision}，提交基于 R${action.payload.expectedRevision}，请刷新后重试`
        });
        return;
      }
      applyWrite(state, entry, action.payload);
      if (action.payload.official) entry.resultStatus = 'official';
      state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒（R${entry.revision}）` });
      pushStandingVersion(state, 'recalculate', `成绩更正：${entry.boat} 第 ${state.races.find((r) => r.id === entry.raceId)?.roundNo ?? '-'} 轮，总名次退回重算`);
    },
    /**
     * 批量保存一轮成绩：逐条写入，修订号不匹配的跳过（视为未写入），
     * 未写入的进入 pendingWrites，等待重试。
     */
    saveResultsBatch(state, action: PayloadAction<{ results: PendingWrite[] }>) {
      const written: string[] = [];
      const failed: PendingWrite[] = [];
      for (const item of action.payload.results) {
        const entry = state.entries.find((e) => e.id === item.id);
        if (!entry || entry.revision !== item.expectedRevision) {
          failed.push(item);
          continue;
        }
        applyWrite(state, entry, item);
        written.push(item.id);
      }
      state.pendingWrites = failed;
      state.lastBatch = { written, failed: failed.map((item) => item.id), at: new Date().toISOString() };
      if (written.length > 0) {
        state.timeline.unshift({
          id: nanoid(),
          time: new Date().toISOString(),
          type: 'result',
          message: `批量保存成绩：成功 ${written.length} 条，未写入 ${failed.length} 条`
        });
        pushStandingVersion(state, 'recalculate', '批量成绩保存后重算总名次');
      }
    },
    /** 重试批量保存中未写入的那些：只处理 pendingWrites，已写入的不重复写。 */
    retryFailedWrites(state) {
      if (state.pendingWrites.length === 0) return;
      const written: string[] = [];
      const stillFailed: PendingWrite[] = [];
      for (const item of state.pendingWrites) {
        const entry = state.entries.find((e) => e.id === item.id);
        if (!entry || entry.revision !== item.expectedRevision) {
          stillFailed.push(item);
          continue;
        }
        applyWrite(state, entry, item);
        written.push(item.id);
      }
      state.pendingWrites = stillFailed;
      state.lastBatch = { written, failed: stillFailed.map((item) => item.id), at: new Date().toISOString() };
      if (written.length > 0) {
        state.timeline.unshift({
          id: nanoid(),
          time: new Date().toISOString(),
          type: 'result',
          message: `重试未写入成绩：成功 ${written.length} 条，仍未写入 ${stillFailed.length} 条`
        });
        pushStandingVersion(state, 'recalculate', '重试写入后重算总名次');
      }
    },
    /** 作废某轮成绩：该轮退出总名次，之前被顶掉的轮次重新参与比较。 */
    invalidateRound(state, action: PayloadAction<{ raceId: string; reason?: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race || race.invalidated) return;
      race.invalidated = true;
      state.timeline.unshift({
        id: nanoid(),
        time: new Date().toISOString(),
        type: 'system',
        message: `第 ${race.roundNo} 轮成绩作废${action.payload.reason ? `：${action.payload.reason}` : ''}，总名次按有效成绩重算`
      });
      pushStandingVersion(state, 'invalidate', `第 ${race.roundNo} 轮作废，总名次按剩余有效轮次重算`);
    },
    /** 恢复已作废的轮次。 */
    reinstateRound(state, action: PayloadAction<{ raceId: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race || !race.invalidated) return;
      race.invalidated = false;
      state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'system', message: `第 ${race.roundNo} 轮成绩恢复有效，总名次重算` });
      pushStandingVersion(state, 'recalculate', `第 ${race.roundNo} 轮恢复，总名次重算`);
    },
    /** 手动发布当前总名次为一个新版本。 */
    publishStandings(state, action: PayloadAction<{ reason?: string }>) {
      state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'system', message: '总名次已发布为正式版本' });
      pushStandingVersion(state, 'publish', action.payload.reason ?? '发布正式总名次');
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: nanoid(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: nanoid(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved' && action.payload.penaltySeconds) {
        const entry = state.entries.find((item) => item.id === protest.entryId);
        if (entry) {
          entry.penaltySeconds = action.payload.penaltySeconds;
          entry.resultStatus = 'corrected';
          entry.revision += 1;
        }
        state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 处罚生效（${action.payload.penaltySeconds} 秒），总名次退回重算` });
        pushStandingVersion(state, 'penalty', `抗议 ${protest.id.slice(0, 6)} 处罚变更，总名次退回重算`);
      } else {
        state.timeline.unshift({ id: nanoid(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${protest.id.slice(0, 6)} 更新为 ${action.payload.status}` });
      }
    }
  }
});

const STORAGE_KEY = 'regatta-control-v1';
const stored = localStorage.getItem(STORAGE_KEY);
const preloadedState = migrate(stored ? JSON.parse(stored) as Partial<AppState> : undefined);

export const {
  setRaceStatus,
  addRace,
  updateResult,
  saveResultsBatch,
  retryFailedWrites,
  invalidateRound,
  reinstateRound,
  publishStandings,
  addProtest,
  transitionProtest
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
