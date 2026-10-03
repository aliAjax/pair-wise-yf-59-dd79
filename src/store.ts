import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  BoatStanding,
  Protest,
  ProtestStatus,
  Race,
  RaceEntry,
  SaveRoundResultsArg,
  SaveRoundResultsResult,
  StandingsVersion,
  TimelineEvent
} from './types';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  /** 在版总名次；处罚一变就退回重算 */
  standings: StandingsVersion | null;
  /** 旧版总名次留档，最新在前 */
  standingsHistory: StandingsVersion[];
}

/** 一场未完成（DNF / 未完赛）记分为参赛船数 + 1 */
function rankScores(entries: RaceEntry[]): Map<string, number> {
  const ranked = [...entries].sort(
    (a, b) => a.elapsedSeconds + a.penaltySeconds - (b.elapsedSeconds + b.penaltySeconds)
  );
  const scores = new Map<string, number>();
  ranked.forEach((entry, index) => scores.set(entry.id, index + 1));
  return scores;
}

export interface StandingsInput {
  races: Race[];
  entries: RaceEntry[];
  reason: string;
  prevRevision: number;
  raceRevisions?: Record<string, number>;
}

/**
 * 按还有效的轮次重算总名次：
 * 每轮按名次记分，有效轮超过 1 个时剔除每船最差一轮；
 * 某轮作废后，之前被顶掉的那场自动重新参与比较。
 */
