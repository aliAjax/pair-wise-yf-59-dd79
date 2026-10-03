# 帆船赛现场控制和申诉处理

源提示词摘要：竞赛官维护组别、航线、起航时间和处罚记录，计时员提交到达数据，裁判处理抗议、重赛、弃权和成绩更正；冲突或重复处罚进入复核，操作保留时间线。

## 技术栈

React 19、TypeScript、Vite、Ant Design、Redux Toolkit、RTK Query、React Router、React Hook Form、Zod、i18next。

## 本地运行

```bash
npm install
npm run dev
```

开发端口：`62024`

## 可用流程

- 竞赛控制：起航倒计时、比赛状态切换、船队和航线查看。
- 成绩管理：录入净用时和处罚秒数，标记成绩更正并发布正式成绩。
- 抗议处理：提交抗议、进入复核、支持抗议或维持原成绩，同时更新事件时间线。
- 数据使用 localStorage 持久化，刷新页面后继续保留。
