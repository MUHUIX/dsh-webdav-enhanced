/*
 * M4/M2 远端清单与锁的 WebDAV 实现（v0.5）。
 * - 逻辑（并发合并/去重）在 manifest.ts（纯函数）。
 * - 本模块只做远端读写 + 锁 + 上传去重 + prune，依赖 webdav-client（createWebDavClient）。
 * - 通过 SyncStore 抽象暴露给 sync.ts，方便单测 mock。
 * - v0.5 关键变化：
 *   1) read() 走 stat→GET 原子化通道并做结构校验（validateRemoteManifest）；
 *      读取失败（超时/5xx/坏清单）**抛错**——绝不再退化为空清单（C-4）。
 *   2) 一轮同步内 beginRun() 后的 read 走本轮缓存：commit 成功后缓存自更新，
 *      把 N 条目的 N×(2 GET) 压到 ~1 GET + N×PUT（M-4）。
 *   3) commit 无 etag 时只允许 createOnly；服务端不执行条件头时用
 *      "提交后回读比对"兜底，发现覆盖被抢先 → 抛 ManifestConflictError 重试。
 *   4) deleteEntry 的回收站 MOVE 失败不再吞：墓碑不落账，本轮报错下轮重试。
 *   5) trash 过期判定优先解析文件名内嵌的落站时间戳（我们的格式 .<epochMs>），
 *      其次服务端 mtime；两者皆无 → 本轮不动它（H-5：不再"读不到就删"）。
 */
import path from 'node:path'
import { createWebDavClient } from './webdav.js'
import type { WebDavClient } from '../types.js'
import { type LockHandle, type MachineInfo, type RemoteEntry, type RemoteManifest } from '../types.js'
import {
  emptyManifest,
  entryKey,
  markDeleted,
  remoteZipRelPath,
  upsertEntry,
  validateRemoteManifest,
  withManifestLock,
} from './manifest.js'

export const MANIFEST_REL = 'manifest.json'
const LOCK_REL = 'locks/sync.lock'
export const TRASH_REL = 'trash'

export interface ReadOutcome {
  manifest: RemoteManifest
  etag: string | null
  /** 校验期丢弃的非法条目（调用方转 report.warnings） */
  dropped: { name: string; why: string }[]
}

export interface SyncStore {
  /** 一轮同步开始：重置本轮清单缓存（v0.5 起必调） */
  beginRun(): void
  /** 冲突重试前：与 beginRun 等价的缓存失效 */
  invalidate(): void
  read(): Promise<ReadOutcome>
  commit(next: RemoteManifest, etag: string | null, lock: LockHandle | null): Promise<string | null>
  acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null>
  currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null>
}

export interface WebDavStoreOptions {
  url: string
  username: string
  password: string
  timeoutMs?: number
  remoteRoot?: string
  ignoreTlsErrors?: boolean
}

export class WebDavSyncStore implements SyncStore {
  private readonly client: WebDavClient
  private cache: { manifest: RemoteManifest; etag: string | null } | null = null

  constructor(opts: WebDavStoreOptions) {
    this.client = createWebDavClient({
      url: opts.url,
      username: opts.username,
      password: opts.password,
      timeoutMs: opts.timeoutMs,
      remoteRoot: opts.remoteRoot,
      ignoreTlsErrors: opts.ignoreTlsErrors,
    })
  }

  beginRun(): void {
    this.cache = null
  }

  invalidate(): void {
    this.cache = null
  }

  async read(): Promise<ReadOutcome> {
    if (this.cache) {
      return { manifest: this.cache.manifest, etag: this.cache.etag, dropped: [] }
    }
    const { value, etag } = await this.client.getWithEtag<unknown>(MANIFEST_REL)
    if (value === null) {
      const fresh = emptyManifest()
      this.cache = { manifest: fresh, etag: null }
      return { manifest: fresh, etag: null, dropped: [] }
    }
    const { manifest, dropped } = validateRemoteManifest(value)
    this.cache = { manifest, etag }
    return { manifest, etag, dropped }
  }