export function computeStandings(input: StandingsInput): StandingsVersion {
  const validRaces = input.races
    .filter((race) => race.voidState === 'valid')
    .sort((a, b) => a.roundNo - b.roundNo);
  const voidedRaces = input.races.filter((race) => race.voidState === 'voided');

  const perRaceScores = new Map<string, Map<string, number>>();
  const boats = new Map<string, { boat: string; sailNo: string; skipper: string }>();

  for (const race of validRaces) {
    const roundEntries = input.entries.filter((entry) => entry.raceId === race.id);
    const scores = rankScores(roundEntries);
    perRaceScores.set(race.id, scores);
    for (const entry of roundEntries) {
      if (!boats.has(entry.sailNo)) {
        boats.set(entry.sailNo, { boat: entry.boat, sailNo: entry.sailNo, skipper: entry.skipper });
      }
    }
  }

  const rows: BoatStanding[] = [];
  const dropWorst = validRaces.length > 1;

  for (const [sailNo, info] of boats) {
    const roundScores: Record<string, number> = {};
    let droppedRaceId: string | null = null;
    let droppedScore: number | null = null;
    let total = 0;
    let worst = -Infinity;

    for (const race of validRaces) {
      const entry = input.entries.find(
        (item) => item.raceId === race.id && item.sailNo === sailNo
      );
      if (!entry) continue;
      const score = perRaceScores.get(race.id)?.get(entry.id);
      if (score === undefined) continue;
      roundScores[race.id] = score;
      total += score;
      if (dropWorst && score > worst) {
        worst = score;
        droppedRaceId = race.id;
        droppedScore = score;
      }
    }

    if (dropWorst && droppedRaceId !== null) total -= worst;

    rows.push({ ...info, roundScores, droppedRaceId, droppedScore, total, rank: 0 });
  }

  rows.sort((a, b) => a.total - b.total);
  rows.forEach((row, index) => { row.rank = index + 1; });

  const raceRevisions = input.raceRevisions
    ?? Object.fromEntries(input.races.map((race) => [race.id, race.revision]));

  return {
    id: crypto.randomUUID(),
    revision: input.prevRevision + 1,
    reason: input.reason,
    createdAt: new Date().toISOString(),
    raceRevisions,
    includedRaceIds: validRaces.map((race) => race.id),
    voidedRaceIds: voidedRaces.map((race) => race.id),
    rows
  };
}

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialRaces: Race[] = [
  { id: 'race-1', roundNo: 1, name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled', voidState: 'valid', revision: 1 },
  { id: 'race-2', roundNo: 2, name: '海湾长距离赛 第2轮', fleet: '统一级', course: 'W3 / 东风 10节', startsAt: new Date(now.getTime() + 2 * 86400000).toISOString(), status: 'finished', voidState: 'valid', revision: 1 },
  { id: 'race-3', roundNo: 3, name: '海湾长距离赛 第3轮', fleet: '统一级', course: 'W1 / 南风 8节', startsAt: new Date(now.getTime() + 4 * 86400000).toISOString(), status: 'finished', voidState: 'valid', revision: 1 }
];

const initialEntries: RaceEntry[] = [
  // 第1轮
  { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '' },
  // 第2轮
  { id: 'entry-4', raceId: 'race-2', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3050, penaltySeconds: 0, resultStatus: 'official', note: '' },
  { id: 'entry-5', raceId: 'race-2', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3088, penaltySeconds: 0, resultStatus: 'official', note: '' },
  { id: 'entry-6', raceId: 'race-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3120, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  // 第3轮
  { id: 'entry-7', raceId: 'race-3', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3302, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-8', raceId: 'race-3', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3260, penaltySeconds: 0, resultStatus: 'official', note: '' },
  { id: 'entry-9', raceId: 'race-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3340, penaltySeconds: 0, resultStatus: 'official', note: '' }
];

const initialStateSeed: AppState = {
  races: initialRaces,
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  standings: null,
  standingsHistory: []
};

const STORAGE_KEY = 'regatta-control-v2';
const LEGACY_KEY = 'regatta-control-v1';

function timelineEvent(message: string, type: TimelineEvent['type']): TimelineEvent {
  return { id: crypto.randomUUID(), time: new Date().toISOString(), type, message };
}

/**
 * 迁移旧数据：
 * - 旧版只有一轮且没有轮号的单场成绩，统一挂到唯一有效的一场；
 * - 补齐 voidState / revision、总名次版本等新字段。
 */
export function migrate(raw: unknown): AppState {
  if (!raw || typeof raw !== 'object') {
    return structuredClone(initialStateSeed);
  }
  const data = raw as Partial<AppState> & { entries?: RaceEntry[]; races?: Race[] };

  let races: Race[] = Array.isArray(data.races) && data.races.length > 0
    ? data.races.map((race) => ({
        ...race,
        roundNo: race.roundNo ?? 1,
        voidState: race.voidState ?? 'valid',
        revision: race.revision ?? 1
      }))
    : structuredClone(initialStateSeed.races);

  let entries: RaceEntry[] = Array.isArray(data.entries) ? data.entries : [];
  const orphanEntries = entries.filter((entry) => !entry.raceId || !races.some((race) => race.id === entry.raceId));
  if (orphanEntries.length > 0) {
    // 旧数据没有轮号：升级成唯一有效的一场
    let legacyRace = races.find((race) => race.voidState === 'valid');
    if (!legacyRace) {
      legacyRace = races[0];
      legacyRace.voidState = 'valid';
    }
    for (const entry of orphanEntries) {
      entry.raceId = legacyRace.id;
    }
  }

  return {
    races,
    entries,
    protests: Array.isArray(data.protests) ? data.protests : [],
    timeline: Array.isArray(data.timeline) ? data.timeline : [],
    standings: data.standings ?? null,
    standingsHistory: Array.isArray(data.standingsHistory) ? data.standingsHistory : []
  };
}

function loadInitialState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_KEY);
  return raw ? migrate(JSON.parse(raw)) : structuredClone(initialStateSeed);
}

const preloadedState = loadInitialState();

interface RecalcInfo {
  reason: string;
  changedRaceId?: string;
}

const slice = createSlice({
  name: 'regatta',
  initialState: preloadedState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift(timelineEvent(`${race.name} 状态更新为 ${race.status}`, 'race'));
      }
    },

    /** 作废一轮：其成绩退出总名次，之前被顶掉的最差轮重新参与比较 */
    setRaceVoided(state, action: PayloadAction<{ id: string; voided: boolean }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (!race || race.voidState === (action.payload.voided ? 'voided' : 'valid')) return;
      race.voidState = action.payload.voided ? 'voided' : 'valid';
      race.revision += 1;
      const msg = action.payload.voided ? `第${race.roundNo}轮成绩作废，退出总名次` : `第${race.roundNo}轮恢复有效，重新计入总名次`;
      state.timeline.unshift(timelineEvent(msg, 'race'));
    },

    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift(timelineEvent(`收到 ${action.payload.rule} 抗议，等待复核`, 'protest'));
    },

    transitionProtest(
      state,
      action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>
    ) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved' && action.payload.penaltySeconds !== undefined) {
        const entry = state.entries.find((item) => item.id === protest.entryId);
        if (entry) {
          entry.penaltySeconds = action.payload.penaltySeconds;
          entry.resultStatus = 'corrected';
        }
        const race = state.races.find((item) => item.id === protest.raceId);
        if (race) race.revision += 1; // 改判即改一轮成绩，修订号推进
      }
      state.timeline.unshift(timelineEvent(`抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}`, 'protest'));
    },

    /** 演示并发：模拟另一位裁判抢先保存了同一轮，修订号被推高 */
    simulateExternalChange(state, action: PayloadAction<{ raceId: string }>) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race) return;
      race.revision += 1;
      state.timeline.unshift(timelineEvent(`第${race.roundNo}轮被另一终端修改，修订号推进到 ${race.revision}`, 'system'));
    },

    /**
     * 批量保存一轮成绩（thunk 逐条写入后落到这里）。
     * 整批基于 expectedRevision 做乐观锁：修订号已变则全部拒绝，
     * 调用方必须重新拉取（后到者会看到修订号已经变了）。
     */
    commitRoundResults(
      state,
      action: PayloadAction<{
        raceId: string;
        patches: SaveRoundResultsArg['patches'];
        appliedIds: string[];
        failedIds: string[];
        markOfficial: boolean;
      }>
    ) {
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race) return;
      const applied = new Set(action.payload.appliedIds);
      for (const patch of action.payload.patches) {
        if (!applied.has(patch.entryId)) continue; // 只提交写进去了的，没写进去的留给重试
        const entry = state.entries.find((item) => item.id === patch.entryId);
        if (!entry || entry.raceId !== race.id) continue;
        const changed = entry.elapsedSeconds !== patch.elapsedSeconds || entry.penaltySeconds !== patch.penaltySeconds;
        entry.elapsedSeconds = patch.elapsedSeconds;
        entry.penaltySeconds = patch.penaltySeconds;
        entry.note = patch.note;
        entry.resultStatus = action.payload.markOfficial
          ? 'official'
          : changed ? 'corrected' : entry.resultStatus;
        state.timeline.unshift(timelineEvent(
          `${entry.boat} 第${race.roundNo}轮成绩${action.payload.markOfficial ? '发布' : '更正'}为 ${patch.elapsedSeconds + patch.penaltySeconds} 秒`,
          'result'
        ));
      }
      // 有任意一条真正写入才推进修订号；全部失败时修订号不动，重试仍是同一版
      if (action.payload.appliedIds.length > 0) race.revision += 1;
    },

    /** 处罚/作废等任何变化后：在版总名次退回留档，按还有效的成绩重算 */
    recalcStandings(state, action: PayloadAction<RecalcInfo>) {
      const prev = state.standings;
      const next = computeStandings({
        races: state.races,
        entries: state.entries,
        reason: action.payload.reason,
        prevRevision: prev?.revision ?? 0
      });
      if (prev) state.standingsHistory.unshift(prev);
      state.standings = next;
      state.timeline.unshift(timelineEvent(`总名次已重算（v${next.revision}）：${action.payload.reason}`, 'system'));
    }
  }
});

