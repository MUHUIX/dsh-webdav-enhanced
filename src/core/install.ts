/*
 * M8 落盘与自动安装（v0.5：安装路径建立完整信任边界）。
 * - skill：解压到 skills 规范目录（含路径穿越防护、备份轮转）。
 * - bundle：解压到暂存目录 → 安装；安装器**优先走宿主 pluginManager 服务**
 *   （deps.installBundleDir 注入），不可用时只落 manual-needed，
 *   不再 execFile('dsh', {shell:true})（C-2：Windows cmd 注入面）。
 * - config：**按顶层 key 合并** settings.yaml（D6 修复），写前备份、备份按 maxBackups 轮转。
 * - v0.5 硬约束：
 *   1) 远端 `meta.name/kind` 必须与清单条目逐项一致，且 name 过 isSafeEntryName；
 *   2) 一切落盘目标 resolve 后必须断言在允许根内（assertWithin）；
 *   3) maxBackups 最低按 1 处理——「保留 0 份」会把刚建立的备份删掉（M-11）。
 * 幂等：重复执行不产生副作用。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createPackager } from './pack.js'
import { isSafeEntryName } from './manifest.js'
import type {
  ApplyResult,
  Installer,
  PackMeta,
  PackedEntry,
  ResolvedEnv,
  SyncOptions,
} from '../types.js'
import { DEFAULT_SAFETY_GUARD } from '../types.js'

export interface InstallerOptions {
  /** 每类条目保留的本地备份份数（默认 10；最低按 1 处理） */
  maxBackups?: number
  /** config 是否按顶层 key 合并（默认 true；false 时整文件覆盖，仍然先备份） */
  contentMerge?: boolean
  /** 期望的条目身份（来自远端 manifest 条目）：与包内 _meta 交叉校验 */
  expected?: { kind: PackMeta['kind']; name: string }
  /** bundle 安装器：优先 pluginManager 服务注入；缺省走 manual-needed */
  installBundleDir?: (dir: string) => Promise<{ ok: boolean; message?: string }>
  /** link 安装的插件源码目录：applyBundle 拒绝把 link 目标覆盖为远端内容 */
  linkSourceDirs?: string[]
}

/** resolve 后断言 child 在 root 内（含 root 本身）；越界即抛 */
export function assertWithin(root: string, child: string, label: string): string {
  const r = path.resolve(root)
  const c = path.resolve(child)
  if (c !== r && !c.startsWith(r + path.sep)) {
    throw new Error(`unsafe ${label} path escapes ${root}: ${child}`)
  }
  return c
}

// ---------- settings.yaml 顶层 key 合并（纯函数，可单测） ----------

const TOP_KEY = /^([A-Za-z_][\w.-]*)\s*:/

interface RawBlock {
  key: string
  lines: string[]
}