  async commit(next: RemoteManifest, etag: string | null, _lock: LockHandle | null): Promise<string | null> {
    // etag 为 null 意味着 read 时清单不存在 → 只允许"不存在才创建"；
    // 若服务端在此之前被抢先创建，412 → ManifestConflictError 走重试。
    const newEtag = await this.client.putJsonIfMatch(MANIFEST_REL, next, etag, { createOnly: !etag })
    this.cache = { manifest: next, etag: newEtag }
    // 无 etag 的服务端条件头形同虚设（甚至悄悄剥离 If-Match）：提交后回读，
    // 确认盘上就是本轮内容；不是则按"被别人抢先"处理，让上层重新读-合并-写。
    if (!newEtag) {
      const check = await this.client.getJson<unknown>(MANIFEST_REL)
      const mine = check && typeof check === 'object' && (check as RemoteManifest).updatedAt === next.updatedAt
      if (!mine) throw new Error('manifest commit verification failed: another machine wrote concurrently (no-etag server)')
    }
    return newEtag
  }

  async acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null> {
    return await this.client.acquireLock(machineId, ttlMs)
  }

  async currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null> {
    return await this.client.currentLockHolder()
  }
}

// ---------- 便捷封装：upsert + 条件写 + 去重 ----------

export interface PushEntryInput {
  entry: Omit<RemoteEntry, 'firstSeenAt' | 'updatedAt' | 'file' | 'deleted'>
  /** 本地 zip 绝对路径 */
  zipPath: string
  machineId: string
  /**
   * v2（D9）：远端任意条目已有同 hash 文件时，不复传文件，只把本条目登记进 manifest。
   * 注意：内容 hash 含 kind/name/version 身份前缀，跨条目（改名）不会命中；
   * 实际收益在同名条目重传窗口内（PUT 成功但 manifest 未提交时 exists 复用）。
   */
  dedupeRemote?: boolean
}

export interface PushEntryResult {
  etag: string | null
  /** 是否真的执行了 PUT */
  uploaded: boolean
  /** 是否复用了远端已有的同内容文件 */
  deduped: boolean
  /** 条目最终指向的远端 zip 相对路径 */
  file: string
}

/** 上传条目 zip（按 hash 去重，含跨条目复用）并更新 manifest，返回最新 etag */
export async function pushEntry(
  store: SyncStore,
  client: WebDavClient,
  input: PushEntryInput,
): Promise<PushEntryResult> {
  const file = remoteZipRelPath(input.entry)
  // 1) 读清单（本轮缓存），判断是否需要上传（同 key 同 hash 去重）
  const { manifest, etag } = await store.read()
  const key = entryKey(input.entry)
  const existing = manifest.entries.find((e) => entryKey(e) === key)
  if (existing && existing.hash === input.entry.hash && !existing.deleted) {
    return { etag, uploaded: false, deduped: false, file: existing.file } // 内容相同，无需重复上传
  }

  // 2) 跨条目同内容复用：同 hash 才复用（hash 含身份前缀，跨名几乎不可能，保留分支无害）
  const reusable = input.dedupeRemote
    ? manifest.entries.find((e) => !e.deleted && e.hash === input.entry.hash && entryKey(e) !== key)
    : undefined
  let targetFile = file
  let uploaded = false
  let deduped = false

  if (reusable) {
    targetFile = reusable.file
    deduped = true
  } else if (input.dedupeRemote && (await client.exists(file))) {
    // 文件名带完整 hash：同路径已存在 = 同内容，跳过 PUT 只更新 manifest
    deduped = true
  } else {
    const stagingRel = `staging/${path.basename(file)}`
    // 目标集合必须先建：实测部分服务端（muhuix DAV / 部分 Nginx WebDAV 模块）
    // 对「MOVE 到不存在的集合」返回 403 而不是 409，不建目录会直接导致首次上传全失败。
    const targetDir = path.posix.dirname(targetFile)
    await client.ensureDir('staging')
    await client.putFile(stagingRel, input.zipPath, { sha256: input.entry.zipHash })
    try {
      if (targetDir && targetDir !== '.' && targetDir !== '/') await client.ensureDir(targetDir)
      await client.move(stagingRel, targetFile)
    } catch (err) {
      // MOVE 失败时清掉 staging 残留，避免远端堆积无引用的 zip
      await client.deleteFile(stagingRel).catch(() => undefined)
      throw err
    }
    uploaded = true
  }

  // 3) 更新 manifest（带条件写 + 冲突重试）
  const now = new Date().toISOString()
  const res = await withManifestLock(store, input.machineId, (m) => ({
    manifest: upsertEntry(m, { ...input.entry, file: targetFile, deleted: false }, now),
    result: null,
  }))
  return { etag: res.etag, uploaded, deduped, file: targetFile }
}

