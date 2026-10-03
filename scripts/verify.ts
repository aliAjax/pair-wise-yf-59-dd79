// 端到端校验：剔除最差轮 / 作废重算 / 乐观锁冲突 / 部分失败重试 / 旧数据迁移
// 用法：node --experimental-strip-types scripts/verify.ts
import assert from 'node:assert';

// ---- localStorage / crypto / structuredClone 垫片 ----
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear()
};
if (!(globalThis as any).crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2, 10) }
  });
}
if (!(globalThis as any).structuredClone) {
  (globalThis as any).structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v));
}

const { store, saveRoundResults, toggleRaceVoid, resolveProtest, simulateExternalChange, migrate, computeStandings } =
  await import('../src/store.ts');

const state0 = () => store.getState().regatta;
let pass = 0;
const ok = (name: string) => { pass++; console.log('  ✓', name); };

// 1. 初始总名次：3 轮、每船剔除最差一轮
let s = state0();
assert.ok(s.standings, '启动即发布总名次');
assert.equal(s.standings!.revision, 1);
const rankOf = (sailNo: string) => s.standings!.rows.find((r) => r.sailNo === sailNo)!;
// 海风: r1=1,r2=1,r3=2 → 剔2 → 2分
assert.deepEqual(rankOf('CHN 218').roundScores, { 'race-1': 1, 'race-2': 1, 'race-3': 2 });
assert.equal(rankOf('CHN 218').droppedRaceId, 'race-3');
assert.equal(rankOf('CHN 218').total, 2);
// 远岚: r1=3(处罚后最慢),r2=3,r3=1 → 剔3 → 4分
assert.equal(rankOf('CHN 106').total, 4);
// 北辰: r1=2,r2=2,r3=2 → 剔2 → 4分，与远岚同分按顺序
assert.equal(rankOf('CHN 077').total, 4);
assert.equal(rankOf('CHN 218').rank, 1);
ok('3 轮时每船剔除最差一轮，海风 2 分第一');

// 2. 改判处罚 → 修订号推进、总名次退回重算、旧版留档
const beforeHist = s.standingsHistory.length;
const protest = s.protests[0]; // race-1 / entry-2 远岚号
let res = store.dispatch(resolveProtest({
  id: protest.id, status: 'resolved', decision: 'x', penaltySeconds: 60,
  expectedRevision: s.races.find((r) => r.id === 'race-1')!.revision
})) as any;
assert.equal(res.kind, 'ok');
s = state0();
assert.equal(s.races.find((r) => r.id === 'race-1')!.revision, 2);
assert.equal(s.standings!.revision, 2);
assert.equal(s.standingsHistory.length, beforeHist + 1, 'v1 留档');
assert.equal(s.standingsHistory[0].revision, 1, '旧版是 v1');
ok('抗议改判：修订号 +1，在版退回为 v2，v1 留档可查');

// 3. 作废第3轮 → 之前被海风顶掉的 r3=3 退出；只剩两轮，仍然剔最差
store.dispatch(toggleRaceVoid({ id: 'race-3', voided: true }));
s = state0();
assert.ok(s.standings!.voidedRaceIds.includes('race-3'));
const hf = s.standings!.rows.find((r) => r.sailNo === 'CHN 218')!;
assert.equal(hf.roundScores['race-3'], undefined);
assert.deepEqual(Object.keys(hf.roundScores).sort(), ['race-1', 'race-2']);
// r1=1,r2=1 → 剔1 → 1分
assert.equal(hf.total, 1);
ok('作废第3轮：该轮退出比较，总名次按剩余有效轮重算');

// 4. 作废到只剩 1 轮 → 不再剔除任何一轮
store.dispatch(toggleRaceVoid({ id: 'race-2', voided: true }));
s = state0();
const only = s.standings!.rows.find((r) => r.sailNo === 'CHN 218')!;
assert.equal(only.droppedRaceId, null, '唯一有效轮不再剔除');
assert.equal(only.total, 1);
assert.deepEqual(s.standings!.includedRaceIds, ['race-1']);
ok('只剩一个有效轮时不剔最差，全部成绩重新参与');

// 5. 恢复第2轮 → 被剔除轮重新参与比较
store.dispatch(toggleRaceVoid({ id: 'race-2', voided: false }));
store.dispatch(toggleRaceVoid({ id: 'race-3', voided: false }));
s = state0();
assert.equal(s.standings!.includedRaceIds.length, 3);
ok('轮次恢复后重新计入');

// 6. 乐观锁：两个人同时改同一轮，后到者基于旧修订号 → conflict
s = state0();
const revNow = s.races.find((r) => r.id === 'race-2')!.revision;
store.dispatch(simulateExternalChange({ raceId: 'race-2' })); // 先来的人已写入
res = store.dispatch(saveRoundResults({
  raceId: 'race-2', expectedRevision: revNow,
  patches: [{ entryId: 'entry-4', elapsedSeconds: 1, penaltySeconds: 0, note: 'late' }]
}));
assert.equal(res.kind, 'conflict');
assert.equal(res.currentRevision, revNow + 1, '后到者能看到新修订号');
// 冲突时一条都没写
s = state0();
assert.notEqual(s.entries.find((e) => e.id === 'entry-4')!.elapsedSeconds, 1);
ok('并发修改同一轮：旧修订号整批被拒，返回当前修订号');

