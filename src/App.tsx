import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, InputNumber, Layout, List, Menu, Modal, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined, HistoryOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest,
  resolveProtest,
  saveRoundResults,
  setRaceStatus,
  simulateExternalChange,
  toggleRaceVoid,
  type AppDispatch,
  type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import type { Race, RaceEntry, RoundResultPatch, SaveRoundResultsResult, StandingsVersion } from './types';

const { Header, Content, Sider } = Layout;

const net = (entry: RaceEntry) => entry.elapsedSeconds + entry.penaltySeconds;
const roundLabel = (race: Race) => `第${race.roundNo}轮`;

const protestSchema = z.object({
  raceId: z.string().min(1),
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function useRaces() {
  const races = useSelector((s: RootState) => s.regatta.races);
  return useMemo(() => [...races].sort((a, b) => a.roundNo - b.roundNo), [races]);
}

function RoundPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const races = useRaces();
  return (
    <Select
      value={value}
      onChange={onChange}
      style={{ minWidth: 200 }}
      options={races.map((race) => ({
        value: race.id,
        label: `${roundLabel(race)} · ${race.status === 'finished' ? '已结束' : race.status === 'running' ? '进行中' : '待起航'}${race.voidState === 'voided' ? '（已作废）' : ''}`
      }))}
    />
  );
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const races = useRaces();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [raceId, setRaceId] = useState(races[0]?.id ?? '');
  const race = races.find((item) => item.id === raceId) ?? races[0];
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const roundEntries = useMemo(
    () => entries.filter((entry) => entry.raceId === race?.id).sort((a, b) => net(a) - net(b)),
    [entries, race?.id]
  );

  if (!race) return null;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Space style={{ marginBottom: 12 }}>
              <RoundPicker value={race.id} onChange={setRaceId} />
              {race.voidState === 'voided' && <Tag color="red">该轮已作废，不计入总名次</Tag>}
            </Space>
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="当前修订号">{race.revision}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
              {race.voidState === 'valid'
                ? <Button danger onClick={() => dispatch(toggleRaceVoid({ id: race.id, voided: true }))}>作废本轮成绩</Button>
                : <Button type="primary" ghost onClick={() => dispatch(toggleRaceVoid({ id: race.id, voided: false }))}>恢复本轮有效</Button>}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{roundEntries.length} 艘参赛船</Tag>}>
            <Table rowKey="id" pagination={false} dataSource={roundEntries} columns={[
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '当前净用时', render: (_v, r: RaceEntry) => `${net(r)}s` },
              { title: '处罚', dataIndex: 'penaltySeconds', width: 72, render: (v: number) => v > 0 ? <Tag color="orange">+{v}s</Tag> : 0 },
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

interface Draft { elapsedSeconds: number; penaltySeconds: number; note: string; }

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const [msgApi, contextHolder] = message.useMessage();
  const races = useRaces();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [raceId, setRaceId] = useState(races.find((r) => r.voidState === 'valid')?.id ?? races[0]?.id ?? '');
  const race = races.find((item) => item.id === raceId);
  const roundEntries = useMemo(() => entries.filter((e) => e.raceId === raceId), [entries, raceId]);

  // 乐观锁：打开某轮时记录的修订号；别人先改后这里会过期
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [partial, setPartial] = useState<{ failedIds: string[] } | null>(null);
  const [simulateFailId, setSimulateFailId] = useState<string | undefined>(undefined);

  const syncFromStore = () => {
    if (!race) return;
    setExpectedRevision(race.revision);
    // 重读以最新存储成绩覆盖本地草稿（冲突后放弃过期修改）
    setDrafts(Object.fromEntries(roundEntries.map((e) => [
      e.id,
      { elapsedSeconds: e.elapsedSeconds, penaltySeconds: e.penaltySeconds, note: e.note }
    ])));
    setConflictRevision(null);
    setPartial(null);
  };

  useEffect(() => { syncFromStore(); /* 切换轮次重新取数 */ }, [raceId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!race) return null;
  const isVoided = race.voidState === 'voided';

  const updateDraft = (entryId: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [entryId]: { ...prev[entryId], ...patch } }));
    setPartial(null);
  };

  const toPatches = (ids?: string[]): RoundResultPatch[] =>
    roundEntries
      .filter((e) => !ids || ids.includes(e.id))
      .map((e) => ({ entryId: e.id, ...drafts[e.id] }))
      .filter((p) => p.elapsedSeconds > 0 && p.penaltySeconds >= 0);

  const submit = async (onlyFailed?: string[]) => {
    if (expectedRevision === null) return;
    const result = dispatch(saveRoundResults({
      raceId,
      expectedRevision,
      patches: toPatches(onlyFailed),
      // 演示“某条瞬时写入失败”：失败后再重试不会再失败
      transientFailIds: onlyFailed ? undefined : simulateFailId ? [simulateFailId] : undefined
    }));

    const handle = (r: SaveRoundResultsResult) => {
      if (r.kind === 'conflict') {
        setConflictRevision(r.currentRevision ?? null);
        msgApi.error(`修订号冲突：该轮已被其他人改到 ${r.currentRevision}，请重读后再保存`);
        return;
      }
      if (r.kind === 'voided') { msgApi.warning('该轮已作废，不能再录入成绩'); return; }
      if (r.kind === 'missing') { msgApi.error('轮次不存在'); return; }
      if (r.kind === 'partial') {
        setExpectedRevision(r.revision ?? expectedRevision);
        setPartial({ failedIds: r.failedIds });
        msgApi.warning(`${r.failedIds.length} 条未写入，可只重试这些条目`);
        return;
      }
      // applied
      setExpectedRevision(r.revision ?? expectedRevision);
      setPartial(null);
      setSimulateFailId(undefined);
      msgApi.success(`成绩已保存，该轮修订号推进到 ${r.revision}，总名次已重算`);
    };
    handle(result);
  };

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card title="按轮批量录入 / 更正成绩" extra={
          <Space>
            <RoundPicker value={raceId} onChange={setRaceId} />
            <Tag color={conflictRevision !== null ? 'red' : 'blue'}>修订号 {expectedRevision} → 当前 {race.revision}</Tag>
            <Button size="small" icon={<ReloadOutlined />} onClick={syncFromStore}>重读</Button>
          </Space>
        }>
          {isVoided && <Tag color="red" style={{ marginBottom: 12 }}>本轮已作废，成绩只读；恢复有效后才能修改</Tag>}
          {conflictRevision !== null && (
            <Card size="small" style={{ marginBottom: 12, borderColor: '#ff4d4f' }}>
              <Space wrap>
                <WarningOutlined style={{ color: '#ff4d4f' }} />
                <span>你打开时是修订号 {expectedRevision}，现在已是 {conflictRevision}，本次保存全部被拒绝。</span>
                <Button size="small" type="primary" danger icon={<ReloadOutlined />} onClick={syncFromStore}>按最新版本重读</Button>
              </Space>
            </Card>
          )}
          {partial && (
            <Card size="small" style={{ marginBottom: 12, borderColor: '#faad14' }}>
              <Space wrap>
                <WarningOutlined style={{ color: '#faad14' }} />
                <span>{partial.failedIds.length} 条没写进去（其余已生效并推进修订号）。</span>
                <Button size="small" type="primary" ghost onClick={() => void submit(partial.failedIds)}>只重试未写入的 {partial.failedIds.length} 条</Button>
              </Space>
            </Card>
          )}
          <Table rowKey="id" pagination={false} dataSource={roundEntries} rowClassName={(e) => partial?.failedIds.includes(e.id) ? 'row-failed' : ''} columns={[
            { title: '船名', dataIndex: 'boat', width: 120 },
            { title: '帆号', dataIndex: 'sailNo', width: 120 },
            { title: '净用时(秒)', width: 150, render: (_v, e) => (
              <InputNumber size="small" disabled={isVoided} value={drafts[e.id]?.elapsedSeconds} min={1}
                onChange={(v) => updateDraft(e.id, { elapsedSeconds: Number(v) })} />
            )},
            { title: '处罚(秒)', width: 130, render: (_v, e) => (
              <InputNumber size="small" disabled={isVoided} value={drafts[e.id]?.penaltySeconds} min={0}
                onChange={(v) => updateDraft(e.id, { penaltySeconds: Number(v) })} />
            )},
            { title: '更正说明', render: (_v, e) => (
              <Input size="small" disabled={isVoided} value={drafts[e.id]?.note}
                onChange={(ev) => updateDraft(e.id, { note: ev.target.value })} />
            )},
            { title: '合计', width: 90, render: (_v, e) => {
              const d = drafts[e.id];
              return d ? `${d.elapsedSeconds + d.penaltySeconds}s` : '';
            }},
            { title: '模拟故障', width: 110, render: (_v, e) => (
              <Button size="small" danger={simulateFailId === e.id} type={simulateFailId === e.id ? 'primary' : 'default'}
                disabled={isVoided}
                onClick={() => setSimulateFailId((prev) => prev === e.id ? undefined : e.id)}>
                {simulateFailId === e.id ? '保存时失败' : '设为失败'}
              </Button>
            )}
          ]} />
          <Space style={{ marginTop: 16 }}>
            <Button type="primary" disabled={isVoided || conflictRevision !== null} onClick={() => void submit()}>保存整轮（基于修订号 {expectedRevision}）</Button>
            <Button icon={<WarningOutlined />} onClick={() => dispatch(simulateExternalChange({ raceId }))}>模拟另一终端抢先修改本轮</Button>
          </Space>
        </Card>
      </Space>
    </>
  );
}

