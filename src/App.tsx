import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Alert, Button, Card, Col, Empty, Form, Input, Layout, List, Menu, Modal, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest,
  addRace,
  invalidateRound,
  publishStandings,
  reinstateRound,
  retryFailedWrites,
  saveResultsBatch,
  setRaceStatus,
  transitionProtest,
  updateResult,
  type AppDispatch,
  type RootState
} from './store';
import { computeStandings } from './standings';
import { useGetOfficialsQuery } from './api';
import type { RaceEntry, StandingVersion } from './types';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});
const raceSchema = z.object({
  name: z.string().min(2),
  fleet: z.string().min(2),
  course: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [now, setNow] = useState(Date.now());
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  const nextRoundNo = races.length + 1;
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof raceSchema>>({
    resolver: zodResolver(raceSchema),
    defaultValues: { name: `海湾长距离赛 第${nextRoundNo}轮`, fleet: '统一级', course: '' }
  });
  const submitRace = (values: z.infer<typeof raceSchema>) => {
    dispatch(addRace({ ...values, startsAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() }));
    setModalOpen(false);
    reset({ name: `海湾长距离赛 第${nextRoundNo + 1}轮`, fleet: '统一级', course: '' });
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24}>
          <Card
            title="系列赛轮次"
            extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>新增一轮</Button>}
          >
            <List
              dataSource={[...races].sort((a, b) => a.roundNo - b.roundNo)}
              renderItem={(race) => {
                const count = entries.filter((entry) => entry.raceId === race.id).length;
                return (
                  <List.Item
                    actions={[
                      <Button key="start" size="small" onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始</Button>,
                      <Button key="finish" size="small" onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束</Button>,
                      race.invalidated
                        ? <Button key="reinstate" size="small" onClick={() => dispatch(reinstateRound({ raceId: race.id }))}>恢复成绩</Button>
                        : <Button key="invalidate" size="small" danger onClick={() => dispatch(invalidateRound({ raceId: race.id, reason: '抗议成立，该轮成绩取消' }))}>作废成绩</Button>
                    ]}
                  >
                    <List.Item.Meta
                      title={<Space><Tag color="blue">第 {race.roundNo} 轮</Tag>{race.name}{race.invalidated && <Tag color="red">已作废</Tag>}</Space>}
                      description={<Space split="·"><span>{race.fleet}</span><span>{race.course}</span><span>{count} 艘参赛船</span><span>状态：{race.status}</span></Space>}
                    />
                    {race.status === 'scheduled' && !race.invalidated && (
                      <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
                    )}
                  </List.Item>
                );
              }}
            />
          </Card>
        </Col>
      </Row>

      <Modal title="新增一轮" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitRace)} okText="发布轮次" cancelText="取消">
        <Form layout="vertical">
          <Form.Item label="轮次名称" validateStatus={errors.name ? 'error' : undefined} help={errors.name?.message}><Input {...register('name')} /></Form.Item>
          <Form.Item label="组别" validateStatus={errors.fleet ? 'error' : undefined} help={errors.fleet?.message}><Input {...register('fleet')} /></Form.Item>
          <Form.Item label="航线" validateStatus={errors.course ? 'error' : undefined} help={errors.course?.message}><Input {...register('course')} placeholder="例如 W2 / 东北风 12节" /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function RoundResultsEditor({ raceId }: { raceId: string }) {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries.filter((entry) => entry.raceId === raceId));
  const pendingWrites = useSelector((state: RootState) => state.regatta.pendingWrites);
  const lastBatch = useSelector((state: RootState) => state.regatta.lastBatch);
  const lastConflict = useSelector((state: RootState) => state.regatta.lastConflict);
  const [drafts, setDrafts] = useState<Record<string, { elapsedSeconds: number; penaltySeconds: number; note: string }>>({});

  useEffect(() => {
    const next: typeof drafts = {};
    for (const entry of entries) {
      next[entry.id] = { elapsedSeconds: entry.elapsedSeconds, penaltySeconds: entry.penaltySeconds, note: entry.note };
    }
    setDrafts(next);
    // 切换轮次或一次批量/重试完成后，用已保存数据重置草稿
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceId, lastBatch?.at]);

  const setDraft = (id: string, patch: Partial<{ elapsedSeconds: number; penaltySeconds: number; note: string }>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const batchSave = () => {
    dispatch(saveResultsBatch({
      results: entries.map((entry) => ({
        id: entry.id,
        expectedRevision: entry.revision,
        elapsedSeconds: drafts[entry.id]?.elapsedSeconds ?? entry.elapsedSeconds,
        penaltySeconds: drafts[entry.id]?.penaltySeconds ?? entry.penaltySeconds,
        note: drafts[entry.id]?.note ?? entry.note
      }))
    }));
  };

  const pendingIds = new Set(pendingWrites.map((item) => item.id));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {lastConflict && (
        <Alert
          type="warning"
          showIcon
          message="成绩修订号已变更"
          description={`${entries.find((entry) => entry.id === lastConflict.entryId)?.boat ?? '某条成绩'} 当前修订号为 R${lastConflict.current}，你提交时基于 R${lastConflict.expected}。请刷新该行后重新修改。`}
        />
      )}
      {pendingWrites.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`有 ${pendingWrites.length} 条成绩未写入（修订号冲突）`}
          description="只有未写入的条目会被重试，已写入的不会重复保存。"
          action={<Button size="small" danger onClick={() => dispatch(retryFailedWrites())}>重试未写入项</Button>}
        />
      )}
      <Table
        rowKey="id"
        pagination={false}
        dataSource={[...entries].sort((a, b) => (drafts[a.id]?.elapsedSeconds ?? a.elapsedSeconds) + (drafts[a.id]?.penaltySeconds ?? a.penaltySeconds) - (drafts[b.id]?.elapsedSeconds ?? b.elapsedSeconds) - (drafts[b.id]?.penaltySeconds ?? b.penaltySeconds))}
        columns={[
          { title: '排名', render: (_v, _r, index) => index + 1, width: 56 },
          { title: '船名', render: (_v, r: RaceEntry) => <Space>{r.boat}{pendingIds.has(r.id) && <Tag color="red">未写入</Tag>}</Space> },
          { title: '帆号', dataIndex: 'sailNo', width: 100 },
          { title: '净用时(秒)', width: 110, render: (_v, r: RaceEntry) => (
            <Input type="number" size="small" value={drafts[r.id]?.elapsedSeconds ?? 0}
              onChange={(e) => setDraft(r.id, { elapsedSeconds: Number(e.target.value) })} />
          )},
          { title: '处罚(秒)', width: 100, render: (_v, r: RaceEntry) => (
            <Input type="number" size="small" value={drafts[r.id]?.penaltySeconds ?? 0}
              onChange={(e) => setDraft(r.id, { penaltySeconds: Number(e.target.value) })} />
          )},
          { title: '总用时', width: 90, render: (_v, r: RaceEntry) => (drafts[r.id]?.elapsedSeconds ?? r.elapsedSeconds) + (drafts[r.id]?.penaltySeconds ?? r.penaltySeconds) },
          { title: '修订号', width: 80, render: (_v, r: RaceEntry) => <Tag>R{r.revision}</Tag> },
          { title: '状态', width: 90, render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}</Tag> },
          { title: '操作', width: 90, render: (_v, r: RaceEntry) => (
            <Button size="small" type="link" onClick={() => dispatch(updateResult({
              id: r.id,
              expectedRevision: r.revision,
              elapsedSeconds: drafts[r.id]?.elapsedSeconds ?? r.elapsedSeconds,
              penaltySeconds: drafts[r.id]?.penaltySeconds ?? r.penaltySeconds,
              note: drafts[r.id]?.note ?? r.note,
              official: false
            }))}>保存</Button>
          )}
        ]}
      />
      <Space>
        <Button type="primary" onClick={batchSave}>批量保存本轮成绩</Button>
        <Button onClick={() => dispatch(publishStandings({ reason: '成绩录入完成，发布正式总名次' }))}>发布总名次</Button>
      </Space>
    </Space>
  );
}