/** 把文本拆成 [头部行, blocks]（头部 = 第一个顶层 key 之前的注释/空行） */
function splitWithHeader(raw: string): { header: string[]; blocks: RawBlock[] } {
  const lines = raw.split(/\r?\n/)
  const header: string[] = []
  const blocks: RawBlock[] = []
  let cur: RawBlock | null = null
  for (const line of lines) {
    const m = line.match(TOP_KEY)
    if (m && !/^\s/.test(line)) {
      if (cur) blocks.push(cur)
      cur = { key: m[1], lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      header.push(line)
    }
  }
  if (cur) blocks.push(cur)
  return { header, blocks }
}

/**
 * 顶层 key 合并：远端有的 key 覆盖同名本地 key，远端没有的本地 key 原样保留；
 * 本地没有而远端有的 key 追加到末尾。顺序稳定（本地顺序优先）。
 * 这是 D6 的核心：绝不整文件覆盖，避免丢掉本机其它顶层配置。
 */
export function mergeTopLevelConfig(localRaw: string, remoteRaw: string): string {
  const local = splitWithHeader(localRaw)
  const remote = splitWithHeader(remoteRaw)
  // 远端没有可合并的顶层 key（空文件/只有注释）：本地原样返回，避免无意义的格式漂移
  if (local.blocks.length === 0 && remote.blocks.length === 0) return localRaw
  if (remote.blocks.length === 0) return localRaw
  const pending = new Map(remote.blocks.map((b) => [b.key, b]))
  const out: string[] = [...local.header]
  const pushBlock = (lines: string[]): void => {
    const trimmed = [...lines]
    // 块内尾部的空行只是分隔符，统一由 pushBlock 重新补一个空行
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop()
    out.push(...trimmed, '')
  }
  for (const block of local.blocks) {
    const replace = pending.get(block.key)
    if (replace) {
      pushBlock(replace.lines)
      pending.delete(block.key)
    } else {
      pushBlock(block.lines)
    }
  }
  for (const block of remote.blocks) {
    if (!pending.has(block.key)) continue
    pushBlock(block.lines)
    pending.delete(block.key)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n') + '\n'
}

/**
 * 删除超过 keep 份的最旧备份（按 mtime 从新到旧排序，保留前 keep 个）。
 * @param prefix 只处理这些名字的备份（防止误删同目录其它文件）
 */
export function pruneBackupDir(dir: string, keep: number, prefix = ''): string[] {
  const removed: string[] = []
  const keepN = Math.max(1, Math.floor(Number.isFinite(keep) ? keep : 10))
  try {
    const items = readdirSync(dir)
      .filter((name) => !name.startsWith('.')) // 隐藏文件（如 .<name>.last-backuped 标记）不参与轮转计数
      .filter((name) => !prefix || name.startsWith(prefix))
      .map((name) => {
        const full = path.join(dir, name)
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          /* 忽略 */
        }
        return { name, full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const item of items.slice(keepN)) {
      try {
        const st = statSync(item.full)
        if (st.isDirectory()) rmSync(item.full, { recursive: true, force: true })
        else unlinkSync(item.full)
        removed.push(item.name)
      } catch {
        /* 尽力而为 */
      }
    }
  } catch {
    /* 目录不存在等 */
  }
  return removed
}

/** 包内 _meta 与远端清单条目交叉校验：任一不符整包拒装 */
function checkIdentity(meta: PackMeta, expected: InstallerOptions['expected'], zipPath: string): string | null {
  if (!expected) return null
  if (meta.kind !== expected.kind) {
    return `包内 kind=${String(meta.kind)} 与清单 kind=${expected.kind} 不符（拒装）：${zipPath}`
  }
  if (meta.name !== expected.name) {
    return `包内 name=${String(meta.name)} 与清单 name=${expected.name} 不符（拒装）：${zipPath}`
  }
  return null
}

class InstallerImpl implements Installer {
  private readonly packager = createPackager()
  private readonly maxBackups: number
  private readonly contentMerge: boolean
  private readonly expected?: { kind: PackMeta['kind']; name: string }
  private readonly installBundleDir?: (dir: string) => Promise<{ ok: boolean; message?: string }>
  private readonly linkSourceDirs: string[]

  constructor(
    private readonly env: ResolvedEnv,
    options: InstallerOptions = {},
  ) {
    if (!env || !env.dshHome) throw new Error('installer: dshHome 未解析，拒绝以 CWD 为数据根运行')
    const raw = Number(options.maxBackups)
    this.maxBackups = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10
    this.contentMerge = options.contentMerge !== false
    this.expected = options.expected
    this.installBundleDir = options.installBundleDir
    this.linkSourceDirs = (options.linkSourceDirs ?? []).map((d) => path.resolve(d))
  }

  private dataDir(): string {
    return path.join(this.env.dshHome, '.webdav-enhanced')
  }

  /** 备份目录根：backups/<kind>s */
  private backupRoot(kind: 'bundle' | 'skill'): string {
    return path.join(this.dataDir(), 'backups', `${kind}s`)
  }

  /** 从远端 meta/清单名解析安全落盘名：不过校验即抛 */
  private safeName(name: string): string {
    if (!isSafeEntryName(name)) throw new Error(`unsafe entry name from remote package: ${String(name).slice(0, 40)}`)
    return name
  }

  /**
   * v0.5 起 sync 传入 expected：kind/name 与清单不一致直接抛。
   * applyBundle/applySkill 的落盘名统一用**清单名**（本地可信侧），
   * 包内 _meta.name 只作交叉验证，绝不参与路径拼接。
   */
  async applyBundle(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult> {
    if (this.env.generation !== 'cordis') {
      return {
        status: 'manual-needed',
        message: 'legacy/unknown 代宿主不支持自动安装 bundle',
        manualCommand: `手动解压 ${packed.zipPath} 到 dsh profile 后重启`,
      }
    }
    const mismatch = checkIdentity(meta, this.expected, packed.zipPath)
    if (mismatch) return { status: 'failed', message: mismatch }
    const name = this.safeName(this.expected?.name ?? meta.name)

    // link 安装的 bundle：sourceDir 就是开发工作区，绝不允许被远端包覆盖
    const linkHit = this.linkSourceDirs.find((d) => d === path.resolve(packed.entry.sourceDir || ''))
    if (linkHit) {
      return { status: 'failed', message: `${name} 为 link 安装（本地开发目录），拒绝被远端包覆盖：${linkHit}` }
    }

    const stagingRoot = path.join(this.dataDir(), 'bundle-staging')
    mkdirSync(stagingRoot, { recursive: true })
    const staging = assertWithin(stagingRoot, path.join(stagingRoot, name), 'bundle staging path')
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(staging, { recursive: true })
    await this.packager.unpack(packed.zipPath, staging, DEFAULT_SAFETY_GUARD)

    // 检查是否已安装同 hash（幂等）
    const installedMark = path.join(this.dataDir(), 'installed-bundles', `${name}.json`)
    assertWithin(path.join(this.dataDir(), 'installed-bundles'), installedMark, 'installed-mark path')
    if (existsSync(installedMark)) {
      try {
        const prev = JSON.parse(readFileSync(installedMark, 'utf8')) as { hash?: string }
        if (prev.hash === packed.sha256) {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined)
          return { status: 'skipped', message: `${name} 已是最新` }
        }
      } catch {
        /* 继续安装 */
      }
    }

    if (!this.installBundleDir) {
      return {
        status: 'manual-needed',
        message: `${name} 未自动安装：宿主未提供 pluginManager 安装入口`,
        manualCommand: `dsh plugin --profile ${this.env.profile} add "${staging}"`,
      }
    }

    let ok = false
    let detail = ''
    try {
      const res = await this.installBundleDir(staging)
      ok = res.ok
      detail = res.message ?? ''
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err)
    }
    if (!ok) {
      return {
        status: 'manual-needed',
        message: `bundle 自动安装失败：${detail || name}`,
        manualCommand: `dsh plugin --profile ${this.env.profile} add "${staging}"`,
      }
    }

    // 记录已安装 hash
    mkdirSync(path.dirname(installedMark), { recursive: true })
    writeFileSync(installedMark, JSON.stringify({ hash: packed.sha256, installedAt: new Date().toISOString() }), 'utf8')
    return { status: 'needs-restart', message: `${name} 已安装，重启 dsh 后生效` }
  }

  async applySkill(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult> {
    const mismatch = checkIdentity(meta, this.expected, packed.zipPath)
    if (mismatch) return { status: 'failed', message: mismatch }
    const name = this.safeName(this.expected?.name ?? meta.name)

    const skillsRoot = path.resolve(this.env.skillsDir)
    mkdirSync(skillsRoot, { recursive: true })
    const dest = assertWithin(skillsRoot, path.join(skillsRoot, name), 'skill destination path')

    // 幂等：同 hash 跳过
    const markDir = path.join(this.dataDir(), 'installed-skills')
    const mark = path.join(markDir, `${name}.json`)
    if (existsSync(mark)) {
      try {
        const prev = JSON.parse(readFileSync(mark, 'utf8')) as { hash?: string }
        if (prev.hash === packed.sha256) {
          return { status: 'skipped', message: `skill ${name} 已是最新` }
        }
      } catch {
        /* 继续安装 */
      }
    }

    // v0.5 原子化（M-14）：先解到暂存目录并校验 SKILL.md，两步 rename 失败回滚旧位置，
    // 不再出现「旧目录已搬走、新包半截」的混装状态。
    const stagingRoot = path.join(this.dataDir(), 'skill-staging')
    mkdirSync(stagingRoot, { recursive: true })
    const staging = assertWithin(stagingRoot, path.join(stagingRoot, `${name}-${Date.now()}`), 'skill staging path')
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(staging, { recursive: true })
    let unpacked: PackMeta
    try {
      unpacked = await this.packager.unpack(packed.zipPath, staging, DEFAULT_SAFETY_GUARD)
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    if (unpacked.name !== name || unpacked.kind !== 'skill') {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      return { status: 'failed', message: `skill 包内 _meta 与暂存名不一致（${unpacked.name}）` }
    }
    if (!existsSync(path.join(staging, 'SKILL.md'))) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      return { status: 'failed', message: `skill ${name} 解压后缺少 SKILL.md` }
    }

    const bakRoot = this.backupRoot('skill')
    await mkdir(bakRoot, { recursive: true })
    let bak: string | null = null
    if (existsSync(dest)) {
      bak = path.join(bakRoot, `${name}-${Date.now()}`)
      // rename 失败（Windows 占用等）**不再吞**：拒绝安装，绝不与旧目录混写
      await rename(dest, bak)
    }
    try {
      await mkdir(path.dirname(dest), { recursive: true })
      await rename(staging, dest)
    } catch (err) {
      // 回滚：把备份搬回原位
      if (bak && existsSync(bak)) {
        await rename(bak, dest).catch(() => undefined)
      }
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    if (bak) pruneBackupDir(bakRoot, this.maxBackups)
    mkdirSync(markDir, { recursive: true })
    writeFileSync(mark, JSON.stringify({ hash: packed.sha256, installedAt: new Date().toISOString() }), 'utf8')
    return { status: 'applied', message: `skill ${name} 已安装` }
  }

  async applyConfig(packed: PackedEntry, meta: PackMeta): Promise<ApplyResult> {
    const mismatch = checkIdentity(meta, this.expected, packed.zipPath)
    if (mismatch) return { status: 'failed', message: mismatch }
    const name = this.safeName(this.expected?.name ?? meta.name)

    // 解压到暂存，读 settings.yaml，按顶层 key 合并
    const configStagingRoot = path.join(this.dataDir(), 'config-staging')
    mkdirSync(configStagingRoot, { recursive: true })
    const staging = assertWithin(configStagingRoot, path.join(configStagingRoot, name), 'config staging path')
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(staging, { recursive: true })
    await this.packager.unpack(packed.zipPath, staging, DEFAULT_SAFETY_GUARD)

    const src = path.join(staging, 'settings.yaml')
    if (!existsSync(src)) {
      return { status: 'failed', message: `config pack ${name} 缺少 settings.yaml` }
    }
    if (!this.env.settingsFile || !existsSync(this.env.settingsFile)) {
      return {
        status: 'manual-needed',
        message: '本机没有 settings.yaml（桌面版 0.2.x 布局无此文件；配置同步仅在 legacy/web 布局生效）',
        manualCommand: `手动合并 ${src}`,
      }
    }

    const local = readFileSync(this.env.settingsFile, 'utf8')
    const remote = readFileSync(src, 'utf8')
    if (local === remote) {
      return { status: 'skipped', message: 'settings.yaml 内容一致' }
    }

    // 写前备份（D6：绝不整文件覆盖丢 key）
    const bak = await this.backupSettings()
    const next = this.contentMerge ? mergeTopLevelConfig(local, remote) : remote
    if (next === local) {
      return { status: 'skipped', message: 'settings.yaml 合并后无变化' }
    }
    // 原子写：临时文件 + rename
    const tmp = `${this.env.settingsFile}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, this.env.settingsFile)
    return {
      status: 'needs-restart',
      message: this.contentMerge ? `settings.yaml 已按顶层 key 合并（备份：${bak}）` : `settings.yaml 已覆盖（备份：${bak}）`,
    }
  }

  private async backupSettings(): Promise<string> {
    const file = this.env.settingsFile!
    const bak = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await copyFile(file, bak)
    pruneBackupDir(path.dirname(file), this.maxBackups, path.basename(file) + '.bak-')
    return bak
  }
}

export function createInstaller(env: ResolvedEnv, options: InstallerOptions = {}): Installer {
  return new InstallerImpl(env, options)
}

/** installer 直接由 SyncOptions 构造（sync 引擎用） */
export function createInstallerFromOptions(
  env: ResolvedEnv,
  options: Partial<SyncOptions>,
  extra: {
    expected?: { kind: PackMeta['kind']; name: string }
    installBundleDir?: (dir: string) => Promise<{ ok: boolean; message?: string }>
    linkSourceDirs?: string[]
  } = {},
): Installer {
  return createInstaller(env, {
    maxBackups: options.maxBackups,
    contentMerge: options.contentMerge,
    expected: extra.expected,
    installBundleDir: extra.installBundleDir,
    linkSourceDirs: extra.linkSourceDirs,
  })
}