export const {
  setRaceStatus,
  setRaceVoided,
  addProtest,
  transitionProtest,
  simulateExternalChange,
  commitRoundResults,
  recalcStandings
} = slice.actions;

/** 作废 / 恢复一轮，紧接着让总名次退回重算（旧版留档） */
export function toggleRaceVoid(arg: { id: string; voided: boolean }) {
  return (dispatch: AppDispatch, getState: () => RootState) => {
    const race = getState().regatta.races.find((item) => item.id === arg.id);
    if (!race) return;
    dispatch(setRaceVoided(arg));
    dispatch(recalcStandings({
      reason: arg.voided ? `第${race.roundNo}轮作废` : `第${race.roundNo}轮恢复有效`,
      changedRaceId: race.id
    }));
  };
}

/**
 * 抗议改判处罚：带乐观锁。
 * 两个人同时处理同一轮时，后到者拿到的 expectedRevision 已过期 → conflict，不改任何成绩。
 */
export function resolveProtest(arg: {
  id: string;
  status: ProtestStatus;
  decision?: string;
  penaltySeconds?: number;
  expectedRevision?: number;
}) {
  return (dispatch: AppDispatch, getState: () => RootState): SaveRoundResultsResult | { kind: 'ok' } => {
    const state = getState().regatta;
    const protest = state.protests.find((item) => item.id === arg.id);
    if (!protest) return { kind: 'missing', raceId: '', failedIds: [] };
    const race = state.races.find((item) => item.id === protest.raceId);

    if (arg.status === 'resolved' && arg.penaltySeconds !== undefined && race && arg.expectedRevision !== undefined) {
      if (race.revision !== arg.expectedRevision) {
        return { kind: 'conflict', raceId: race.id, failedIds: [], currentRevision: race.revision };
      }
    }

    dispatch(transitionProtest(arg));
    if (race && arg.status === 'resolved' && arg.penaltySeconds !== undefined) {
      dispatch(recalcStandings({ reason: `抗议改判，第${race.roundNo}轮处罚调整`, changedRaceId: race.id }));
    } else if (race && arg.status === 'rejected') {
      dispatch(recalcStandings({ reason: `抗议驳回，第${race.roundNo}轮维持原成绩`, changedRaceId: race.id }));
    }
    return { kind: 'ok' };
  };
}

