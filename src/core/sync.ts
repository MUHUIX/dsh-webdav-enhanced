/*
 * M6 同步引擎（v2）。
 * - 一次同步：扫描（含 hash）→ 读远端 manifest → 三方合并决策 → 逐条执行 → prune → 持久化 lastSynced。
 * - 注入 RunProgressTracker / RunLogger：每个条目的阶段、耗时、原因、字节数都进快照与日志。
 * - 协作式取消：只在条目边界检查标志，绝不在传输中途硬中断。
 * - **任何单条失败只记录、不中断整体**；报告里必有失败明细。
 * - 上传走 dedupeRemote（D9）；删除传播（D8）；D1：只有本轮真正成功的条目才写 lastSynced。
 * - 定时调度 intervalHours（0=关），setInterval 已 unref，不影响宿主进程退出。
 */
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { conflictCopyName, filterByScope, planDecisions } from './merge.js'
import { scanLocal, machineInfo, HashCache } from './scan.js'
import { createInstallerFromOptions, pruneBackupDir } from './install.js'
import { createPackager, hashDirectory } from './pack.js'
import { deleteEntry, pushEntry, pruneRemote, type SyncStore } from './webdav-store.js'
import { RunLogger } from './runlog.js'
import { generateRunId, phaseForAction, RunProgressTracker } from './progress.js'
import { DATA_DIRNAME, type ConfigStore } from './config-store.js'
import {
  DEFAULT_SAFETY_GUARD,
  type EntryKind,
  type Installer,
  type LocalEntry,
  type LogCategory,
  type MachineInfo,
  type MergeDecisionV2,
  type PackMeta,
  type PackedEntry,
  type Packager,
  type PluginConfig,
  type RemoteEntry,
  type ResolvedEnv,
  type RunItem,
  type RunProgress,
  type SyncEngine,
  type SyncOptions,
  type SyncRunReport,
  type SyncSnapshot,
  type SyncTrigger,
  type WebDavClient,
} from '../types.js'

export interface SyncEngineDeps {
  env: ResolvedEnv
  configStore: ConfigStore
  store: SyncStore
  client: WebDavClient
  packager?: Packager
  /** 注入自定义 installer（测试用）；不传则按 syncOptions 每次运行构造 */
  installer?: Installer
  progress?: RunProgressTracker
  logger?: RunLogger
  /** 测试用：临时目录根 */
  tempRoot?: string
  /**
   * v0.5（H-12）：bundle 自动安装入口（宿主注入 pluginManager.installBundle）。
   * 不提供则 bundle 下载后落 manual-needed——绝不 shell 出去。
   */
  installBundleDir?: (dir: string) => Promise<{ ok: boolean; message?: string }>
  /**
   * v0.5（H-12）：定时调度复用 host 层互斥。提供时 startScheduler 每跳
   * 走它而不是直接 runOnce（否则定时同步绕过 runtime.running 互斥）。
   */
  scheduledTrigger?: (trigger: SyncTrigger) => Promise<SyncRunReport>
}

const TRIGGER_LABELS: Record<SyncTrigger, string> = {
  manual: '手动',
  scheduled: '定时',
  'auto-scan': '自动扫描',
}

export function triggerLabel(trigger: SyncTrigger): string {
  return TRIGGER_LABELS[trigger] ?? trigger
}

