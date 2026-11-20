/*
 * M1+ 本地扫描（v2）：把 ResolvedEnv 转成 LocalEntry 列表，**扫描阶段就算出真实 hash**（D2 修复）。
 * - skills：扫描 skillsDir 下的每个含 SKILL.md 的目录。
 * - bundles（cordis 代）：解析 profileDir/package.json 依赖，把本地路径作为 sourceDir。
 * - config：settings.yaml 顶层 key 分组；mode='all' 同步全部顶层 key（D7 修复），
 *   但敏感 key（apiKey / token / secret / password / credentials 相关）整段跳过。
 * - hash 缓存：$DSH_HOME/.webdav-enhanced/hash-cache.json，key=`kind:name`，
 *   目录 mtime + 文件数（+ 最近文件 mtime）未变则直接复用缓存，避免每轮全量重算。
 * 容错：单个条目扫描失败不阻塞整体，记录到 errors 返回。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { collectHashableFiles, hashDirectory } from './pack.js'
import { DATA_DIRNAME } from './config-store.js'
import type { LocalEntry, MachineInfo, ResolvedEnv, SyncScope } from '../types.js'

export const HASH_CACHE_FILENAME = 'hash-cache.json'

/**
 * 内容 hash 算法 / 排除表的版本号。
 * 排除表或 hashDirectory 规则变化时 +1，读取时旧 schema 的缓存一律丢弃重算。
 * v2: pack 排除表移除 lib/dist（bundle 运行时代码必须参与 hash），故 1 → 2。
 */
export const HASH_CACHE_SCHEMA = 2

export interface ScanError {
  stage: string
  message: string
  /** true = 告警（不进同步失败判定）；缺省 = 错误 */
  warn?: boolean
}

export interface ScanResult {
  entries: LocalEntry[]
  errors: ScanError[]
}

/** 目录内容指纹缓存项（DESIGN-v2 §6）
 * v0.5：命中判定加入 treeDigest（全量"相对路径+大小+mtime"摘要）——
 * 旧实现只比目录 mtime/文件数/最大文件 mtime，会漏掉"改了非最新文件"的修改（M-1）。 */
export interface HashCacheEntry {
  /** 缓存 schema 版本：与 HASH_CACHE_SCHEMA 不一致视为未命中（排除表/hash 算法升级后自动失效） */
  schema?: number
  mtimeMs: number
  fileCount: number
  hash: string
  sizeBytes: number
  /** 目录内文件的最新 mtime（保留字段，兼容旧缓存文件） */
  filesMtimeMs?: number
  /** 全量文件清单摘要：sha256 over sorted(rel|size|mtimeMs) */
  treeDigest?: string
}

/** 位于 $DSH_HOME/.webdav-enhanced/hash-cache.json 的内容 hash 缓存 */
export class HashCache {
  readonly filePath: string
  private data: Record<string, HashCacheEntry> | null = null
  private dirty = false

  constructor(dshHome: string) {
    if (!dshHome) throw new Error('HashCache: dshHome is required (v0.5: 禁止回退到进程 CWD)')
    this.filePath = path.join(dshHome, DATA_DIRNAME, HASH_CACHE_FILENAME)
  }

  get(key: string): HashCacheEntry | null {
    const all = this.loadOnce()
    const hit = all[key]
    if (!hit || typeof hit.hash !== 'string') return null
    // schema 不一致（排除表/hash 算法已升级）→ 视为未命中，强制重算
    if (hit.schema !== HASH_CACHE_SCHEMA) return null
    return hit
  }

  set(key: string, value: HashCacheEntry): void {
    const all = this.loadOnce()
    all[key] = { ...value, schema: HASH_CACHE_SCHEMA }
    this.dirty = true
  }

  /** 落盘（仅在有变动时写；失败静默，缓存不影响正确性） */
  save(): void {
    if (!this.dirty) return
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data ?? {}, null, 2), 'utf8')
      this.dirty = false
    } catch {
      /* 缓存落盘失败可忽略 */
    }
  }

  private loadOnce(): Record<string, HashCacheEntry> {
    if (this.data) return this.data
    try {
      if (!existsSync(this.filePath)) {
        this.data = {}
        return this.data
      }
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      this.data = parsed && typeof parsed === 'object' ? (parsed as Record<string, HashCacheEntry>) : {}
    } catch {
      this.data = {}
    }
    return this.data
  }
}