// 7. 用新修订号重试 → 通过
res = store.dispatch(saveRoundResults({
  raceId: 'race-2', expectedRevision: revNow + 1,
  patches: [{ entryId: 'entry-4', elapsedSeconds: 3001, penaltySeconds: 0, note: 'after refresh' }]
}));
assert.equal(res.kind, 'applied');
ok('重读修订号后保存成功');

// 8. 部分瞬时失败 → partial；只重试没写进去的，重试成功
s = state0();
const rev3 = s.races.find((r) => r.id === 'race-1')!.revision;
localStorage.removeItem('regatta-retry-v1');
res = store.dispatch(saveRoundResults({
  raceId: 'race-1', expectedRevision: rev3,
  patches: [
    { entryId: 'entry-1', elapsedSeconds: 3100, penaltySeconds: 0, note: 'a' },
    { entryId: 'entry-3', elapsedSeconds: 3300, penaltySeconds: 0, note: 'b' }
  ],
  transientFailIds: ['entry-3']
}));
assert.equal(res.kind, 'partial');
assert.deepEqual(res.failedIds, ['entry-3']);
s = state0();
assert.equal(s.entries.find((e) => e.id === 'entry-1')!.elapsedSeconds, 3100, '成功的已写');
assert.notEqual(s.entries.find((e) => e.id === 'entry-3')!.elapsedSeconds, 3300, '失败的没写');
const afterPartial = s.races.find((r) => r.id === 'race-1')!.revision;
assert.equal(afterPartial, rev3 + 1, '有写入就推进修订号');
ok('部分失败：写入成功的条目，失败条目原样保留');

// 只重试未写入的（不带 transientFailIds，且重试名单里已有 entry-3）
res = store.dispatch(saveRoundResults({
  raceId: 'race-1', expectedRevision: afterPartial,
  patches: [{ entryId: 'entry-3', elapsedSeconds: 3300, penaltySeconds: 0, note: 'b-retry' }]
}));
assert.equal(res.kind, 'applied');
assert.deepEqual(res.failedIds, []);
s = state0();
assert.equal(s.entries.find((e) => e.id === 'entry-3')!.elapsedSeconds, 3300);
assert.equal(s.entries.find((e) => e.id === 'entry-1')!.elapsedSeconds, 3100, '已写入的不重复处理');
ok('重试只发未写入的条目，第二次全部成功');

// 9. 作废轮不能录成绩
store.dispatch(toggleRaceVoid({ id: 'race-2', voided: true }));
s = state0();
res = store.dispatch(saveRoundResults({
  raceId: 'race-2', expectedRevision: s.races.find((r) => r.id === 'race-2')!.revision,
  patches: [{ entryId: 'entry-4', elapsedSeconds: 9, penaltySeconds: 0, note: '' }]
}));
assert.equal(res.kind, 'voided');
store.dispatch(toggleRaceVoid({ id: 'race-2', voided: false }));
ok('已作废轮拒绝录入');

// 10. 抗议改判同样受乐观锁保护
s = state0();
const revR1 = s.races.find((r) => r.id === 'race-1')!.revision;
store.dispatch(simulateExternalChange({ raceId: 'race-1' }));
const p2 = s.protests.find((p) => p.status !== 'resolved' && p.status !== 'rejected') ?? s.protests[0];
res = store.dispatch(resolveProtest({ id: p2.id, status: 'resolved', penaltySeconds: 90, expectedRevision: revR1 })) as any;
assert.equal(res.kind, 'conflict');
ok('抗议改判遇到修订号变化同样被拒');

// 11. 旧数据迁移：无轮号的单场成绩 → 挂到唯一有效轮
const legacy = {
  races: [{ id: 'old-race', name: '旧赛', fleet: 'f', course: 'c', startsAt: new Date().toISOString(), status: 'finished' }],
  entries: [
    { id: 'x1', boat: '旧船A', sailNo: 'S1', skipper: 'a', elapsedSeconds: 100, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
    { id: 'x2', boat: '旧船B', sailNo: 'S2', skipper: 'b', elapsedSeconds: 120, penaltySeconds: 0, resultStatus: 'provisional', note: '' }
  ],
  protests: [], timeline: []
};
const migrated = migrate(legacy);
assert.equal(migrated.races[0].voidState, 'valid');
assert.equal(migrated.races[0].revision, 1);
assert.equal(migrated.races[0].roundNo, 1);
assert.ok(migrated.entries.every((e) => e.raceId === 'old-race'));
assert.deepEqual(migrated.standingsHistory, []);
ok('旧数据：无轮号单场成绩升级为唯一有效轮，补齐新字段');

// 迁移后能直接算总名次，单轮不剔除
const st = computeStandings({ races: migrated.races, entries: migrated.entries, reason: '迁移首版', prevRevision: 0 });
assert.equal(st.rows.length, 2);
assert.equal(st.rows[0].sailNo, 'S1');
assert.equal(st.rows[0].droppedRaceId, null);
assert.equal(st.rows[0].total, 1);
ok('迁移数据可直接重算总名次');

console.log(`\n全部 ${pass} 项校验通过 ✅`);