/** 软删除条目（墓碑 + 文件移到回收站）；同文件被其它条目复用时不动文件。
 * 回收站 MOVE 失败直接抛：宁可不落墓碑（下轮重试），不落"账说删了、文件还在裸奔"的半状态。 */
export async function deleteEntry(
  store: SyncStore,
  client: WebDavClient,
  kind: RemoteEntry['kind'],
  name: string,
  machineId: string,
): Promise<void> {
  const { manifest } = await store.read()
  const key = entryKey({ kind, name })
  const target = manifest.entries.find((e) => entryKey(e) === key && !e.deleted)
  if (!target) return
  const sharedByOther = manifest.entries.some((e) => !e.deleted && entryKey(e) !== key && e.file === target.file)
  if (!sharedByOther) {
    const trashRel = `${TRASH_REL}/${path.basename(target.file)}.${Date.now()}`
    await client.ensureDir(TRASH_REL)
    await client.move(target.file, trashRel) // 失败上抛：本轮该条目记 failed，墓碑不落账
  }
  const now = new Date().toISOString()
  await withManifestLock(store, machineId, (m) => ({ manifest: markDeleted(m, kind, name, now), result: null }))
}

// ---------- prune：清理超期 trash 与墓碑 ----------

export interface PruneOptions {
  /** 硬删除墓碑（默认 false：只清超期 trash） */
  hardDelete?: boolean
  /** trash 保留时长，默认 7 天 */
  trashMaxAgeMs?: number
}

export interface PruneResult {
  trashRemoved: number
  tombstonesRemoved: number
  /** mtime/时间戳都拿不到、本轮不敢删的项数 */
  trashUnknownAge: number
}

export const DEFAULT_TRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 解析 trash 文件名里的落站时间戳：我们的 MOVE 命名恒为 `<zip名>.<epochMs>`。
 * 比服务端 mtime 可靠（不依赖 getlastmodified 返回）。
 */
export function trashEntryAgeMs(name: string, mtime: string | null, now: number): number | null {
  const m = name.match(/\.(\d{13})$/)
  if (m) {
    const at = Number(m[1])
    if (Number.isFinite(at) && at > 0 && at <= now + 60_000) return now - at
  }
  if (mtime) {
    const at = Date.parse(mtime)
    if (!Number.isNaN(at)) return now - at
  }
  return null
}

/**
 * 同步结束后的远端清理：
 * - 回收站文件按时间戳超 7 天物理删除；时间不可判定的**保留**（H-5 修复）；
 * - hardDelete=true 时，墓碑条目永久移除，并清掉对应回收站文件。
 */
export async function pruneRemote(
  store: SyncStore,
  client: WebDavClient,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const maxAge = opts.trashMaxAgeMs ?? DEFAULT_TRASH_MAX_AGE_MS
  const now = Date.now()
  const trash = await client.listDir(TRASH_REL)
  let trashRemoved = 0
  let trashUnknownAge = 0
  for (const item of trash) {
    if (item.type !== 'file') continue
    const age = trashEntryAgeMs(item.name, item.mtime, now)
    if (age === null) {
      trashUnknownAge += 1
      continue
    }
    if (age <= maxAge) continue
    await client.deleteFile(`${TRASH_REL}/${item.name}`)
    trashRemoved += 1
  }

  let tombstonesRemoved = 0
  if (opts.hardDelete) {
    const { manifest } = await store.read()
    const tombstones = manifest.entries.filter((e) => e.deleted)
    if (tombstones.length > 0) {
      // 先清墓碑对应的回收站文件（trash 名 = <原文件名>.<时间戳>）
      for (const tomb of tombstones) {
        const base = path.basename(tomb.file)
        for (const item of trash) {
          if (item.type === 'file' && item.name.startsWith(`${base}.`)) {
            await client.deleteFile(`${TRASH_REL}/${item.name}`).catch(() => undefined)
            trashRemoved += 1
          }
        }
      }
      const next: RemoteManifest = {
        ...manifest,
        updatedAt: new Date().toISOString(),
        entries: manifest.entries.filter((e) => !e.deleted),
      }
      await withManifestLock(store, tombstones[0]?.source.machineId ?? 'prune', (m) => ({
        manifest: { ...m, updatedAt: next.updatedAt, entries: m.entries.filter((e) => !e.deleted) },
        result: null,
      }))
      tombstonesRemoved = tombstones.length
    }
  }
  return { trashRemoved, tombstonesRemoved, trashUnknownAge }
}

export type { MachineInfo, LockHandle, RemoteManifest, RemoteEntry }
export { LOCK_REL }