export interface ScanOptions {
  /** 传 null 关闭缓存（/plan 干跑不写本地状态）；省略则按 env 自动创建 */
  cache?: HashCache | null
  /** 是否把 config 桩文件写到磁盘（/plan 干跑传 false） */
  writeConfigStub?: boolean
}

function isSkillDir(dir: string): boolean {
  return existsSync(path.join(dir, 'SKILL.md'))
}

function statOrNull(p: string) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

function dirMtime(dir: string): string {
  const st = statOrNull(dir)
  return st ? st.mtime.toISOString() : new Date(0).toISOString()
}

function safeReadJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function guessSkillVersion(dir: string): string | null {
  // 读 SKILL.md frontmatter 里的 version 字段（尽力而为）
  const skillMd = path.join(dir, 'SKILL.md')
  try {
    const head = readFileSync(skillMd, 'utf8').slice(0, 4096)
    const m = head.match(/^---\n[\s\S]*?version:\s*([^\n]+)\n[\s\S]*?---/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

/** 目录内容统计（不读文件内容，只 stat）：用于 hash 缓存命中判断 */
interface DirFingerprint {
  mtimeMs: number
  fileCount: number
  filesMtimeMs: number
  sizeBytes: number
  /** 全量 "rel|size|mtimeMs" 排序拼接后的 sha256 */
  treeDigest: string
}

async function fingerprintDir(dir: string): Promise<DirFingerprint | null> {
  const st = statOrNull(dir)
  if (!st) return null
  const files = await collectHashableFiles(dir)
  let latest = 0
  let size = 0
  const h = createHash('sha256')
  for (const rel of [...files].sort()) {
    const fst = statOrNull(path.join(dir, rel))
    if (!fst) continue
    if (fst.mtimeMs > latest) latest = fst.mtimeMs
    size += fst.size
    h.update(rel)
    h.update('|')
    h.update(String(fst.size))
    h.update('|')
    h.update(String(Math.round(fst.mtimeMs)))
    h.update('\0')
  }
  return { mtimeMs: st.mtimeMs, fileCount: files.length, filesMtimeMs: latest, sizeBytes: size, treeDigest: h.digest('hex') }
}

/** 扫描期回填真实 hash / sizeBytes（D1 + D2 根因修复） */
async function fillHash(entry: LocalEntry, cache: HashCache | null, errors: ScanError[]): Promise<boolean> {
  if (!entry.sourceDir) {
    errors.push({ stage: 'scan-hash', message: `${entry.kind} ${entry.name}: 无本地源目录，跳过` })
    return false
  }
  const fp = await fingerprintDir(entry.sourceDir)
  if (!fp) {
    errors.push({ stage: 'scan-hash', message: `${entry.kind} ${entry.name}: 源目录不可读（${entry.sourceDir}）` })
    return false
  }
  const key = `${entry.kind}:${entry.name}`
  const cached = cache?.get(key) ?? null
  if (
    cached &&
    cached.mtimeMs === fp.mtimeMs &&
    cached.fileCount === fp.fileCount &&
    typeof cached.treeDigest === 'string' &&
    cached.treeDigest === fp.treeDigest
  ) {
    entry.hash = cached.hash
    entry.sizeBytes = cached.sizeBytes
    return true
  }
  try {
    entry.hash = await hashDirectory(entry)
    entry.sizeBytes = fp.sizeBytes
    cache?.set(key, {
      mtimeMs: fp.mtimeMs,
      fileCount: fp.fileCount,
      hash: entry.hash,
      sizeBytes: entry.sizeBytes,
      filesMtimeMs: fp.filesMtimeMs,
      treeDigest: fp.treeDigest,
    })
    return true
  } catch (err) {
    errors.push({ stage: 'scan-hash', message: `${entry.kind} ${entry.name}: 计算内容 hash 失败：${(err as Error).message}` })
    return false
  }
}

interface PkgJson {
  name?: string
  version?: string
  dsh?: { bundle?: boolean; profile?: { bundles?: string[] } }
  dependencies?: Record<string, string>
}

/**
 * 解析 profile 已装的 bundle 列表 + 本地路径。
 * v0.5（L-3）：只同步「带 dsh.bundle 标记」或「出现在 profile 的 dsh.profile.bundles
 * 列表里」的依赖——与 README 宣称一致；纯传递依赖（react 之类）不再被当成插件扫走。
 */
async function scanBundles(
  env: ResolvedEnv,
  scope: SyncScope['bundles'],
  errors: ScanError[],
  cache: HashCache | null,
): Promise<LocalEntry[]> {
  const out: LocalEntry[] = []
  if (scope.mode === 'none') return out
  const profilePkg = path.join(env.profileDir, 'package.json')
  const pkg = safeReadJson<PkgJson>(profilePkg)
  if (!pkg?.dependencies) return out
  const declaredBundles = new Set(pkg.dsh?.profile?.bundles ?? [])
  const exclude = new Set(scope.exclude)
  const seenDirs = new Set<string>()
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (exclude.has(name)) continue
    // link:/file: → 本地路径；npm/git spec → node_modules 下
    let sourceDir: string | null = null
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      sourceDir = path.resolve(env.profileDir, spec.replace(/^(link|file):/, ''))
    } else {
      const nm = path.join(env.profileDir, 'node_modules', name)
      if (existsSync(nm)) sourceDir = nm
    }
    if (!sourceDir || !existsSync(sourceDir)) {
      errors.push({ stage: 'scan-bundle', message: `bundle ${name} spec ${spec} cannot be resolved locally`, warn: true })
      continue
    }
    const bundlesPkgJson = safeReadJson<PkgJson>(path.join(sourceDir, 'package.json'))
    if (bundlesPkgJson?.dsh?.bundle !== true && !declaredBundles.has(name)) continue // 非 bundle：跳过
    const dirKey = realpathOrNull(sourceDir) ?? path.resolve(sourceDir)
    if (seenDirs.has(dirKey)) continue // 同一物理目录被重复声明：只保留第一条
    seenDirs.add(dirKey)
    const entry: LocalEntry = {
      kind: 'bundle',
      name,
      version: bundlesPkgJson?.version ?? null,
      sourceDir,
      hash: '',
      sizeBytes: 0,
      modifiedAt: dirMtime(sourceDir),
    }
    if (await fillHash(entry, cache, errors)) out.push(entry)
  }
  return out
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

async function scanSkills(
  env: ResolvedEnv,
  scope: SyncScope['skills'],
  errors: ScanError[],
  cache: HashCache | null,
): Promise<LocalEntry[]> {
  const out: LocalEntry[] = []
  if (scope.mode === 'none') return out
  const exclude = new Set(scope.exclude)
  const seenByName = new Map<string, string>() // name → 命中根（realpath）
  const seenReal = new Set<string>()
  const roots = env.skillRoots && env.skillRoots.length > 0 ? env.skillRoots : [env.skillsDir]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    for (const name of safeReaddir(root)) {
      if (exclude.has(name)) continue
      if (name.startsWith('.')) continue
      const dir = path.join(root, name)
      if (!existsSync(dir)) continue
      const real = realpathOrNull(dir) ?? path.resolve(dir)
      if (seenReal.has(real)) continue // 同一物理目录（如 junction 镜像）只算一次
      if (!isSkillDir(dir)) {
        errors.push({ stage: 'scan-skill', message: `skill dir ${name} missing SKILL.md, skipped`, warn: true })
        continue
      }
      const collision = seenByName.get(name)
      if (collision && collision !== real) {
        // 多根同名不同目录：以第一个根为准，另一个显式告警（v0.4 是静默塌缩）
        errors.push({
          stage: 'scan-skill',
          message: `skill "${name}" 同时存在于多个根目录，保留 ${roots[0]} 下的版本，忽略 ${dir}`,
          warn: true,
        })
        continue
      }
      seenByName.set(name, real)
      seenReal.add(real)
      const entry: LocalEntry = {
        kind: 'skill',
        name,
        version: guessSkillVersion(dir),
        sourceDir: dir,
        hash: '',
        sizeBytes: 0,
        modifiedAt: dirMtime(dir),
      }
      if (await fillHash(entry, cache, errors)) out.push(entry)
    }
  }
  return out
}

// ---------- config：顶层 key 粒度 ----------

/** 敏感顶层 key：整段跳过（apiKey / apiKeyEnv / credentials / token / secret / password…） */
const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|passwd|credential|authorization|private[-_]?key)/i