function standingsColumns(version: StandingsVersion, races: Race[]) {
  const sortedRaces = [...races].sort((a, b) => a.roundNo - b.roundNo);
  return [
    { title: '名次', dataIndex: 'rank', width: 64, render: (v: number) => <b>{v}</b> },
    { title: '船名', dataIndex: 'boat', width: 120 },
    { title: '帆号', dataIndex: 'sailNo', width: 110 },
    ...sortedRaces.map((race) => ({
      title: `${roundLabel(race)}${race.voidState === 'voided' ? '（作废）' : ''}`,
      width: 120,
      render: (_v: unknown, row: StandingsVersion['rows'][number]) => {
        if (race.voidState === 'voided' || version.voidedRaceIds.includes(race.id)) return <Tag>—</Tag>;
        const score = row.roundScores[race.id];
        if (score === undefined) return <Tag>未参赛</Tag>;
        const dropped = row.droppedRaceId === race.id;
        return (
          <Space size={4}>
            <span style={dropped ? { textDecoration: 'line-through', color: '#999' } : undefined}>{score} 分</span>
            {dropped && <Tag color="default">剔除</Tag>}
          </Space>
        );
      }
    })),
    { title: '剔除轮', width: 90, render: (_v: unknown, row: StandingsVersion['rows'][number]) =>
      row.droppedRaceId ? roundLabel(sortedRaces.find((r) => r.id === row.droppedRaceId)!) : <Tag>无</Tag> },
    { title: '总分', dataIndex: 'total', width: 90, render: (v: number) => <b>{v}</b> }
  ];
}