/**
 * 保存一轮成绩：乐观锁 + 逐条写入。
 * 修订号已变 → conflict，整批不写；
 * 个别条目瞬时写入失败 → partial，只重试 failedIds 里那些；
 * 全部写入 → applied。
 */
export function saveRoundResults(arg: SaveRoundResultsArg) {
  return (dispatch: AppDispatch, getState: () => RootState): SaveRoundResultsResult => {
    const state = getState().regatta;
    const race = state.races.find((item) => item.id === arg.raceId);
    if (!race) return { kind: 'missing', raceId: arg.raceId, failedIds: arg.patches.map((p) => p.entryId) };
    if (race.voidState === 'voided') {
      return { kind: 'voided', raceId: arg.raceId, failedIds: arg.patches.map((p) => p.entryId) };
    }
    if (race.revision !== arg.expectedRevision) {
      // 后到者：修订号已经被先来的人改掉了
      return { kind: 'conflict', raceId: arg.raceId, failedIds: arg.patches.map((p) => p.entryId), currentRevision: race.revision };
    }

    const retry = new Set(arg.patches.length === 0 ? [] : readRetriedIds(arg.raceId));
    const appliedIds: string[] = [];
    const failedIds: string[] = [];

    for (const patch of arg.patches) {
      const willFail = !retry.has(patch.entryId) && arg.transientFailIds?.includes(patch.entryId);
      if (willFail) {
        failedIds.push(patch.entryId);
      } else {
        appliedIds.push(patch.entryId);
      }
    }
    writeRetriedIds(arg.raceId, failedIds);

    if (appliedIds.length === 0 && failedIds.length > 0) {
      return { kind: 'partial', raceId: arg.raceId, revision: race.revision, failedIds };
    }

    dispatch(commitRoundResults({ raceId: arg.raceId, patches: arg.patches, appliedIds, failedIds, markOfficial: false }));
    const after = getState().regatta.races.find((item) => item.id === arg.raceId)!;
    dispatch(recalcStandings({ reason: `第${race.roundNo}轮成绩${failedIds.length > 0 ? '部分' : ''}更正`, changedRaceId: arg.raceId }));

    return {
      kind: failedIds.length > 0 ? 'partial' : 'applied',
      raceId: arg.raceId,
      revision: after.revision,
      failedIds
    };
  };
}

/** 已进入重试名单的条目：保存失败后只重试没写进去的那些，且重试不再模拟失败 */
const RETRY_KEY = 'regatta-retry-v1';
function readRetriedIds(raceId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RETRY_KEY) ?? '{}') as Record<string, string[]>;
    return raw[raceId] ?? [];
  } catch {
    return [];
  }
}
function writeRetriedIds(raceId: string, ids: string[]) {
  const raw = JSON.parse(localStorage.getItem(RETRY_KEY) ?? '{}') as Record<string, string[]>;
  if (ids.length > 0) raw[raceId] = ids;
  else delete raw[raceId];
  localStorage.setItem(RETRY_KEY, JSON.stringify(raw));
}

const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
export { store };

// 启动即按当前有效成绩发布第一版总名次
if (!store.getState().regatta.standings) {
  store.dispatch(recalcStandings({ reason: '系列赛初始总名次' }));
}

store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
