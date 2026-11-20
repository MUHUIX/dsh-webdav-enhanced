/*
 * M4 远端同步清单。
 * - 逻辑：纯数据操作 + 并发合并铁轨（read → merge → commit with etag 条件写，冲突重读重合并重试）。
 * - 去重的唯一依据是内容 sha256（hash），与来源机器无关。
 * - 本模块不直接持有 WebDavClient 实现，通过 ManifestStore 接口注入，方便单测 mock。
 */
import type {
  LockHandle,
  MachineInfo,
  RemoteEntry,
  RemoteManifest,
} from '../types.js'
import { MANIFEST_VERSION, ManifestConflictError } from '../types.js'

export function emptyManifest(): RemoteManifest {
  return { version: MANIFEST_VERSION, updatedAt: new Date().toISOString(), entries: [] }
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** 以 name + kind 作为条目的逻辑主键（同名同类视为同一条目） */
export function entryKey(e: Pick<RemoteEntry, 'kind' | 'name'>): string {
  return `${e.kind}:${e.name}`
}

export interface ManifestStoreLike {
  read(): Promise<{ manifest: RemoteManifest; etag: string | null }>
  /** 冲突重试前调用：丢弃实现侧的本轮缓存，强制下一次 read 走真远端 */
  invalidate?(): void
  commit(next: RemoteManifest, etag: string | null, lock: LockHandle | null): Promise<string | null>
  acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null>
  currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null>
}

/**
 * 乐观并发合并：fn 拿到最新 manifest，产出新 manifest；
 * 若 commit 期间 etag 变了（别的机器抢先），重读 → 重合并，最多 maxRetries 次。
 */
export async function withManifestLock<T>(
  store: ManifestStoreLike,
  machineId: string,
  fn: (manifest: RemoteManifest) => { manifest: RemoteManifest; result: T },
  opts: { maxRetries?: number; ttlMs?: number } = {},
): Promise<{ result: T; etag: string | null }> {
  const maxRetries = opts.maxRetries ?? 3
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000

  let lastErr: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const lock = await store.acquireLock(machineId, ttlMs)
    try {
      const { manifest, etag } = await store.read()
      const { manifest: next, result } = fn(manifest)
      next.updatedAt = nowIso()
      const newEtag = await store.commit(next, etag, lock)
      return { result, etag: newEtag }
    } catch (err) {
      lastErr = err
      if (!(err instanceof ManifestConflictError)) throw err
      // 冲突：作废本轮缓存（否则重试读到的还是同一份陈旧 etag，必然 412 到死），
      // 稍等后重试整个回合
      store.invalidate?.()
      await sleep(200 * (attempt + 1))
    } finally {
      if (lock) await lock.release().catch(() => undefined)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('manifest merge failed')
}

/** 条目去重与更新的纯函数：按 hash 判定是否需要新条目 */
export function upsertEntry(
  manifest: RemoteManifest,
  entry: Omit<RemoteEntry, 'firstSeenAt' | 'updatedAt'>,
  now: string,
): RemoteManifest {
  const key = entryKey(entry)
  const idx = manifest.entries.findIndex((e) => entryKey(e) === key)
  if (idx === -1) {
    return {
      ...manifest,
      entries: [...manifest.entries, { ...entry, firstSeenAt: now, updatedAt: now }],
    }
  }
  const existing = manifest.entries[idx]
  if (existing.hash === entry.hash && existing.version === entry.version && !entry.deleted) {
    // 内容没变：去重，直接原地跳过（不动 updatedAt，避免无意义版本漂移）
    return manifest
  }
  const next: RemoteEntry = {
    ...existing,
    ...entry,
    firstSeenAt: existing.firstSeenAt ?? now,
    updatedAt: now,
  }
  const entries = [...manifest.entries]
  entries[idx] = next
  return { ...manifest, entries }
}

/** 软删除：墓碑 + 文件进回收站（文件移动由调用方用 WebDavClient 完成） */
export function markDeleted(manifest: RemoteManifest, kind: RemoteEntry['kind'], name: string, now: string): RemoteManifest {
  const key = `${kind}:${name}`
  return {
    ...manifest,
    entries: manifest.entries.map((e) =>
      entryKey(e) === key ? { ...e, deleted: true, updatedAt: now } : e,
    ),
  }
}

// ---------- 远端文件命名 ----------

/**
 * 条目名安全白名单：字母数字开头，允许 . _ -；npm scope 名（@org/pkg）逐段校验。
 * 禁 `..`、禁路径分隔符出现在段内（scope 的唯一一个 `/` 是结构本身）。
 */
export function isSafeEntryName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 120) return false
  const segments = name.startsWith('@') ? name.slice(1).split('/') : name.split('/')
  if (segments.length > (name.startsWith('@') ? 2 : 1)) return false
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segments[0]) && segments.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
}

/** 远端相对路径安全：分段的 zip 路径，必须落在已知子目录下，禁 `..` 与绝对路径 */
export function isSafeRemoteFile(file: unknown): file is string {
  if (typeof file !== 'string' || file.length === 0 || file.length > 260) return false
  if (file.startsWith('/') || file.startsWith('\\') || /^[a-zA-Z]:/.test(file)) return false
  const segments = file.split('/')
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false
  const dir = segments[0]
  return dir === 'bundles' || dir === 'skills' || dir === 'configs'
}