function ResultsPage() {
  const races = useSelector((state: RootState) => state.regatta.races);
  const [selectedRaceId, setSelectedRaceId] = useState<string>('');
  const sortedRaces = useMemo(() => [...races].sort((a, b) => a.roundNo - b.roundNo), [races]);

  useEffect(() => {
    if (!selectedRaceId && sortedRaces[0]) setSelectedRaceId(sortedRaces[0].id);
  }, [sortedRaces, selectedRaceId]);

  const current = sortedRaces.find((race) => race.id === selectedRaceId);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title="成绩管理">
        <Space wrap>
          <span>选择轮次：</span>
          <Select value={selectedRaceId} onChange={setSelectedRaceId} style={{ width: 260 }}
            options={sortedRaces.map((race) => ({ value: race.id, label: `第 ${race.roundNo} 轮 · ${race.name}${race.invalidated ? '（已作废）' : ''}` }))} />
          {current?.invalidated && <Tag color="red">本轮成绩已作废，不计入总名次</Tag>}
        </Space>
      </Card>
      {current && <Card title={`第 ${current.roundNo} 轮成绩`}><RoundResultsEditor raceId={current.id} /></Card>}
    </Space>
  );
}

function StandingsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const versions = useSelector((state: RootState) => state.regatta.standingVersions);
  const current = useMemo(() => computeStandings(races, entries), [races, entries]);
  const [viewing, setViewing] = useState<StandingVersion | null>(null);

  const triggerColor = (trigger: StandingVersion['trigger']) =>
    trigger === 'publish' ? 'blue' : trigger === 'penalty' ? 'orange' : trigger === 'invalidate' ? 'red' : 'default';

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={16}>
        <Card title="总名次（实时重算）" extra={<Button type="primary" onClick={() => dispatch(publishStandings({ reason: '发布正式总名次' }))}>发布为正式版本</Button>}>
          <Table rowKey="sailNo" pagination={false} dataSource={current} columns={[
            { title: '名次', dataIndex: 'rank', width: 64, render: (rank: number) => <Tag color={rank === 1 ? 'gold' : 'default'}>{rank}</Tag> },
            { title: '船名', dataIndex: 'boat' },
            { title: '帆号', dataIndex: 'sailNo' },
            { title: '船长', dataIndex: 'skipper' },
            { title: '总积分', dataIndex: 'totalPoints', width: 90, sorter: (a, b) => a.totalPoints - b.totalPoints, defaultSortOrder: 'ascend' },
            { title: '各轮积分', render: (_v, row) => (
              <Space wrap size={4}>
                {row.roundScores.map((score) => (
                  <Tag key={score.raceId}
                    color={score.invalidated ? 'red' : score.discarded ? 'default' : 'blue'}
                    style={score.discarded ? { textDecoration: 'line-through' } : undefined}>
                    R{score.roundNo}: {score.invalidated ? '作废' : score.discarded ? `(${score.points})` : score.points}
                  </Tag>
                ))}
              </Space>
            )}
          ]} />
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="发布版本（旧版留存审计）">
          {versions.length === 0 ? <Empty description="尚未发布版本" /> : (
            <List dataSource={versions} renderItem={(version) => (
              <List.Item actions={[<Button key="view" size="small" type="link" onClick={() => setViewing(version)}>查看</Button>]}>
                <List.Item.Meta
                  title={<Space><Tag color={triggerColor(version.trigger)}>v{version.version}</Tag>{version.trigger}</Space>}
                  description={<><div>{version.reason}</div><small>{new Date(version.publishedAt).toLocaleString()}</small></>}
                />
              </List.Item>
            )} />
          )}
        </Card>
      </Col>

      <Modal title={viewing ? `总名次 v${viewing.version}（${viewing.trigger}）` : ''} open={!!viewing} onCancel={() => setViewing(null)} footer={null}>
        {viewing && (
          <Table rowKey="sailNo" pagination={false} size="small" dataSource={viewing.standings} columns={[
            { title: '名次', dataIndex: 'rank', width: 56 },
            { title: '船名', dataIndex: 'boat' },
            { title: '总积分', dataIndex: 'totalPoints', width: 80 },
            { title: '各轮', render: (_v, row) => row.roundScores.map((score) => `${score.roundNo}:${score.invalidated ? '废' : score.discarded ? `(${score.points})` : score.points}`).join(' ') }
          ]} />
        )}
      </Modal>
    </Row>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const races = useSelector((state: RootState) => state.regatta.races);
  const [raceId, setRaceId] = useState(races[0]?.id ?? '');
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: raceId || races[0]?.id, ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="轮次">
              <Select value={raceId} onChange={setRaceId} style={{ width: '100%' }}
                options={[...races].sort((a, b) => a.roundNo - b.roundNo).map((race) => ({ value: race.id, label: `第 ${race.roundNo} 轮 · ${race.name}` }))} />
            </Form.Item>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}{item.penaltySeconds ? <Tag color="orange">罚 {item.penaltySeconds} 秒</Tag> : null}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat} · {races.find((race) => race.id === item.raceId) ? `第 ${races.find((race) => race.id === item.raceId)?.roundNo} 轮` : ''}</small>{item.decision && <div><small>裁决：{item.decision}</small></div>}</>}
              />
              <Space direction="vertical">
                <Button size="small" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                <Button size="small" type="primary" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: '接受抗议并处以30秒处罚', penaltySeconds: 30 }))}>接受并处罚</Button>
                <Button size="small" danger onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>驳回</Button>
              </Space>
            </List.Item>
          )} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : event.type === 'system' ? 'red' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
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
