import type { Race, RaceEntry, StandingRow } from './types';

/**
 * 总名次计算（低分优先）：
 * 1. 每个有效轮次按总用时排名，名次即积分（第 1 名 1 分）；
 * 2. 作废轮次不参与；
 * 3. 剔除最差（积分最高）一轮，剩余轮次积分之和为总积分；
 * 4. 平分时按第 1 名次数判定。
 * 每次重算都从当前有效成绩重新出发——之前被顶掉的轮次会重新参与比较。
 */
export function computeStandings(races: Race[], entries: RaceEntry[]): StandingRow[] {
  const validRounds = races.filter((race) => !race.invalidated);

  const pointsByEntry = new Map<string, { rank: number; points: number }>();
  for (const race of validRounds) {
    const ranked = entries
      .filter((entry) => entry.raceId === race.id)
      .sort((a, b) => a.elapsedSeconds + a.penaltySeconds - (b.elapsedSeconds + b.penaltySeconds));
    ranked.forEach((entry, index) => {
      pointsByEntry.set(entry.id, { rank: index + 1, points: index + 1 });
    });
  }

  interface BoatAgg {
    boat: string;
    sailNo: string;
    skipper: string;
    scores: StandingRow['roundScores'];
  }
  const boats = new Map<string, BoatAgg>();
  for (const race of races) {
    const roundEntries = entries.filter((entry) => entry.raceId === race.id);
    for (const entry of roundEntries) {
      const key = entry.sailNo || entry.boat;
      const agg = boats.get(key) ?? { boat: entry.boat, sailNo: entry.sailNo, skipper: entry.skipper, scores: [] };
      const perf = pointsByEntry.get(entry.id);
      agg.scores.push({
        raceId: race.id,
        roundNo: race.roundNo,
        points: race.invalidated ? 0 : (perf?.points ?? 0),
        rank: perf?.rank ?? 0,
        discarded: false,
        invalidated: !!race.invalidated
      });
      boats.set(key, agg);
    }
  }

  // 有效轮次达到 3 轮才剔除最差一轮，否则全部计入
  const discardCount = validRounds.length >= 3 ? 1 : 0;

  const rows: StandingRow[] = [];
  for (const agg of boats.values()) {
    const validScores = agg.scores.filter((score) => !score.invalidated);
    const worstFirst = [...validScores].sort((a, b) => b.points - a.points || b.rank - a.rank);
    worstFirst.slice(0, discardCount).forEach((score) => { score.discarded = true; });
    const totalPoints = validScores.filter((score) => !score.discarded).reduce((sum, score) => sum + score.points, 0);
    rows.push({
      boat: agg.boat,
      sailNo: agg.sailNo,
      skipper: agg.skipper,
      totalPoints,
      rank: 0,
      roundScores: [...agg.scores].sort((a, b) => a.roundNo - b.roundNo),
      wins: validScores.filter((score) => score.rank === 1).length
    });
  }

  rows.sort((a, b) => a.totalPoints - b.totalPoints || b.wins - a.wins || a.sailNo.localeCompare(b.sailNo));
  rows.forEach((row, index) => { row.rank = index + 1; });
  return rows;
}
