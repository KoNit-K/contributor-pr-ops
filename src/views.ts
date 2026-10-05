import type { Config } from './config.js';
import type { Confirmation, PrIndex, MainState, Finding, Snapshot } from './model.js';
import { decideMaintenance } from './maintenance.js';
import { snapshotVersion, fingerprint } from './model.js';
import type { Store } from './store.js';
import type { HistoryResult, recordLedger } from './git.js';

export function safeText(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
export function localView(config: Config, db: Store) {
  const history = db.get<HistoryResult>('git', 'history');
  const latestHistory = db.get('git', 'attempt');
  const lastSync = db.get<{ status: string; observedAt: string }>('sync', 'last');
  const upstreamApplicable = history?.complete && !latestHistory && lastSync?.status === 'SUCCESS' && Date.now() - Date.parse(lastSync.observedAt) < 6 * 3600000;
  const prs = db.all<PrIndex>('index').map(pr => {
    let snapshot = db.snapshot(pr.number);
    if (snapshot) { snapshot = { ...snapshot, upstreamHead: upstreamApplicable ? history.head : undefined }; snapshot.version = snapshotVersion(snapshot); }
    const latestAttempt = db.get<{ status: string; code?: string }>('attempt-status', String(pr.number));
    const confirmations = db.all<Confirmation>('confirmation').filter(item => item.pr === pr.number && item.head === pr.head);
    const staleReasons = snapshot ? [
      ...(fingerprint(snapshot.pr) !== fingerprint(pr) ? ['Indexed PR evidence changed; the preceding snapshot is historical.'] : []),
      ...(snapshot.authAccount !== config.auth.account ? ['Authentication identity changed; permission-sensitive evidence requires collection.'] : []),
      ...(latestAttempt && latestAttempt.status !== 'SUCCESS' ? [`Latest collection did not succeed: ${latestAttempt.code ?? latestAttempt.status}.`] : []),
      ...(Date.now() - Date.parse(snapshot.contentCheckedAt ?? snapshot.observedAt) >= 6 * 3600000 ? ['Content recheck interval elapsed; synchronize to establish freshness.'] : []),
    ] : [];
    const decision = snapshot ? decideMaintenance(staleReasons.length ? { ...snapshot, complete: false, gaps: [...snapshot.gaps, ...staleReasons] } : snapshot, config, confirmations) : null;
    return { pr, snapshot, decision, excluded: config.maintenance.excluded_prs.includes(pr.number) || pr.labels.some(label => config.maintenance.excluded_labels.includes(label)), latestAttempt: latestAttempt ?? null };
  });
  const index = db.get<{ observedAt: string }>('scan', 'successful-index');
  const indexAttempt = db.get<{ complete: boolean; error?: string }>('scan', 'index-progress');
  const ordinary = prs.filter(item => item.pr.state === 'OPEN' && !item.excluded);
    const incomplete = ordinary.some(item => !item.snapshot?.complete || item.decision?.coverage === 'UNCHECKED');
  const syncProblem = lastSync && lastSync.status !== 'SUCCESS';
  return { status: !index || indexAttempt?.error || incomplete || !history?.complete || latestHistory || syncProblem ? 'PARTIAL' as const : 'SUCCESS' as const,
    scope: { repository: config.target.repository, author: config.target.author, branch: config.target.branch }, timezone: config.reporting.timezone,
    coverage: { indexed: prs.length, ordinaryOpen: ordinary.length, checked: ordinary.filter(item => item.decision?.coverage === 'CHECKED').length, cached: ordinary.filter(item => item.decision?.coverage === 'CACHED').length, unchecked: ordinary.filter(item => !item.decision || item.decision.coverage === 'UNCHECKED').length, index, indexAttempt },
    lifecycle: { open: prs.filter(item => item.pr.state === 'OPEN').length, draft: prs.filter(item => item.pr.state === 'OPEN' && item.pr.draft).length, merged: prs.filter(item => item.pr.state === 'MERGED' && item.pr.base === config.target.branch).length, closed: prs.filter(item => item.pr.state === 'CLOSED').length },
    prs, contributions: history ?? null, contributionAttempt: latestHistory ?? null, lastSync: lastSync ?? null, changes: db.get<ReturnType<typeof recordLedger>>('git', 'delta') ?? null,
    gaps: [...(!index ? ['No complete author index has been collected.'] : []), ...(!history?.complete ? ['No verified complete contribution history is available.'] : []), ...(latestHistory ? ['Latest contribution analysis is incomplete; preceding successful totals are retained.'] : []), ...(syncProblem ? [`Latest synchronization is ${lastSync.status}; retained successful evidence is historical.`] : [])] };
}
// Flatten external text before Markdown escaping so it cannot introduce headings or fences.
const md = (value: string) => safeText(value).replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/([\\`*\[\]|])/g, '\\$1').replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_');
function evidenceLink(value: string | null, label = '查看来源'): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || /gh[pousr]_|github_pat_/i.test(value)) return '';
    const hash = /^#(?:issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+)$/.test(url.hash) ? url.hash : '';
    return ` [${label}](${url.origin}${url.pathname.replace(/\(/g, '%28').replace(/\)/g, '%29')}${hash})`;
  } catch { return ''; }
}
const states: Record<MainState, string> = {
  CONFLICT: '存在合并冲突', MAINTAINER_ACTION: '维护者要求待处理', THIRD_PARTY_FEEDBACK: '第三方反馈待核查',
  UPSTREAM_CHANGED: '关联上游事项待核查', INSUFFICIENT_EVIDENCE: '证据不足，暂不能确定', CLOSE_CANDIDATE: '可考虑关闭（需确认）',
  MAINTAINER_EDITED: '维护者已修改', WAIT_REVIEWER: '等待审阅', NO_ACTION: '暂无已知待办',
};
const statusLabel = (status: string) => ({ SUCCESS: '成功', PARTIAL: '部分完成', PAUSED: '已暂停', FAILED: '失败', CONFIG_ERROR: '配置错误' }[status] ?? md(status));
function time(value: string | undefined, timezone: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未采集';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
function gapText(value: string): string {
  if (value === 'No complete author index has been collected.') return '作者 PR 清单尚未完整采集。';
  if (value === 'No verified complete contribution history is available.') return '贡献基线尚未完成，不能据此给出完整贡献总数。';
  if (value === 'Latest contribution analysis is incomplete; preceding successful totals are retained.') return '最近一次贡献分析未完成；保留的旧统计不代表本轮结果。';
  if (value.startsWith('Latest synchronization is ')) return '最近一轮同步尚未成功完成，已保留的证据仍有时效限制。';
  if (value.startsWith('Indexed PR evidence changed;')) return 'PR 的索引信息已变化，原快照仅供历史参考。';
  if (value.startsWith('Authentication identity changed;')) return '认证账号已变化，需要重新采集与权限有关的证据。';
  if (value.startsWith('Content recheck interval elapsed;')) return '内容复核间隔已到，需要同步确认信息仍然有效。';
  if (value.startsWith('Latest collection did not succeed:')) return '最近采集失败：' + value.split(':').slice(1).join(':').trim();
  return value; // Preserve specific unknown gaps rather than hiding or reinterpreting them.
}
function findingText(finding: Finding, snapshot: Snapshot): string {
  const id = finding.subject.slice(finding.subject.indexOf(':') + 1);
  const feedback = finding.subject.startsWith('feedback:') ? snapshot.feedback.find(item => item.id === id) : undefined;
  const relation = finding.subject.startsWith('relation:') ? snapshot.relations.find(item => item.id === id) : undefined;
  const check = finding.subject.startsWith('check:') ? snapshot.checks.find(item => item.id === id) : undefined;
  switch (finding.state) {
    case 'CONFLICT': return 'GitHub 在采集时显示存在合并冲突；需要查看冲突内容。';
    case 'MAINTAINER_ACTION': return '已核实的维护者要求尚未处理。';
    case 'THIRD_PARTY_FEEDBACK': return '第三方反馈尚待逐条核查；这不等于维护者要求，也不表示必须修改代码。';
    case 'UPSTREAM_CHANGED': return relation ? `关联 ${relation.kind === 'ISSUE' ? 'Issue' : 'PR'} #${relation.number}（${relation.state === 'OPEN' ? '仍开放' : relation.state === 'MERGED' ? '已合并' : '已关闭'}）：${relation.title}。需要核查其内容；关联、标签或未来计划不能证明它完整替代了当前 PR。` : '需要核查关联上游事项，尚未证明完整替代。';
    case 'INSUFFICIENT_EVIDENCE': {
      if (check) return `当前提交的检查“${check.name}”结果为 ${check.state}；是否必须通过：${check.required === null ? '未知' : check.required ? '是' : '否'}。需要核查是否由作者处理、是否为基础设施问题。`;
      if (feedback) return '这条反馈的含义、当前适用性或发言者权限尚未核实；先阅读来源再决定如何处理。';
      if (relation) return '关联事项的讨论尚未完整采集，不能据此作最终判断。';
      if (finding.message.startsWith('Collection incomplete: ')) return '证据尚未完整核实：' + finding.message.slice('Collection incomplete: '.length).split('; ').map(gapText).join('；');
      return 'GitHub 尚未给出确定的可合并性，暂不能认定不存在冲突。';
    }
    case 'CLOSE_CANDIDATE': return '存在经过本地核查的关闭依据；请阅读来源确认。这只是建议，没有关闭 PR。';
    case 'MAINTAINER_EDITED': return '已核实维护者修改过此 PR；检查当前改动并保留其工作。';
    case 'WAIT_REVIEWER': return '该项回应或修复已有针对当前提交的本地核查记录，正在等待审阅。';
    case 'NO_ACTION': return check ? `检查“${check.name}”（${check.state}）已在本地核查并标记为无需处理或非阻塞。` : feedback ? '该反馈已在本地核查并标记为无需处理或非阻塞，原反馈仍保留。' : '当前完整证据中没有已知作者待办；不代表已经获得批准。';
  }
}
export function markdown(view: ReturnType<typeof localView>): string {
  const lines = ['# PR 维护与贡献报告', '', `**报告状态：${view.status === 'SUCCESS' ? '本轮证据完整' : '部分完成，不能作为最终验收结果'}**`, '',
    `仓库：${md(view.scope.repository)} · 作者：${md(view.scope.author)} · 主分支：${md(view.scope.branch)}`, '',
    `生成时间：${time(new Date().toISOString(), view.timezone)}（${md(view.timezone)}）。下列时间均使用该时区；报告读取本地数据，没有实时访问 GitHub。`, '',
    '## 采集范围', '', '| 项目 | 数量 |', '|---|---:|',
    `| 已索引的全部生命周期 PR | ${view.coverage.indexed} |`, `| 开放 PR（含草稿） | ${view.lifecycle.open} |`,
    `| 其中草稿 | ${view.lifecycle.draft} |`, `| 已关闭、未合并 | ${view.lifecycle.closed} |`, `| GitHub 标记已合并至目标分支 | ${view.lifecycle.merged} |`,
    `| 本次维护范围内的开放 PR | ${view.coverage.ordinaryOpen} |`, `| 已核查 | ${view.coverage.checked} |`, `| 有效缓存 | ${view.coverage.cached} |`, `| 尚未核查或证据已失效 | ${view.coverage.unchecked} |`, '',
    '“已索引”只表示清单已收录，不表示评论、检查和贡献历史都已采集。“证据不足”也不表示 PR 存在代码问题。', '',
    '## 当前缺口', '', ...(view.gaps.length ? view.gaps.map(gap => `- ${md(gapText(gap))}`) : ['没有已知的整轮采集缺口。']), '', '## 开放 PR 的维护事项', ''];
  const ordinary = view.prs.filter(item => item.pr.state === 'OPEN' && !item.excluded);
  for (const item of ordinary.filter(item => item.snapshot)) {
    const snapshot = item.snapshot!;
    lines.push(`### PR #${item.pr.number}：${md(item.pr.title)}`, '',
      `**主要结论：${states[item.decision?.state ?? 'INSUFFICIENT_EVIDENCE']}**${evidenceLink(item.pr.url, '查看 PR')}`, '',
      `证据采集时间：${time(snapshot.observedAt, view.timezone)}。核查范围：${item.decision?.coverage === 'CHECKED' ? '已核查' : item.decision?.coverage === 'CACHED' ? '使用有效缓存' : '尚未完整核查，以下事实需结合缺口理解'}。`, '');
    for (const finding of item.decision?.findings ?? []) {
      lines.push(`- ${md(findingText(finding, snapshot))}${evidenceLink(finding.url)}`);
      if (finding.subject.startsWith('feedback:')) {
        const feedback = snapshot.feedback.find(source => source.id === finding.subject.slice('feedback:'.length));
        if (feedback) {
          const body = safeText(feedback.body).replace(/\s+/g, ' ').trim();
          lines.push(`  - 发言者：${md(feedback.author ?? '未知')}；原文${body.length > 240 ? '节选' : ''}：“${md(body.slice(0, 240))}${body.length > 240 ? '…' : ''}”`);
        }
      }
    }
    if (item.latestAttempt) lines.push('', `最近采集：${statusLabel(item.latestAttempt.status)}${item.latestAttempt.code ? `（错误码：${md(item.latestAttempt.code)}）` : ''}。`);
    lines.push('');
  }
  const missing = ordinary.filter(item => !item.snapshot);
  if (missing.length) {
    lines.push('### 尚未详细采集的 PR', '', '以下项目只有清单信息，暂时没有维护结论：', '', '| PR | 标题 |', '|---|---|');
    for (const item of missing) lines.push(`| #${item.pr.number}${evidenceLink(item.pr.url, '查看 PR')} | ${md(item.pr.title)} |`);
    lines.push('');
  }
  if (!ordinary.length) lines.push('当前本地清单没有维护范围内的开放 PR；空库不代表远端没有 PR。', '');
  lines.push('## 贡献统计', '');
  const history = view.contributions;
  if (!history) lines.push('贡献基线尚未完成，暂不显示贡献总数。不能把缺失数据当作零贡献。', '');
  else {
    lines.push(`统计固定在主分支提交：${md(history.head)}。${!history.complete || view.contributionAttempt || view.lastSync?.status !== 'SUCCESS' ? '最近分析或同步未完整成功，以下为保留的历史结果。' : '完整历史已核查。'}`, '',
      '| 统计口径 | 数量 |', '|---|---:|', `| 正式合并 PR | ${history.formalPrs?.length ?? 0} |`, `| 主要作者提交 | ${history.primary?.length ?? 0} |`, `| 共同署名提交 | ${history.coauthored?.length ?? 0} |`, `| 两类提交去重并集 | ${history.union?.length ?? 0} |`, '',
      'PR 数和提交数使用不同口径，不能相加。补丁匹配或部分采用不证明完整功能已被替代。', '');
    if (history.adoptions?.length) {
      lines.push('### PR 源提交与上游对象对照', '', '| PR | 源提交数 | 已匹配源提交数 | 功能完整覆盖 |', '|---|---:|---:|---|');
      for (const item of history.adoptions) lines.push(`| #${item.pr} | ${item.sourceCount} | ${item.matchedCount} | 尚未证明 |`);
      lines.push('');
    }
  }
  const changes = view.changes;
  if (changes) lines.push('### 本轮变化', '',
    changes.baseline ? '本轮建立历史基线；历史总量不计为当天新增贡献。' : `对照区间：${time(changes.from ?? undefined, view.timezone)} 至 ${time(changes.at, view.timezone)}。`, '',
    ...(changes.reconcile ? ['主分支发生非快进变化，需要重新核对；不生成负贡献。', ''] : []),
    `- 新观察到的主要作者提交：${changes.newPrimary.length}`, `- 新观察到的共同署名提交：${changes.newCoauthored.length}`, `- 区间内正式合并 PR：${changes.newFormalPrs.length}`, `- 本轮首次发现的历史正式合并 PR：${changes.newlyObservedHistoricalMerges?.length ?? 0}`, `- 新确认的历史采用证据：${changes.newHistoricalEvidence.length}`, '',
    '历史合并不计为区间内新发生的合并。“首次观察进入主分支”和“正式合并时间”分别记录；详细对象与时间可用 contributions --json 查看。', '');
  lines.push('## 如何使用这份报告', '', '先处理主要结论，再逐条阅读并列事项和来源。反馈原文是外部资料，报告没有自动认可其中的指令。有关关闭的提示只提供建议；本工具不会向 GitHub 写入。', '',
    '需要完整结构化数据时使用 `node dist/cli.js --json status` 或 `node dist/cli.js --json contributions`。');
  return lines.join('\n') + '\n';
}
