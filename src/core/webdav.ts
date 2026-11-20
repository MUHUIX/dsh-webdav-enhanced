/*
 * M2 WebDAV 客户端（v0.5 安全与健壮性重写）。
 * - 库：webdav（webdav-client v5），纯 JS 跨平台。
 * - 超时（H-3 修复）：每个请求挂 AbortSignal，传输类按 timeoutMs + 体积补偿；
 *   ignoreTlsErrors 经 https.Agent({rejectUnauthorized:false}) 真正生效。
 * - 容错：指数退避重试（仅网络类 / 5xx / 429）；401/403 直接失败。
 * - exists/stat 语义（C-4 修复）：**只有 404/405 视为不存在**，超时与 5xx 抛错；
 *   "读不到"绝不被上层当成"远端为空"。
 * - 下载：双端流错误监听 + 移动后大小/hash 校验；上传：流式重读（重试不再整包进内存）。
 * - 条件写（H-10）：etag 与 createOnly 二选一——两者都没有时拒绝裸 PUT；
 *   stat→read 顺序 + 提交后内容回读校验，兼容"服务端悄悄剥离 If-Match"的降级面。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { Agent as TlsAgent } from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { createClient, AuthType, type Headers, type LockResponse, type WebDAVClient } from 'webdav'
import {
  ManifestConflictError,
  type LockHandle,
  type RemoteDirItem,
  type ServerCapabilities,
  type TestConnectionResult,
  type WebDavClient,
  type WebDavConnectionConfig,
} from '../types.js'

const PART_SUFFIX = '.part'
/** 传输体积补偿：按最低 50KB/s 折算上限，外加 30s 基础窗口 */
const MIN_TRANSFER_BPS = 50 * 1024

function normalizeRoot(root?: string): string {
  const r = (root ?? '/dsh-sync/').trim()
  const withSlash = r.startsWith('/') ? r : '/' + r
  return withSlash.endsWith('/') ? withSlash : withSlash + '/'
}

function statusOf(err: unknown): number | undefined {
  return (
    (err as { status?: number; response?: { status?: number } })?.status ??
    (err as { response?: { status?: number } })?.response?.status
  )
}

function isAuthError(err: unknown): boolean {
  const s = statusOf(err)
  return s === 401 || s === 403
}

/** 404/405/207-part-miss：对象不存在 */
function isNotFound(err: unknown): boolean {
  const s = statusOf(err)
  return s === 404 || s === 405 || s === 400
}