function StandingsPage() {
  const races = useRaces();
  const standings = useSelector((s: RootState) => s.regatta.standings);
  const history = useSelector((s: RootState) => s.regatta.standingsHistory);
  const [viewing, setViewing] = useState<StandingsVersion | null>(null);

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={17}>
        <Card title="系列赛总名次（剔除最差一轮）" extra={standings && <Tag color="green">在版 v{standings.revision}</Tag>}>
          {standings ? (
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Descriptions column={{ xs: 1, sm: 3 }} size="small">
                <Descriptions.Item label="重算原因">{standings.reason}</Descriptions.Item>
                <Descriptions.Item label="发布时间">{new Date(standings.createdAt).toLocaleString()}</Descriptions.Item>
                <Descriptions.Item label="计入轮次">
                  {standings.includedRaceIds.map((id) => {
                    const race = races.find((r) => r.id === id);
                    return <Tag key={id} color="blue">{race ? roundLabel(race) : id} rev{standings.raceRevisions[id]}</Tag>;
                  })}
                  {standings.voidedRaceIds.length > 0 && standings.voidedRaceIds.map((id) => {
                    const race = races.find((r) => r.id === id);
                    return <Tag key={id} color="red">{race ? roundLabel(race) : id} 作废</Tag>;
                  })}
                </Descriptions.Item>
              </Descriptions>
              <Table rowKey="sailNo" pagination={false} dataSource={standings.rows}
                columns={standingsColumns(standings, races) as never[]} scroll={{ x: 'max-content' }} />
            </Space>
          ) : <Empty description="尚无总名次" />}
        </Card>
      </Col>
      <Col xs={24} lg={7}>
        <Card title={<Space><HistoryOutlined />已退回的旧版总名次</Space>}>
          {history.length === 0 ? <Empty description="没有旧版" /> : (
            <List dataSource={history} renderItem={(version) => (
              <List.Item actions={[<Button key="view" size="small" type="link" onClick={() => setViewing(version)}>查看</Button>]}>
                <List.Item.Meta
                  title={<Space><Tag>v{version.revision}</Tag>{version.reason}</Space>}
                  description={<>
                    <small>{new Date(version.createdAt).toLocaleString()}</small>
                    <div>计入 {version.includedRaceIds.length} 轮{version.voidedRaceIds.length > 0 ? `，作废 ${version.voidedRaceIds.length} 轮` : ''}</div>
                  </>}
                />
              </List.Item>
            )} />
          )}
        </Card>
      </Col>

      <Modal open={viewing !== null} title={viewing ? `旧版总名次 v${viewing.revision}（只读留档）` : ''}
        onCancel={() => setViewing(null)} footer={null} width={900}>
        {viewing && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="重算原因">{viewing.reason}</Descriptions.Item>
              <Descriptions.Item label="发布时间">{new Date(viewing.createdAt).toLocaleString()}</Descriptions.Item>
            </Descriptions>
            <Table rowKey="sailNo" pagination={false} size="small" dataSource={viewing.rows}
              columns={standingsColumns(viewing, races) as never[]} scroll={{ x: 'max-content' }} />
          </Space>
        )}
      </Modal>
    </Row>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const races = useRaces();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [msgApi, contextHolder] = message.useMessage();

  // 每个抗议处理时基于的轮次修订号快照；别人改过后需显式重读
  const [baseRevision, setBaseRevision] = useState<Record<string, number>>({});
  const [conflictFor, setConflictFor] = useState<Record<string, number>>({});

  const revisionFor = (protestId: string, raceId: string) =>
    baseRevision[protestId] ?? races.find((r) => r.id === raceId)?.revision ?? 0;

  // 新出现的抗议，首次进入队列时锁定当时的轮次修订号
  useEffect(() => {
    setBaseRevision((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const protest of protests) {
        if (!(protest.id in next)) {
          const race = races.find((r) => r.id === protest.raceId);
          if (race) { next[protest.id] = race.revision; changed = true; }
        }
      }
      return changed ? next : prev;
    });
  }, [protests, races]);

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({
    resolver: zodResolver(protestSchema),
    defaultValues: { raceId: races[0]?.id ?? '', entryId: entries[0]?.id ?? '', reason: '', rule: 'RRS 14' }
  });
  const selectedRaceId = watch('raceId');
  const raceEntries = entries.filter((entry) => entry.raceId === selectedRaceId);

  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest(values));
    msgApi.success('抗议已登记');
    reset({ raceId: values.raceId, entryId: raceEntries[0]?.id, reason: '', rule: 'RRS 14' });
  };

  const resolve = (id: string, status: 'resolved' | 'rejected', raceId: string) => {
    const result = dispatch(resolveProtest(status === 'resolved'
      ? { id, status, decision: '接受抗议并处以30秒处罚', penaltySeconds: 30, expectedRevision: revisionFor(id, raceId) }
      : { id, status, decision: '证据不足，维持原成绩' }
    ));
    if (result.kind === 'conflict') {
      setConflictFor((prev) => ({ ...prev, [id]: result.currentRevision ?? 0 }));
      msgApi.error(`该轮修订号已变为 ${result.currentRevision}，改判被拒绝，请先重读`);
    } else if (result.kind === 'ok') {
      setConflictFor((prev) => { const next = { ...prev }; delete next[id]; return next; });
      msgApi.success(status === 'resolved' ? '已改判，处罚写入并触发总名次重算' : '已驳回，维持原成绩');
    }
  };

  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={9}>
          <Card title="提交抗议">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="轮次">
                <select className="native-select" {...register('raceId')}>
                  {races.map((race) => <option key={race.id} value={race.id}>{roundLabel(race)}{race.voidState === 'voided' ? '（已作废）' : ''}</option>)}
                </select>
              </Form.Item>
              <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
                <select className="native-select" {...register('entryId')}>
                  {raceEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}
                </select>
              </Form.Item>
              <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
              <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card title="冲突复核队列">
            {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => {
              const race = races.find((r) => r.id === item.raceId);
              const base = revisionFor(item.id, item.raceId);
              const conflictRev = conflictFor[item.id];
              const stale = conflictRev !== undefined || (race !== undefined && base !== race.revision);
              return (
                <List.Item>
                  <List.Item.Meta
                    title={<Space wrap><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}<Tag>{race ? roundLabel(race) : item.raceId}</Tag></Space>}
                    description={
                      <Space direction="vertical" size={4}>
                        <div>{item.reason}</div>
                        <small>{entries.find((entry) => entry.id === item.entryId)?.boat} · 处理基于修订号 {base}{race ? `（当前 ${race.revision}）` : ''}</small>
                        {stale && item.status !== 'resolved' && item.status !== 'rejected' && (
                          <Tag color="red">修订号已变{conflictRev !== undefined ? `：${conflictRev}` : ''}，需重读后才能改判</Tag>
                        )}
                      </Space>
                    }
                  />
                  <Space direction="vertical">
                    <Button size="small" onClick={() => dispatch(resolveProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                    <Button size="small" type="primary" disabled={stale}
                      onClick={() => resolve(item.id, 'resolved', item.raceId)}>接受并处罚 +30s</Button>
                    <Button size="small" danger disabled={stale} onClick={() => resolve(item.id, 'rejected', item.raceId)}>驳回</Button>
                    <Button size="small" icon={<ReloadOutlined />} onClick={() => {
                      if (race) setBaseRevision((prev) => ({ ...prev, [item.id]: race.revision }));
                      setConflictFor((prev) => { const next = { ...prev }; delete next[item.id]; return next; });
                    }}>重读修订号</Button>
                    <Button size="small" icon={<WarningOutlined />} onClick={() => dispatch(simulateExternalChange({ raceId: item.raceId }))}>模拟他人同轮改判</Button>
                  </Space>
                </List.Item>
              );
            }} />}
          </Card>
        </Col>
        <Col xs={24} lg={6}>
          <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : event.type === 'system' ? 'purple' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
        </Col>
      </Row>
    </>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space><Tag>{data.length} 名值班人员</Tag><Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button></Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/standings', label: t('standings'), icon: <SafetyCertificateOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/standings" element={<StandingsPage />} />
          <Route path="/protests" element={<ProtestsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