/** 块内字段级敏感行（v0.5，H-7）：providers:/llm: 这类非敏感块里的 apiKey 行 */
const SENSITIVE_FIELD = /^\s*[\w"']*(api[-_]?key|token|secret|passwd|password|credential|authorization|private[-_]?key)[\w"']*\s*:/i

/** YAML 顶层 key 行（列 0、非注释） */
const TOP_KEY = /^([A-Za-z_][\w.-]*)\s*:/

export interface ConfigBlock {
  key: string
  /** 含该 key 的全部原始行（含嵌套），行尾不含 \n */
  lines: string[]
}

/** 把 settings.yaml 按顶层 key 切成块；首个 key 之前的注释/前言行单独丢弃 */
export function splitConfigBlocks(raw: string): ConfigBlock[] {
  const blocks: ConfigBlock[] = []
  let cur: ConfigBlock | null = null
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(TOP_KEY)
    if (m && !/^\s/.test(line)) {
      if (cur) blocks.push(cur)
      cur = { key: m[1], lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    }
  }
  if (cur) blocks.push(cur)
  return blocks
}

/** 列出 settings.yaml 里可同步的顶层 key（排除敏感段）；Content 页/测试用 */
export function listConfigTopKeys(raw: string): string[] {
  return splitConfigBlocks(raw)
    .map((b) => b.key)
    .filter((key) => !SENSITIVE_KEY.test(key))
}

/**
 * 块内字段级脱敏（v0.5，H-7）：剔除敏感 key 行及其更深缩进的子块。
 * 返回 { lines, dropped }——dropped>0 时调用方必须往 warnings 记数，
 * 用户要知道"有几行密钥被拦下了"，而不是密钥悄悄不上云 / 或根本没拦。
 */
export function redactSensitiveLines(block: ConfigBlock): { lines: string[]; dropped: number } {
  const kept: string[] = [block.lines[0]] // 顶层 key 行本身（已过 SENSITIVE_KEY 筛选）
  const baseIndent = leadingSpace(block.lines[0] ?? '')
  let dropping = false
  let dropIndent = 0
  let dropped = 0
  for (const line of block.lines.slice(1)) {
    const indent = leadingSpace(line)
    const isContent = line.trim() !== ''
    if (dropping) {
      if (!isContent || indent > dropIndent) {
        dropped += isContent ? 1 : 0
        continue // 仍在被剔除的子块内（含其空行分隔）
      }
      dropping = false
    }
    if (isContent && indent > baseIndent && SENSITIVE_FIELD.test(line)) {
      dropping = true
      dropIndent = indent
      dropped += 1
      continue
    }
    kept.push(line)
  }
  return { lines: kept, dropped }
}

function leadingSpace(line: string): number {
  const m = line.match(/^(\s*)/)
  return m ? m[1].length : 0
}

/** 选出要同步的 config 顶层 key */
export function selectConfigKeys(mode: SyncScope['configs']['mode'], includeKeys: string[], raw: string): string[] {
  if (mode === 'none') return []
  const all = listConfigTopKeys(raw)
  if (mode === 'all') return all
  const wanted = new Set(includeKeys)
  return all.filter((k) => wanted.has(k))
}

/** 与 hashDirectory(桩目录) 等价的内存 hash（避免 plan 干跑去写桩文件） */
export function hashConfigContent(kind: string, name: string, content: string): string {
  const inner = createHash('sha256').update(content).digest('hex')
  const h = createHash('sha256')
  h.update(kind)
  h.update('\0')
  h.update(name)
  h.update('\0')
  h.update('') // version
  h.update('\0')
  h.update('settings.yaml')
  h.update('\0')
  h.update(inner)
  h.update('\0')
  return h.digest('hex')
}

interface ConfigScanOptions {
  cache: HashCache | null
  writeStub: boolean
}

function scanConfigs(env: ResolvedEnv, scope: SyncScope['configs'], errors: ScanError[], opts: ConfigScanOptions): LocalEntry[] {
  if (scope.mode === 'none' || !env.settingsFile) return []
  let raw: string
  try {
    raw = readFileSync(env.settingsFile, 'utf8')
  } catch (err) {
    errors.push({ stage: 'scan-config', message: `读取 settings.yaml 失败：${(err as Error).message}` })
    return []
  }
  const keys = new Set(selectConfigKeys(scope.mode, scope.includeKeys, raw))
  if (keys.size === 0) return []
  let redactedCount = 0
  const kept = splitConfigBlocks(raw)
    .filter((b) => keys.has(b.key))
    .map((b) => {
      const r = redactSensitiveLines(b)
      redactedCount += r.dropped
      return { key: b.key, lines: r.lines }
    })
  if (kept.length === 0) return []
  if (redactedCount > 0) {
    errors.push({
      stage: 'scan-config-redact',
      message: `配置同步：${redactedCount} 行敏感字段（apiKey/token/secret 等）已被拦下，不参与上云`,
      warn: true,
    })
  }
  const stubContent = kept.map((b) => b.lines.join('\n')).join('\n') + '\n'
  const stubDir = path.join(env.dshHome, DATA_DIRNAME, 'config-stub')
  if (opts.writeStub) {
    try {
      mkdirSync(stubDir, { recursive: true })
      writeFileSync(path.join(stubDir, 'settings.yaml'), stubContent, 'utf8')
    } catch (err) {
      errors.push({ stage: 'scan-config', message: `写配置桩失败：${(err as Error).message}` })
    }
  }
  const st = statOrNull(env.settingsFile)
  const entry: LocalEntry = {
    kind: 'config',
    name: 'settings',
    version: null,
    sourceDir: opts.writeStub ? stubDir : '',
    hash: hashConfigContent('config', 'settings', stubContent),
    sizeBytes: Buffer.byteLength(stubContent, 'utf8'),
    modifiedAt: st ? st.mtime.toISOString() : new Date().toISOString(),
  }
  return [entry]
}

// ---------- machine info ----------

const MACHINE_CACHE = new Map<string, MachineInfo>()

export function machineInfo(env: ResolvedEnv, machineId: string): MachineInfo {
  const key = `${machineId}:${env.platform}`
  if (MACHINE_CACHE.has(key)) return MACHINE_CACHE.get(key)!
  const info: MachineInfo = { machineId, platform: env.platform, dshVersion: env.dshVersion }
  MACHINE_CACHE.set(key, info)
  return info
}

// ---------- 入口 ----------

/**
 * 扫描本地可同步条目。**v2 为异步**：扫描阶段要算真实 hash（D2）并读写 hash 缓存。
 * @param opts.cache 传 null 关闭缓存（/plan 干跑不写本地状态）
 * @param opts.writeConfigStub 传 false 时不写 config 桩（/plan 干跑）
 */
export async function scanLocal(
  env: ResolvedEnv,
  scope: SyncScope,
  errors: ScanError[] = [],
  opts: ScanOptions = {},
): Promise<LocalEntry[]> {
  const cache = opts.cache === undefined ? (env.dshHome ? new HashCache(env.dshHome) : null) : opts.cache
  const out: LocalEntry[] = []
  out.push(...(await scanSkills(env, scope.skills, errors, cache)))
  out.push(...(await scanBundles(env, scope.bundles, errors, cache)))
  out.push(...scanConfigs(env, scope.configs, errors, { cache, writeStub: opts.writeConfigStub !== false }))
  cache?.save()
  return out
}