function nowIso(): string {
  return new Date().toISOString()
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sanitize(name: string): string {
  return name.replace(/[^\w.@+-]+/g, '_').slice(0, 80) || 'entry'
}

function plural(kind: EntryKind): string {
  return `${kind}s`
}

/** 同步选项补默认值（老配置没有 syncOptions 时兜底） */
export function normalizeSyncOptions(raw: Partial<SyncOptions> | undefined): SyncOptions {
  const base: SyncOptions = {
    propagateDeletions: true,
    autoResolve: 'auto',
    dedupeRemote: true,
    autoInstall: true,
    contentMerge: true,
    maxBackups: 10,
    pruneTombstones: true,
    hardDelete: false,
    bulkDeleteGuard: true,
  }
  const merged = { ...base, ...(raw ?? {}) }
  if (typeof merged.maxBackups !== 'number' || !Number.isFinite(merged.maxBackups) || merged.maxBackups < 0) {
    merged.maxBackups = base.maxBackups
  }
  return merged
}

/** 并发冲突时返回的报告（POST /sync 在运行中会直接拦掉，不会走到这里） */
export function createBusyReport(runId: string, trigger: SyncTrigger): SyncRunReport {
  const at = nowIso()
  return {
    runId,
    trigger,
    startedAt: at,
    finishedAt: at,
    uploaded: [],
    downloaded: [],
    merged: [],
    deleted: [],
    skipped: 0,
    deduped: [],
    conflicts: [],
    errors: [{ stage: 'run', message: '同步任务已在运行中' }],
    warnings: [],
    items: [],
    ok: false,
    cancelled: false,
    durationMs: 0,
    needsRestart: [],
  }
}

function emptyReport(runId: string, trigger: SyncTrigger, startedAt: string): SyncRunReport {
  return {
    runId,
    trigger,
    startedAt,
    finishedAt: startedAt,
    uploaded: [],
    downloaded: [],
    merged: [],
    deleted: [],
    skipped: 0,
    deduped: [],
    conflicts: [],
    errors: [],
    warnings: [],
    items: [],
    ok: false,
    cancelled: false,
    durationMs: 0,
    needsRestart: [],
  }
}

type Bucket = 'uploaded' | 'downloaded' | 'merged' | 'deleted' | 'deduped' | 'skipped' | 'conflict'

interface Outcome {
  status: RunItem['status']
  category: LogCategory
  bucket?: Bucket
  reason?: string
  detail?: string
  bytes?: number
  /** 本轮真正写成功的内容 hash → 记入 lastSynced（D1） */
  synced?: { hash: string; version: string | null; installed?: boolean }
  /** 该 key 从 lastSynced 移除（删除传播完成） */
  remove?: boolean
  /** bundle 安装成功待重启 */
  needsRestart?: boolean
  /** 需要进报告 errors 的错误原文 */
  error?: string
  /** 进度卡一句话状态 */
  summary?: string
}

interface RunContext {
  cfg: PluginConfig
  options: SyncOptions
  installer: Installer
  tmpRoot: string
  report: SyncRunReport
}

export class SyncEngineImpl implements SyncEngine {
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private currentRun: string | null = null
  private lastReportValue: SyncRunReport | null = null
  private syncedThisRun: Record<string, SyncSnapshot> = {}
  private removedThisRun: string[] = []
  private bulkConfirm = false
  private readonly packager: Packager
  private readonly tracker: RunProgressTracker
  private readonly logger: RunLogger

  constructor(private readonly deps: SyncEngineDeps) {
    this.packager = deps.packager ?? createPackager()
    this.tracker = deps.progress ?? new RunProgressTracker()
    this.logger = deps.logger ?? new RunLogger(deps.env.dshHome || tmpdir())
  }

  private cfg(): PluginConfig {
    return this.deps.configStore.load()
  }

  private dataDir(): string {
    // v0.5（M-10）：数据根只认解析出的 dshHome；解析不出来直接抛，
    // 绝不把 backups/staging/日志写进宿主进程 CWD。
    if (!this.deps.env.dshHome) throw new Error('dshHome 未解析：拒绝在未知数据根下写入')
    return path.join(this.deps.env.dshHome, DATA_DIRNAME)
  }

  // ---------- run ----------

  async runOnce(trigger: SyncTrigger, opts: { runId?: string; confirmBulkDelete?: boolean } = {}): Promise<SyncRunReport> {
    const startedAt = nowIso()
    if (this.running) {
      return createBusyReport(opts.runId ?? this.currentRun ?? generateRunId(), trigger)
    }
    const runId = opts.runId ?? generateRunId()
    this.running = true
    this.currentRun = runId
    this.syncedThisRun = {}
    this.removedThisRun = []
    this.bulkConfirm = opts.confirmBulkDelete === true
    this.tracker.start({ runId, trigger })
    const report = emptyReport(runId, trigger, startedAt)
    this.logger.info('sync', `开始同步（${triggerLabel(trigger)}）`, { runId })

    try {
      await this.doRun(report)
      report.ok = report.errors.length === 0 && !report.cancelled
    } catch (err) {
      report.errors.push({ stage: 'fatal', message: errMsg(err) })
      report.ok = false
      this.logger.error('sync', `同步异常终止：${errMsg(err)}`, { runId })
    } finally {
      report.finishedAt = nowIso()
      report.durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(startedAt))
      this.running = false
      this.currentRun = null
      // D1：只把本轮真正同步成功的条目写进 lastSynced（含 version/syncedAt/machineId）
      try {
        this.persistSynced(report)
      } catch (err) {
        report.errors.push({ stage: 'persist', message: `保存同步状态失败：${errMsg(err)}` })
        report.ok = false
      }
      report.items = this.tracker.snapshot().items
      this.lastReportValue = report
      const message = summarize(report)
      this.tracker.finish({ ok: report.ok, cancelled: report.cancelled, report, message })
      if (report.ok) this.logger.success('sync', message, { runId })
      else if (report.cancelled) this.logger.warn('sync', message, { runId })
      else this.logger.warn('sync', message, { runId })
    }
    return report
  }

  private async doRun(report: SyncRunReport): Promise<void> {
    const cfg = this.cfg()
    const options = normalizeSyncOptions(cfg.syncOptions)
    const direction = cfg.schedule.direction

    // 0) 本轮远端清单缓存复位（v0.5：N 条目不再 N×(2 GET)）
    this.deps.store.beginRun()

    const tmpRoot = await mkdtemp(path.join(this.deps.tempRoot ?? tmpdir(), 'dsh-sync-'))
    try {
      // 1) 扫描（v2：扫描期就算真实 hash，D1/D2）
      this.tracker.phase('scan', '正在扫描本地条目')
      const scanIssues: { stage: string; message: string; warn?: boolean }[] = []
      const localEntries = await scanLocal(this.deps.env, cfg.scope, scanIssues, {
        cache: this.deps.env.dshHome ? new HashCache(this.deps.env.dshHome) : null,
      })
      for (const e of scanIssues) {
        if (e.warn) {
          report.warnings.push({ stage: e.stage, message: e.message })
          this.logger.warn('sync', `扫描告警：${e.message}`, { runId: report.runId })
        } else {
          report.errors.push({ stage: e.stage, message: e.message })
          this.logger.warn('sync', `扫描错误：${e.message}`, { runId: report.runId })
        }
      }
      const self = machineInfo(this.deps.env, cfg.machineId)
      for (const e of localEntries) e.machine = self
      this.logger.info('sync', `本地扫描完成：${localEntries.length} 个条目`, { runId: report.runId })
      if (this.checkCancel(report)) return

      // 2) 读远端清单。store.read 现在**不会**把失败伪装成空清单：
      //    任何非 404 的读取失败 / 结构非法 → 上抛，本轮直接终止（C-4 修复）。
      this.tracker.phase('manifest', '正在读取远端清单')
      const { manifest: remote, dropped } = await this.deps.store.read()
      for (const d of dropped) {
        report.warnings.push({ stage: 'manifest-validate', message: `远端清单条目 ${d.name} 非法已忽略：${d.why}` })
      }
      const alive = remote.entries.filter((e) => !e.deleted).length
      this.logger.info('sync', `远端清单：${alive} 个条目（墓碑 ${remote.entries.length - alive} 个）`, {
        runId: report.runId,
      })
      if (this.checkCancel(report)) return

      // installer：每轮构造，带 link 保护名单与宿主安装入口
      const linkSourceDirs = localEntries
        .filter((e) => e.kind === 'bundle' && !this.isManagedLocalPath(e.sourceDir))
        .map((e) => e.sourceDir)
      const installer =
        this.deps.installer ??
        createInstallerFromOptions(this.deps.env, options, {
          installBundleDir: this.deps.installBundleDir,
          linkSourceDirs,
        })

      // 3) 三方合并 + 方向过滤 + 同步范围过滤
      this.tracker.phase('plan', '正在生成同步计划')
      let decisions = filterByScope(
        planDecisions({
          local: localEntries,
          remote,
          lastSynced: cfg.lastSynced ?? {},
          policy: cfg.conflictPolicy,
          options: {
            autoResolve: options.autoResolve,
            propagateDeletions: options.propagateDeletions,
            autoInstall: options.autoInstall,
          },
          direction,
          machineId: cfg.machineId,
        }),
        cfg.scope,
      )

      // 3.5) 批量删除护栏（C-4/C-5 兜底）：一轮内 delete-local 数量异常多
      //      几乎必然是"远端读残/被覆盖"，未经确认整批阻断。
      decisions = this.applyBulkDeleteGuard(decisions, alive, report)

      this.tracker.setItems(
        decisions.map((d) => ({
          key: d.key,
          kind: d.kind,
          name: d.name,
          action: d.action,
          status: 'pending' as const,
          reason: d.reason,
        })),
      )
      this.logger.info('sync', `同步计划：共 ${decisions.length} 项`, { runId: report.runId })

      const ctx: RunContext = { cfg, options, installer, tmpRoot, report }
      for (const d of decisions) {
        if (this.tracker.isCancelRequested()) {
          report.cancelled = true
          break
        }
        await this.executeOne(d, ctx)
      }
      if (this.tracker.isCancelRequested()) report.cancelled = true

      // 4) prune：清理超期 trash（hardDelete 时连墓碑一起物理删）
      if (!report.cancelled && options.pruneTombstones) {
        this.tracker.phase('prune', '正在清理远端回收站')
        try {
          const pruned = await pruneRemote(this.deps.store, this.deps.client, {
            hardDelete: options.hardDelete,
          })
          if (pruned.trashRemoved || pruned.tombstonesRemoved) {
            this.logger.info(
              'prune',
              `远端清理完成：回收站 ${pruned.trashRemoved} 项，墓碑 ${pruned.tombstonesRemoved} 项`,
              { runId: report.runId },
            )
          }
          if (pruned.trashUnknownAge > 0) {
            report.warnings.push({
              stage: 'prune',
              message: `回收站有 ${pruned.trashUnknownAge} 个文件无法判定年龄，本轮保留（不冒险删除）`,
            })
          }
        } catch (err) {
          // prune 失败只记警告，不影响本轮结果
          this.logger.warn('prune', `远端清理失败（不影响本轮结果）：${errMsg(err)}`, { runId: report.runId })
        }
      }

      // 5) finalize
      this.tracker.phase('finalize', '正在保存同步状态')
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * 删除传播的本地侧护栏（v0.5）。触发条件（bulkDeleteGuard=true 且本轮未确认）：
   * delete-local 决策 > 3 条 且 > 远端存活数的 30%。被阻断的条目转 skipped 并记 error，
   * 提示用户在设置页「危险区」旁确认或调整护栏开关。
   */
  private applyBulkDeleteGuard(
    decisions: MergeDecisionV2[],
    remoteAlive: number,
    report: SyncRunReport,
  ): MergeDecisionV2[] {
    const toDelete = decisions.filter((d) => d.action === 'delete-local')
    if (toDelete.length === 0) return decisions
    const threshold = Math.max(3, Math.ceil(remoteAlive * 0.3))
    if (!this.bulkConfirm && toDelete.length > threshold) {
      report.errors.push({
        stage: 'bulk-delete-guard',
        message: `本轮将删除本机 ${toDelete.length} 个条目（阈值 ${threshold}），已整批阻断。若确属预期（例如刚重置远端），请确认后重跑并携带 confirmBulkDelete`,
      })
      return decisions.map((d) =>
        d.action === 'delete-local'
          ? { ...d, action: 'skip' as const, winner: undefined, reason: '批量删除护栏：本轮已阻断，等待确认' }
          : d,
      )
    }
    return decisions
  }

  /** sourceDir 是否处于"本插件可管理"的本地根内（profileDir/node_modules 或任一 skillRoot） */
  private isManagedLocalPath(sourceDir: string): boolean {
    const env = this.deps.env
    if (!sourceDir) return false
    const roots = [
      env.profileDir ? path.join(env.profileDir, 'node_modules') : '',
      env.skillsDir,
      ...(env.skillRoots ?? []),
    ].filter(Boolean)
    const abs = path.resolve(sourceDir)
    return roots.some((r) => {
      const root = path.resolve(r)
      return abs === root || abs.startsWith(root + path.sep)
    })
  }

  private checkCancel(report: SyncRunReport): boolean {
    if (!this.tracker.isCancelRequested()) return false
    report.cancelled = true
    this.tracker.phase('cancelled', '同步已取消')
    this.logger.warn('sync', '同步已取消（在条目边界停止）', { runId: report.runId })
    return true
  }

  // ---------- 单条目执行 ----------

  private async executeOne(d: MergeDecisionV2, ctx: RunContext): Promise<void> {
    const started = Date.now()
    this.tracker.updateItem(d.key, { status: 'running', reason: d.reason })
    this.tracker.phase(phaseForAction(d.action, d.winner), this.actionMessage(d))
    try {
      const outcome = await this.applyDecision(d, ctx)
      const durationMs = Date.now() - started
      this.tracker.updateItem(d.key, {
        status: outcome.status,
        reason: outcome.reason ?? d.reason,
        detail: outcome.detail,
        bytes: outcome.bytes,
        durationMs,
      })
      this.recordOutcome(d, outcome, ctx)
      this.logOutcome(d, outcome, ctx)
    } catch (err) {
      const message = errMsg(err)
      this.tracker.updateItem(d.key, { status: 'failed', detail: message, durationMs: Date.now() - started })
      ctx.report.errors.push({ stage: d.action, message: `${d.key}: ${message}`, name: d.name })
      this.logger.error(this.categoryOf(d.action), `${d.name} 处理失败：${message}`, {
        name: d.name,
        runId: ctx.report.runId,
        detail: d.reason,
      })
    }
  }

  private recordOutcome(d: MergeDecisionV2, outcome: Outcome, ctx: RunContext): void {
    const report = ctx.report
    switch (outcome.bucket) {
      case 'uploaded':
        report.uploaded.push(d.key)
        break
      case 'downloaded':
        report.downloaded.push(d.key)
        break
      case 'merged':
        report.merged.push(d.key)
        break
      case 'deleted':
        report.deleted.push(d.key)
        break
      case 'deduped':
        report.deduped.push(d.key)
        this.tracker.markDeduped(d.key)
        break
      case 'skipped':
        report.skipped += 1
        break
      case 'conflict':
        report.conflicts.push({ name: d.name, note: outcome.reason ?? d.reason })
        break
      default:
        break
    }
    if (outcome.needsRestart) {
      if (!report.needsRestart) report.needsRestart = []
      report.needsRestart.push(d.key)
    }
    if (outcome.synced) {
      const snap: SyncSnapshot = {
        hash: outcome.synced.hash,
        version: outcome.synced.version,
        syncedAt: new Date().toISOString(),
        machineId: ctx.cfg.machineId,
      }
      if (outcome.synced.installed === false) snap.installed = false
      this.syncedThisRun[d.key] = snap
    }
    if (outcome.remove) this.removedThisRun.push(d.key)
    if (outcome.error) {
      ctx.report.errors.push({ stage: d.action, message: `${d.key}: ${outcome.error}`, name: d.name })
      this.logger.error(this.categoryOf(d.action), `${d.name} 处理失败：${outcome.error}`, {
        name: d.name,
        runId: report.runId,
      })
    }
    if (outcome.summary) this.tracker.message(outcome.summary)
  }

  private logOutcome(d: MergeDecisionV2, outcome: Outcome, ctx: RunContext): void {
    const runId = ctx.report.runId
    switch (outcome.bucket) {
      case 'uploaded':
        this.logger.success('upload', `已上传：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'downloaded':
        this.logger.success('download', `已下载：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'merged':
        this.logger.success('merge', `已自动合并：${d.name}`, {
          name: d.name,
          runId,
          detail: outcome.reason,
        })
        break
      case 'deduped':
        this.logger.success('dedupe', `远端已有同内容，复用文件：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'deleted':
        this.logger.success('delete', `已传播删除：${d.name}`, { name: d.name, runId, detail: outcome.detail })
        break
      case 'conflict':
        this.logger.warn('conflict', `保留冲突待人工处理：${d.name}`, { name: d.name, runId, detail: outcome.reason })
        break
      case 'skipped':
        if (outcome.status === 'skipped') {
          this.logger.info('skip', `跳过：${d.name}（${outcome.reason ?? d.reason}）`, { name: d.name, runId })
        }
        break
      default:
        break
    }
  }

  private actionMessage(d: MergeDecisionV2): string {
    switch (d.action) {
      case 'upload':
        return `正在上传：${d.name}`
      case 'download':
        return `正在下载：${d.name}`
      case 'merge':
        return d.winner === 'local' ? `正在自动合并（采用本机）：${d.name}` : `正在自动合并（采用远端）：${d.name}`
      case 'delete-local':
        return `正在删除本机条目：${d.name}`
      case 'delete-remote':
        return `正在删除远端条目：${d.name}`
      case 'conflict':
        return `记录冲突：${d.name}`
      default:
        return d.reason
    }
  }

  private categoryOf(action: MergeDecisionV2['action']): LogCategory {
    switch (action) {
      case 'upload':
        return 'upload'
      case 'download':
        return 'download'
      case 'merge':
        return 'merge'
      case 'delete-local':
      case 'delete-remote':
        return 'delete'
      case 'conflict':
        return 'conflict'
      default:
        return 'skip'
    }
  }

  private async applyDecision(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    switch (d.action) {
      case 'skip':
        return this.applySkip(d)
      case 'upload':
        return this.applyUpload(d, ctx)
      case 'download':
        return this.applyDownload(d, ctx)
      case 'merge':
        return d.winner === 'local' ? this.applyMergeLocalWins(d, ctx) : this.applyMergeRemoteWins(d, ctx)
      case 'delete-local':
        return this.applyDeleteLocal(d, ctx)
      case 'delete-remote':
        return this.applyDeleteRemote(d, ctx)
      case 'conflict':
      default:
        return this.applyConflict(d, ctx)
    }
  }

  private applySkip(d: MergeDecisionV2): Outcome {
    // 只有"两端确实一致"的 skip 才刷新 base；方向过滤 / 未开启删除传播的 skip 不刷新
    const consistent = !!(d.local && d.remote && d.local.hash === d.remote.hash)
    return {
      status: 'skipped',
      bucket: 'skipped',
      category: 'skip',
      reason: d.reason,
      synced: consistent ? { hash: d.local!.hash, version: d.local!.version } : undefined,
    }
  }

  private async applyUpload(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const entry = d.local!
    const staging = await mkdtemp(path.join(ctx.tmpRoot, 'pack-'))
    const packed = await this.packager.pack(entry, staging)
    const res = await pushEntry(this.deps.store, this.deps.client, {
      entry: {
        kind: entry.kind,
        name: entry.name,
        version: entry.version,
        hash: packed.sha256,
        zipHash: packed.zipHash,
        size: packed.size,
        source: machineInfo(this.deps.env, ctx.cfg.machineId) as MachineInfo,
      },
      zipPath: packed.zipPath,
      machineId: ctx.cfg.machineId,
      dedupeRemote: ctx.options.dedupeRemote,
    })
    if (res.deduped) {
      return {
        status: 'ok',
        bucket: 'deduped',
        category: 'dedupe',
        bytes: packed.size,
        reason: `${d.reason}；远端已有同内容文件，复用`,
        detail: `复用远端文件：${res.file}`,
        synced: { hash: packed.sha256, version: entry.version },
        summary: `已复用远端同内容：${entry.name}`,
      }
    }
    if (!res.uploaded) {
      return {
        status: 'skipped',
        bucket: 'skipped',
        category: 'skip',
        bytes: packed.size,
        reason: `${d.reason}；远端清单已有相同内容`,
        detail: `远端文件：${res.file}`,
        synced: { hash: packed.sha256, version: entry.version },
      }
    }
    return {
      status: 'ok',
      bucket: 'uploaded',
      category: 'upload',
      bytes: packed.size,
      synced: { hash: packed.sha256, version: entry.version },
      detail: `远端文件：${res.file}`,
      summary: `已上传：${entry.name}`,
    }
  }

  private async applyDownload(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const remote = d.remote!
    const zipPath = path.join(ctx.tmpRoot, `dl-${sanitize(remote.name)}-${remote.hash.slice(0, 8)}.zip`)
    // 1) 下载并校验 zip 本体（v0.5，H-8：README 的"下载后逐份校验"从宣称变成实现；
    //    旧清单无 zipHash → 退化为体积校验 + 第 3 步的内容 hash 复核）
    await this.deps.client.getFile(remote.file, zipPath, {
      expectedSize: remote.size,
      sha256: remote.zipHash,
    })
    // 2) 解包（护栏：路径穿越 / 实际字节计数 / 条目数）
    const unpackDir = path.join(ctx.tmpRoot, `unpack-${sanitize(remote.kind)}-${sanitize(remote.name)}`)
    const meta = await this.packager.unpack(zipPath, unpackDir, DEFAULT_SAFETY_GUARD)
    // 3) 内容 hash 复核：解包目录按清单身份重算，必须等于 remote.hash——
    //    这同时兜住了"无 zipHash 的旧包"与"清单被篡改指向别的文件"两类风险
    if (remote.hash && /^[0-9a-f]{64}$/.test(remote.hash)) {
      const recomputed = await hashDirectory({ kind: remote.kind, name: remote.name, version: remote.version, sourceDir: unpackDir })
      if (recomputed !== remote.hash) {
        throw new Error(`内容 hash 复核失败：${remote.name}（解包内容与清单不符，拒绝安装）`)
      }
    }
    // 4) 身份交叉校验 + 按**清单侧 kind** 路由（不信包内自述）
    if (meta.kind !== remote.kind || meta.name !== remote.name) {
      return {
        status: 'failed',
        category: 'download',
        error: `包内 _meta（${meta.kind}:${meta.name}）与清单条目（${remote.kind}:${remote.name}）不符，已拒绝安装`,
      }
    }
    const packed: PackedEntry = {
      entry: {
        kind: remote.kind,
        name: remote.name,
        version: remote.version,
        sourceDir: '',
        hash: remote.hash,
        sizeBytes: remote.size,
        modifiedAt: new Date().toISOString(),
      },
      zipPath,
      sha256: remote.hash,
      zipHash: remote.zipHash ?? '',
      size: remote.size,
    }
    if (!ctx.options.autoInstall) {
      // M-15：登记"已同步未安装"，开启自动安装后由决策层补装，不再每轮重复下载
      return {
        status: 'skipped',
        category: 'download',
        bytes: remote.size,
        synced: { hash: remote.hash, version: remote.version, installed: false },
        reason: `${d.reason}；已下载但 autoInstall 关闭，未安装`,
        detail: `临时包：${zipPath}`,
      }
    }
    const result = await this.applyByKind(meta, packed, ctx.installer)
    const synced = { hash: remote.hash, version: remote.version }
    switch (result.status) {
      case 'applied':
        return {
          status: 'ok',
          bucket: 'downloaded',
          category: 'download',
          bytes: remote.size,
          synced,
          detail: result.message,
          summary: `已下载安装：${remote.name}`,
        }
      case 'needs-restart':
        return {
          status: 'ok',
          bucket: 'downloaded',
          category: 'download',
          bytes: remote.size,
          synced,
          needsRestart: true,
          detail: `${result.message}（重启 dsh 后生效）`,
          summary: `已下载安装：${remote.name}（待重启生效）`,
        }
      case 'skipped':
        return {
          status: 'ok',
          category: 'download',
          bytes: remote.size,
          synced,
          reason: `${d.reason}；${result.message}`,
          detail: result.message,
        }
      case 'manual-needed':
        return {
          status: 'failed',
          category: 'download',
          bytes: remote.size,
          reason: `${d.reason}；需要手动安装`,
          detail: result.manualCommand ?? result.message,
          error: result.message,
        }
      case 'failed':
      default:
        return {
          status: 'failed',
          category: 'download',
          bytes: remote.size,
          reason: `${d.reason}；安装失败`,
          detail: result.message,
          error: result.message,
        }
    }
  }

  private async applyMergeRemoteWins(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const local = d.local!
    let detail: string | undefined
    try {
      const backupPath = await this.backupLocalEntry(local, ctx)
      detail = `本机旧版本已备份：${backupPath}`
      this.logger.info('merge', `已备份本机旧版本：${local.name}`, { name: local.name, runId: ctx.report.runId, detail: backupPath })
    } catch (err) {
      detail = `本机备份失败（继续按远端版本合并）：${errMsg(err)}`
      this.logger.warn('merge', `备份本机旧版本失败：${local.name}`, { name: local.name, runId: ctx.report.runId })
    }
    const outcome = await this.applyDownload({ ...d, action: 'download' }, ctx)
    return {
      ...outcome,
      status: outcome.status === 'ok' ? 'merged' : outcome.status,
      bucket: outcome.bucket === 'downloaded' ? 'merged' : outcome.bucket,
      category: 'merge',
      reason: d.reason,
      detail: [outcome.detail, detail].filter(Boolean).join('；'),
    }
  }

  private async applyMergeLocalWins(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const remote = d.remote!
    let detail = ''
    try {
      const backupPath = await this.backupRemoteEntry(remote, ctx)
      detail = `远端旧版本已备份：${backupPath}`
      this.logger.info('merge', `已备份远端旧版本：${remote.name}`, { name: remote.name, runId: ctx.report.runId, detail: backupPath })
    } catch (err) {
      detail = `远端备份失败（继续按本机版本合并）：${errMsg(err)}`
      this.logger.warn('merge', `备份远端旧版本失败：${remote.name}`, { name: remote.name, runId: ctx.report.runId })
    }
    const outcome = await this.applyUpload({ ...d, action: 'upload' }, ctx)
    return {
      ...outcome,
      status: outcome.status === 'ok' ? 'merged' : outcome.status,
      bucket: outcome.bucket === 'uploaded' || outcome.bucket === 'deduped' ? 'merged' : outcome.bucket,
      category: 'merge',
      reason: d.reason,
      detail: [outcome.detail, detail].filter(Boolean).join('；'),
    }
  }

  private async applyDeleteLocal(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const entry = d.local!
    if (entry.kind === 'config') {
      // 配置是"多个顶层 key 的合体"，远端墓碑无法确定该删哪些 key → 保守保留本机
      return {
        status: 'skipped',
        bucket: 'skipped',
        category: 'skip',
        reason: '配置类不支持自动删除顶层 key，已保留本机',
        detail: '如需删除请手动编辑 settings.yaml（同步前已备份原值）',
      }
    }
    // v0.5（C-5）：只允许删除"本插件管理范围内"的目录——profile 的
    // node_modules 子树或技能根。link 安装的 bundle 是开发者工作区，
    // 绝不允许被一次误判整目录搬走。
    if (!this.isManagedLocalPath(entry.sourceDir)) {
      return {
        status: 'failed',
        category: 'delete',
        error: `拒绝删除：${entry.name} 的目录不在 profile/skills 管理范围内（疑似 link 安装的开发目录）：${entry.sourceDir}`,
      }
    }
    const bakDir = path.join(this.dataDir(), 'backups', plural(entry.kind), conflictCopyName(entry.name, ctx.cfg.machineId))
    await mkdir(path.dirname(bakDir), { recursive: true })
    let detail: string
    try {
      await rename(entry.sourceDir, bakDir)
      detail = `已移入备份：${bakDir}`
    } catch {
      await cp(entry.sourceDir, bakDir, { recursive: true })
      await rm(entry.sourceDir, { recursive: true, force: true })
      detail = `已复制到备份：${bakDir}`
    }
    this.rotateBackups(entry.kind, ctx.options.maxBackups)
    return {
      status: 'deleted',
      bucket: 'deleted',
      category: 'delete',
      remove: true,
      reason: d.reason,
      detail,
      summary: `已删除本机条目：${entry.name}`,
    }
  }

  private async applyDeleteRemote(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const remote = d.remote!
    await deleteEntry(this.deps.store, this.deps.client, remote.kind, remote.name, ctx.cfg.machineId)
    return {
      status: 'deleted',
      bucket: 'deleted',
      category: 'delete',
      remove: true,
      reason: d.reason,
      detail: `远端文件已移入回收站：${remote.file}`,
      summary: `已删除远端条目：${remote.name}`,
    }
  }

  private async applyConflict(d: MergeDecisionV2, ctx: RunContext): Promise<Outcome> {
    const local = d.local
    let detail: string | undefined
    if (local) {
      try {
        detail = `本机版本已备份：${await this.backupLocalEntry(local, ctx)}`
      } catch (err) {
        detail = `本机备份失败：${errMsg(err)}`
      }
    }
    return {
      status: 'conflict',
      bucket: 'conflict',
      category: 'conflict',
      reason: d.reason,
      detail,
      summary: `冲突待处理：${d.name}`,
    }
  }

  // ---------- 备份 ----------

  private async backupLocalEntry(entry: LocalEntry, ctx: RunContext): Promise<string> {
    // v0.5（M-7）：同一 kind/name 若已有"同内容"的备份，本轮不再重复打包——
    // ask/manual 冲突每轮重演不会把备份目录刷爆，也不会挤掉别的条目的副本
    const seenPath = path.join(this.dataDir(), 'backups', plural(entry.kind), `.${sanitize(entry.name)}.last-backuped`)
    try {
      if (existsSync(seenPath) && readFileSync(seenPath, 'utf8').trim() === entry.hash) {
        return '（同内容本机版本此前已备份，本轮跳过）'
      }
    } catch {
      /* 标记读失败按未备份处理 */
    }
    const dir = path.join(this.dataDir(), 'backups', plural(entry.kind), conflictCopyName(entry.name, ctx.cfg.machineId))
    await mkdir(dir, { recursive: true })
    const packed = await this.packager.pack(entry, dir)
    this.rotateBackups(entry.kind, ctx.options.maxBackups)
    try {
      writeFileSync(seenPath, entry.hash, 'utf8')
    } catch {
      /* 尽力而为 */
    }
    return packed.zipPath
  }

  private async backupRemoteEntry(remote: RemoteEntry, ctx: RunContext): Promise<string> {
    const dir = path.join(this.dataDir(), 'backups', plural(remote.kind), conflictCopyName(remote.name, ctx.cfg.machineId))
    await mkdir(dir, { recursive: true })
    const zipPath = path.join(dir, `${sanitize(remote.name)}-${remote.hash.slice(0, 8)}.zip`)
    await this.deps.client.getFile(remote.file, zipPath)
    this.rotateBackups(remote.kind, ctx.options.maxBackups)
    return zipPath
  }

  private rotateBackups(kind: EntryKind, maxBackups: number): void {
    if (!(maxBackups >= 0)) return
    pruneBackupDir(path.join(this.dataDir(), 'backups', plural(kind)), maxBackups)
  }

  private async applyByKind(meta: PackMeta, packed: PackedEntry, installer: Installer) {
    // 路由按**清单侧 kind**（packed.entry.kind，已在 applyDownload 与 _meta 交叉校验），
    // 不再采信包内自述的 meta.kind（C-1：防 kind 伪造换安装通道）
    const kind = packed.entry.kind
    if (kind === 'bundle') return installer.applyBundle(packed, meta)
    if (kind === 'skill') return installer.applySkill(packed, meta)
    if (kind === 'config') return installer.applyConfig(packed, meta)
    return { status: 'failed' as const, message: `unknown kind: ${String(kind)}` }
  }

  // ---------- 持久化 ----------

  /** D1：只持久化"本轮实际同步成功"的条目真实 hash（含 version / syncedAt / machineId） */
  private persistSynced(report: SyncRunReport): void {
    const cfg = this.cfg()
    const next: Record<string, SyncSnapshot> = { ...(cfg.lastSynced ?? {}) }
    for (const key of this.removedThisRun) delete next[key]
    for (const [key, snap] of Object.entries(this.syncedThisRun)) next[key] = snap
    this.deps.configStore.update({ lastSynced: next, lastSyncAt: report.finishedAt })
  }

  // ---------- 调度 ----------

  startScheduler(intervalHours: number, onReport: (r: SyncRunReport) => void): void {
    this.stopScheduler()
    if (!Number.isFinite(intervalHours) || intervalHours <= 0) return
    const ms = Math.max(60_000, intervalHours * 60 * 60 * 1000)
    this.timer = setInterval(() => {
      if (this.running) return
      const kickoff = (): Promise<SyncRunReport> =>
        this.deps.scheduledTrigger ? this.deps.scheduledTrigger('scheduled') : this.runOnce('scheduled')
      void kickoff()
        .then((r) => {
          try {
            onReport(r)
          } catch {
            /* 回调异常不影响调度器 */
          }
        })
        .catch(() => undefined)
    }, ms)
    // unref：不阻止宿主进程退出
    const timer = this.timer as unknown as { unref?: () => void }
    if (typeof timer?.unref === 'function') timer.unref()
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ---------- 状态查询 ----------

  isRunning(): boolean {
    return this.running
  }

  cancel(): boolean {
    return this.tracker.cancel()
  }

  currentRunId(): string | null {
    return this.currentRun
  }

  lastReport(): SyncRunReport | null {
    return this.lastReportValue
  }

  progress(): RunProgress {
    return this.tracker.snapshot()
  }
}

function summarize(report: SyncRunReport): string {
  const parts = [
    `上传 ${report.uploaded.length}`,
    `下载 ${report.downloaded.length}`,
    `合并 ${report.merged.length}`,
    `删除 ${report.deleted.length}`,
    `跳过 ${report.skipped}`,
    `失败 ${report.errors.length}`,
  ]
  if (report.deduped.length > 0) parts.push(`去重 ${report.deduped.length}`)
  const head = report.cancelled ? '同步已取消' : report.ok ? '同步完成' : '同步结束（有失败项）'
  return `${head}：${parts.join('，')}`
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  return new SyncEngineImpl(deps)
}

export type { ConfigStore, ResolvedEnv }