export function remoteZipRelPath(e: Pick<RemoteEntry, 'kind' | 'name' | 'version' | 'hash'>): string {
  if (!isSafeEntryName(e.name)) throw new Error(`unsafe entry name for remote path: ${String(e.name).slice(0, 40)}`)
  const hash = /^[0-9a-f]{64}$/.test(e.hash) ? e.hash : e.hash.replace(/[^0-9a-f]/g, '').slice(0, 64)
  const ver = e.version ? `@${e.version.replace(/[^\w.+-]/g, '_')}` : ''
  const dir = e.kind === 'bundle' ? 'bundles' : e.kind === 'skill' ? 'skills' : 'configs'
  // scoped 名 @org/pkg 的 '/' 会凭空造出一层远端目录（且 manifest 会判路径越界）：压平为 @org_pkg
  const safeName = e.name.replace(/[^\w.@+-]/g, '_')
  return `${dir}/${safeName}${ver}-${hash}.zip`
}

// ---------- 远端清单结构校验（信任边界：服务器数据入库前必查） ----------

export interface ManifestValidation {
  manifest: RemoteManifest
  /** 被丢弃的不合法条目描述（进报告 warnings） */
  dropped: { name: string; why: string }[]
}

function asString(v: unknown, max = 260): string | null {
  return typeof v === 'string' && v.length <= max ? v : null
}

/**
 * 校验并规整远端 manifest。
 * - `version` 大于本地已知 → 抛错（新制式，拒绝按旧语义解读）；
 * - 单条目不合法（kind/name/hash/file 越界）→ 丢弃该条并记入 dropped，不拖垮整轮；
 * - 非字符串字段一律归一，杜绝 `.filter/.startsWith` 之类的 TypeError 炸整轮。
 */
export function validateRemoteManifest(raw: unknown): ManifestValidation {
  const dropped: { name: string; why: string }[] = []
  if (!raw || typeof raw !== 'object') throw new Error('远端清单格式非法（不是 JSON 对象）')
  const obj = raw as Record<string, unknown>
  const version = typeof obj.version === 'number' ? obj.version : Number.NaN
  if (Number.isNaN(version)) throw new Error('远端清单缺少 version 字段')
  if (version > MANIFEST_VERSION) {
    throw new Error(`远端清单版本 ${version} 高于本插件可解读的 ${MANIFEST_VERSION}，请先升级 dsh-webdav-enhanced`)
  }
  if (!Array.isArray(obj.entries)) throw new Error('远端清单 entries 不是数组')
  const entries: RemoteEntry[] = []
  for (const item of obj.entries) {
    if (!item || typeof item !== 'object') {
      dropped.push({ name: '?', why: '条目不是对象' })
      continue
    }
    const e = item as Record<string, unknown>
    const kind = e.kind
    if (kind !== 'bundle' && kind !== 'skill' && kind !== 'config') {
      dropped.push({ name: String(e.name ?? '?'), why: `kind 非法：${String(kind).slice(0, 20)}` })
      continue
    }
    if (!isSafeEntryName(e.name)) {
      dropped.push({ name: String(e.name ?? '?').slice(0, 40), why: 'name 含非法字符' })
      continue
    }
    const hash = asString(e.hash, 64)
    if (!hash || !/^[0-9a-f]{16,64}$/.test(hash)) {
      dropped.push({ name: e.name as string, why: 'hash 非法' })
      continue
    }
    if (!isSafeRemoteFile(e.file)) {
      dropped.push({ name: e.name as string, why: `file 路径越界：${String(e.file).slice(0, 60)}` })
      continue
    }
    const zipHash = typeof e.zipHash === 'string' && /^[0-9a-f]{64}$/.test(e.zipHash) ? e.zipHash : undefined
    const source = (e.source && typeof e.source === 'object' ? e.source : {}) as Record<string, unknown>
    const machineId = isSafeEntryName(source.machineId) ? source.machineId : 'unknown'
    const entry: RemoteEntry = {
      kind,
      name: e.name,
      version: typeof e.version === 'string' ? e.version : e.version === null ? null : null,
      hash,
      file: e.file,
      size: typeof e.size === 'number' && Number.isFinite(e.size) && e.size >= 0 ? e.size : 0,
      source: {
        machineId,
        platform: asString(source.platform, 40) ?? 'unknown',
        dshVersion: typeof source.dshVersion === 'string' ? source.dshVersion : null,
      },
      firstSeenAt: asString(e.firstSeenAt, 40) ?? new Date(0).toISOString(),
      updatedAt: asString(e.updatedAt, 40) ?? new Date(0).toISOString(),
      deleted: e.deleted === true,
    }
    if (zipHash) entry.zipHash = zipHash
    entries.push(entry)
  }
  return {
    manifest: {
      version: MANIFEST_VERSION,
      updatedAt: asString(obj.updatedAt, 40) ?? new Date(0).toISOString(),
      entries,
    },
    dropped,
  }
}

// ---------- helpers ----------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export type { ManifestStoreLike as ManifestStoreImpl }
export type { MachineInfo }