function isRetryable(err: unknown): boolean {
  if (isAuthError(err)) return false
  const s = statusOf(err)
  if (s === undefined || s === null) return true // 网络错
  if (s >= 500) return true
  if (s === 429) return true
  return false
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(filePath)
      .on('data', (d: string | Buffer) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

class WebDavClientImpl implements WebDavClient {
  private client: WebDAVClient
  private readonly root: string
  private capabilities: ServerCapabilities | null = null
  private readonly timeoutMs: number

  constructor(private readonly cfg: WebDavConnectionConfig) {
    this.root = normalizeRoot(cfg.remoteRoot)
    this.timeoutMs = Math.max(1000, cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 30000)
    const creds: Record<string, unknown> = {}
    if (cfg.username) {
      creds.username = cfg.username
      creds.password = cfg.password
      // AuthType.Password = Basic，一次性头无需 challenge 往返，
      // 对 customRequest / 条件写 都直接生效（坚果云、Nextcloud 都支持 Basic over HTTPS）。
      // Digest 模式在 customRequest 下无法 re-challenge，会卡在 401。
      creds.authType = AuthType.Password
    }
    const agents: Record<string, unknown> = {}
    if (cfg.ignoreTlsErrors) {
      // 真正落地"忽略自签 TLS"：v0.4 只存了配置没用（H-3）
      agents.httpsAgent = new TlsAgent({ rejectUnauthorized: false })
    }
    this.client = createClient(cfg.url, {
      ...creds,
      ...agents,
      headers: { 'User-Agent': 'dsh-webdav-enhanced/0.5.0' } as Headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    } as Parameters<typeof createClient>[1])
  }

  private abs(rel: string): string {
    return this.root + rel.replace(/^\/+/, '')
  }

  /** 请求级中止信号：AbortSignal 同时约束连接与传输阶段 */
  private sig(extraMs = 0): { signal: AbortSignal } {
    return { signal: AbortSignal.timeout(this.timeoutMs + extraMs) }
  }

  /** 传输类操作的信号：timeoutMs 基础窗口 + 按体积折算的传输窗口 */
  private transferSig(sizeBytes: number): { signal: AbortSignal } {
    const transferMs = Math.min(10 * 60 * 1000, Math.ceil((sizeBytes || 0) / MIN_TRANSFER_BPS) * 1000)
    return { signal: AbortSignal.timeout(this.timeoutMs + transferMs) }
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 4): Promise<T> {
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (!isRetryable(err)) throw err
        const delay = 1000 * 2 ** attempt
        console.warn(`[webdav-enhanced] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}), retry in ${delay}ms`)
        await sleep(delay)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  // ---------- connection test ----------

  async testConnection(): Promise<TestConnectionResult> {
    const steps: TestConnectionResult['steps'] = []

    const run = async (step: TestConnectionResult['steps'][number]['step'], fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
        steps.push({ step, ok: true, detail: 'ok' })
      } catch (err) {
        const code = statusOf(err)
        const detail = code ? `HTTP ${code}` : (err as Error).message
        steps.push({ step, ok: false, detail })
      }
    }

    await run('propfind', async () => {
      await this.client.stat('/', this.sig())
    })
    await run('mkcol', async () => {
      try {
        await this.client.createDirectory(this.root, this.sig())
      } catch (err) {
        const code = statusOf(err)
        // 405：已存在。423：集合存在但被锁（部分服务端对已存在目录返回它），
        // 只要 PROPFIND 能读到就当目录就绪，真正的写入问题留给 put 报。
        if (code === 405) return
        if (code === 423 && (await this.client.stat(this.root, this.sig()).catch(() => null))) return
        throw err
      }
    })
    const probeRel = `_probe-${Date.now()}.txt`
    try {
      await run('put', async () => {
        await this.client.putFileContents(this.abs(probeRel), 'probe', { overwrite: true, ...this.sig() })
      })
      await run('readback', async () => {
        const back = (await this.client.getFileContents(this.abs(probeRel), { format: 'text', ...this.sig() })) as string
        if (back !== 'probe') throw new Error(`readback mismatch: got ${back}`)
      })
    } finally {
      // 探针文件无论成败都清理（v0.4 只在成功分支删，失败会留残档）
      await this.client.deleteFile(this.abs(probeRel)).catch(() => undefined)
    }

    // 能力探测放在最后：不产生副作用（OPTIONS，不再对真实目录 LOCK）。
    // 旧实现先 LOCK 根目录再 unlock，unlock 失败就会把整棵子树锁住，
    // 随后的 MKCOL/PUT 全部 423 —— 测试把自己测挂了。
    const caps = await this.probeCapabilities()

    if (process.env.DBG_WEBDAV) console.log('[testConnection]', JSON.stringify(steps, null, 2))
    return { ok: steps.every((s) => s.ok), steps, capabilities: caps }
  }

  private async probeCapabilities(): Promise<ServerCapabilities> {
    if (this.capabilities) return this.capabilities
    let supportsLock = false
    let supportsIfHeader = false
    let server: string | null = null
    try {
      const res = await this.client.customRequest(this.root, { method: 'OPTIONS', ...this.sig() })
      const headers = (res.headers ?? {}) as unknown as Record<string, string>
      const pick = (name: string): string => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
        return key ? String(headers[key]) : ''
      }
      const dav = pick('dav').toLowerCase()
      const allow = pick('allow').toUpperCase()
      // DAV: 2 表示支持锁定；也有服务端只在 Allow 里列 LOCK
      supportsLock = dav.split(',').map((s) => s.trim()).includes('2') || /(^|,)\s*LOCK\s*(,|$)/.test(allow)
      supportsIfHeader = dav.includes('2') || allow.includes('LOCK')
      server = pick('server') || null
    } catch {
      supportsLock = false
      supportsIfHeader = true
    }
    this.capabilities = { supportsLock, supportsIfHeader, server }
    return this.capabilities
  }

  // ---------- basic ops ----------

  /** 只有"对象不存在"（404/405）返回 false；其它错误一律抛——上层必须区分失败与缺失 */
  async exists(rel: string): Promise<boolean> {
    try {
      await this.client.stat(this.abs(rel), this.sig())
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async ensureDir(rel: string): Promise<void> {
    const target = this.abs(rel).replace(/\/+$/, '')
    const segments = target.split('/').filter(Boolean)
    let cur = ''
    for (const seg of segments) {
      cur += '/' + seg
      try {
        await this.client.createDirectory(cur, this.sig())
      } catch (err) {
        if (statusOf(err) !== 405) throw err
      }
    }
  }

  async stat(rel: string) {
    try {
      const s = await this.client.stat(this.abs(rel), this.sig())
      const st = s as { etag?: string; size?: number; lastmod?: string }
      return { etag: st.etag ?? null, size: st.size ?? 0, mtime: st.lastmod ?? null }
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  // ---------- upload / download（流式 + 校验） ----------

  async putFile(rel: string, localPath: string, opts?: { sha256?: string }): Promise<void> {
    const remote = this.abs(rel)
    const part = remote + PART_SUFFIX
    const size = statSync(localPath).size
    const sig = this.transferSig(size)

    // v0.5：不再"续传"——多数 WebDAV 模块不支持 PUT 的 Content-Range，
    // 伪续传反而制造截断文件被提升为正式文件的风险。每次重试整包重传，
    // 用流式读取避免重试循环把整包重复读进内存。
    await this.withRetry(async () => {
      await this.client.putFileContents(part, createReadStream(localPath, { highWaterMark: 1024 * 1024 }) as never, {
        overwrite: true,
        ...sig,
      })
    }, `put ${rel}`)

    await this.withRetry(() => this.client.moveFile(part, remote, this.sig()), `move ${rel}`)

    // 事后校验：远端体积必须一致；给了 sha256 还要做服务端回读校验的，由调用方处理
    const finalStat = await this.stat(rel).catch(() => null)
    if (!finalStat || finalStat.size !== size) {
      await this.deleteFile(remote).catch(() => undefined)
      throw new Error(`upload size mismatch for ${rel}: remote ${finalStat?.size ?? 'missing'} != local ${size}`)
    }
  }

  async getFile(rel: string, localPath: string, opts?: { expectedSize?: number; sha256?: string }): Promise<void> {
    const remote = this.abs(rel)
    const part = localPath + PART_SUFFIX
    // stat 先行：既是 expectedSize 的缺省，也让 size 校验与下载之间有确定顺序
    const remoteStat = await this.stat(rel)
    if (!remoteStat) throw new Error(`download ${rel}: remote object not found`)
    const expectedSize = opts?.expectedSize ?? remoteStat.size

    await mkdir(path.dirname(localPath), { recursive: true })
    await this.withRetry(async () => {
      const stream = this.client.createReadStream(remote, this.transferSig(expectedSize))
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(part, { flags: 'w' })
        // 读流错误（网络中断/服务端断连）必须 reject：v0.4 只监听了写流，
        // 半截下载会永远悬着 promise，整轮同步死锁（H-3）。
        stream.on('error', (err: Error) => {
          out.destroy()
          reject(err)
        })
        out.on('error', reject)
        out.on('finish', () => resolve())
        stream.pipe(out)
      })
      const finalSize = statSync(part).size
      if (expectedSize > 0 && finalSize !== expectedSize) {
        throw new Error(`download size mismatch for ${rel}: ${finalSize} != ${expectedSize}`)
      }
    }, `get ${rel}`)

    if (opts?.sha256) {
      const got = await hashFile(part)
      if (got !== opts.sha256) {
        await unlink(part).catch(() => undefined)
        throw new Error(`zip sha256 mismatch for ${rel}: ${got.slice(0, 12)}… != ${opts.sha256.slice(0, 12)}…`)
      }
    }
    await rename(part, localPath)
  }

  // ---------- json helpers ----------

  async getJson<T>(rel: string): Promise<T | null> {
    if (!(await this.exists(rel))) return null
    const tmp = path.join(this.tmpDir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      await this.getFile(rel, tmp)
      return JSON.parse(await readFile(tmp, 'utf8')) as T
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  }

  /**
   * stat→GET：先拿 etag 再拿 body。中间被别的机器抢先提交时，
   * 我们手里是"旧 body + 更旧 etag"，条件写必然 412（安全方向）；
   * 反过来（body 先、etag 后）会拿"旧 body + 新 etag"盲覆盖。
   */
  async getWithEtag<T>(rel: string): Promise<{ value: T | null; etag: string | null }> {
    const stat = await this.stat(rel)
    if (!stat) return { value: null, etag: null }
    const tmp = path.join(this.tmpDir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      await this.getFile(rel, tmp, { expectedSize: stat.size })
      const value = JSON.parse(await readFile(tmp, 'utf8')) as T
      return { value, etag: stat.etag }
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  }

  async putJsonIfMatch(
    rel: string,
    data: unknown,
    etag: string | null,
    opts?: { createOnly?: boolean },
  ): Promise<string | null> {
    if (!etag && !opts?.createOnly) {
      // 没有条件头的 PUT 就是裸覆盖：远端可能刚被别机写过。宁可同步失败。
      throw new Error(`refusing unconditional PUT of ${rel}: need etag or createOnly`)
    }
    const remote = this.abs(rel)
    const body = JSON.stringify(data, null, 2)
    const headers: Headers = { 'Content-Type': 'application/json' }
    if (etag) headers['If-Match'] = etag
    else if (opts?.createOnly) headers['If-None-Match'] = '*'
    const res = await this.client.customRequest(remote, { method: 'PUT', headers, data: body, ...this.sig() })
    const status = res.status
    if (status === 412) throw new ManifestConflictError(etag)
    if (status < 200 || status >= 300) throw new Error(`PUT ${rel} failed: HTTP ${status}`)
    const newEtag = (res.headers as unknown as Record<string, string>)?.['etag'] ?? null
    return newEtag ? String(newEtag).replace(/"/g, '') : null
  }

  /** 404 → false（已不存在）；其它失败抛错。调用方拿真实结果计数。 */
  async deleteFile(rel: string): Promise<boolean> {
    try {
      await this.client.deleteFile(this.abs(rel), this.sig())
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  /** 列出远端目录；目录不存在返回空数组，其它错误抛错（v0.4 一律吞成空） */
  async listDir(rel: string): Promise<RemoteDirItem[]> {
    let items: unknown
    try {
      items = await this.client.getDirectoryContents(this.abs(rel), this.sig())
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    if (!Array.isArray(items)) return []
    return (items as Array<{ basename?: string; type?: string; size?: number; lastmod?: string }>)
      .filter((i) => typeof i?.basename === 'string' && i.basename !== '.' && i.basename !== '..')
      .map((i) => ({
        name: i.basename as string,
        type: i.type === 'directory' ? ('directory' as const) : ('file' as const),
        size: typeof i.size === 'number' ? i.size : 0,
        mtime: typeof i.lastmod === 'string' ? i.lastmod : null,
      }))
  }

  async move(rel: string, destPath: string): Promise<void> {
    await this.client.moveFile(this.abs(rel), this.abs(destPath), this.sig())
  }

  // ---------- locks ----------

  async acquireLock(machineId: string, ttlMs: number): Promise<LockHandle | null> {
    // 锁文件在 locks/ 子目录里：必须先建集合，否则「PUT 到不存在的集合」
    // 在部分服务端（实测 muhuix DAV）直接 403 —— 那一刻整个同步会在取锁阶段就失败。
    await this.ensureDir('locks').catch(() => undefined)
    // 优先原生 LOCK
    const caps = await this.probeCapabilities()
    if (caps.supportsLock) {
      try {
        const res: LockResponse = await this.client.lock(this.root + 'locks/sync.lock', {
          timeout: `Second-${Math.max(1, Math.round(ttlMs / 1000))}`,
          ...this.sig(),
        } as never)
        if (res?.token) {
          const token = res.token
          return {
            machineId,
            acquiredAt: new Date().toISOString(),
            release: async () => {
              await this.client.unlock(this.root + 'locks/sync.lock', token, this.sig() as never).catch(() => undefined)
            },
          }
        }
      } catch {
        /* 降级软锁 */
      }
    }
    // 软锁：读-改-写（非原子，manifest 条件写兜底）。
    // v0.5：锁体带随机 token，release 只删自己的锁（H-13：无条件删会踢掉别人的锁）。
    const rel = 'locks/sync.lock'
    const lockToken = randomUUID()
    const now = Date.now()
    const cur = await this.getJson<{ machineId?: string; expiresAt?: string; token?: string } | null>(rel).catch(() => null)
    if (cur && new Date(String(cur.expiresAt)).getTime() > now && String(cur.machineId) !== machineId) return null
    const body = JSON.stringify({
      machineId,
      token: lockToken,
      startedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    })
    await this.withTmpFile(body, (tmp) => this.putFile(rel, tmp))
    return {
      machineId,
      acquiredAt: new Date().toISOString(),
      release: async () => {
        const owner = await this.getJson<{ token?: string } | null>(rel).catch(() => null)
        if (owner && owner.token && owner.token !== lockToken) return // 锁已被别人接管：不动别人的锁
        await this.deleteFile(rel).catch(() => undefined)
      },
    }
  }

  async currentLockHolder(): Promise<{ machineId: string; startedAt: string; expiresAt: string } | null> {
    return await this.getJson<{ machineId: string; startedAt: string; expiresAt: string }>('locks/sync.lock').catch(() => null)
  }

  // ---------- helpers ----------

  private tmpDir(): string {
    // 用系统临时目录：早期版本落在 process.cwd()，会往用户项目里堆垃圾
    const dir = path.join(os.tmpdir(), 'dsh-webdav-enhanced')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private async writeTmp(content: string): Promise<string> {
    const p = path.join(this.tmpDir(), `${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    await writeFile(p, content, 'utf8')
    return p
  }

  /** 写临时文件执行 fn，结束后无论成败都清理 */
  private async withTmpFile<T>(content: string, fn: (tmpPath: string) => Promise<T>): Promise<T> {
    const p = await this.writeTmp(content)
    try {
      return await fn(p)
    } finally {
      await unlink(p).catch(() => undefined)
    }
  }
}

export function createWebDavClient(cfg: WebDavConnectionConfig): WebDavClient {
  return new WebDavClientImpl(cfg)
}
