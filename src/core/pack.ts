/*
 * M3 打包 / 压缩 / 校验。
 * - 上传用 zip（用户需求），库：archiver + unzipper（纯 JS 跨平台，兼容 data descriptor）。
 * - 内容寻址：hash 由目录内容本身决定（与 zip 产物无关），保证跨机一致 → 天然去重。
 * - 解压安全：拒绝路径穿越 + zip 炸弹体积护栏。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { Transform } from 'node:stream'
import path from 'node:path'
import archiver from 'archiver'
import unzipper from 'unzipper'
import {
  DEFAULT_SAFETY_GUARD,
  type LocalEntry,
  type PackMeta,
  type PackedEntry,
  type Packager,
  type SafetyGuard,
} from '../types.js'

const META_FILE = '_meta.json'

// ---------- 默认排除：只排除"不是包内容"的东西 ----------
// 注意：lib/ 与 dist/ 是 bundle 的运行时代码，**必须**纳入 hash 与 zip。
// 早期版本把它们排除，导致 npm 安装的插件（代码在 lib/）改了内容 hash 也不变、
// 上传的 zip 里没有可执行代码 —— 「同步插件」这条主打能力会是坏的。
// v0.5：dot 目录一律排除（.git/.workbuddy*/.box-agent*/.cache 这类开发期残留
// 不该整包上云）；*.log 与测试输出同理。包内容里确需随包 dot 目录时，
// 请在 package `files` 白名单里显式列出（当前实现以目录名 '.' 前缀判定排除）。

const EXCLUDE_DIRS = new Set(['node_modules', 'logs', 'cache'])
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'npm-debug.log', '.vitest.out'])
/** 解压条目数硬上限（zip 炸弹护栏之一：不采信自报体积，只数条目与实际写入字节） */
export const MAX_UNPACK_ENTRIES = 20000

function isExcludedDirName(name: string): boolean {
  return name.startsWith('.') || EXCLUDE_DIRS.has(name)
}

function isExcludedFileName(name: string): boolean {
  return EXCLUDE_FILES.has(name) || /\.log$/i.test(name)
}

function shouldIncludeRel(relPath: string): boolean {
  const segments = relPath.split('/')
  if (segments.some((s) => isExcludedDirName(s))) return false
  return !isExcludedFileName(segments[segments.length - 1])
}

// ---------- hash ----------

export async function hashFileContent(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(filePath)
      .on('data', (d: string | Buffer) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

/** 目录内容的稳定 hash：kind + name + version + 相对路径(排序) + 各文件 sha256 级联 */
export async function hashDirectory(entry: Pick<LocalEntry, 'kind' | 'name' | 'version' | 'sourceDir'>): Promise<string> {
  const h = createHash('sha256')
  h.update(entry.kind)
  h.update('\0')
  h.update(entry.name)
  h.update('\0')
  h.update(entry.version ?? '')
  h.update('\0')

  const files = await collectFiles(entry.sourceDir)
  for (const rel of files.sort()) {
    const abs = path.join(entry.sourceDir, rel)
    h.update(rel)
    h.update('\0')
    h.update(await hashFileContent(abs))
    h.update('\0')
  }
  return h.digest('hex')
}

/** 列出会被纳入内容 hash 的相对路径（scan 的 hash 缓存指纹计算复用） */
export async function collectHashableFiles(dir: string): Promise<string[]> {
  return collectFiles(dir)
}

async function collectFiles(dir: string, base = '', out: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(base ? path.join(dir, base) : dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) {
      if (isExcludedDirName(e.name)) continue
      await collectFiles(dir, rel, out)
    } else if (e.isFile()) {
      if (isExcludedFileName(e.name)) continue
      out.push(rel)
    }
  }
  return out
}

// ---------- zip 命名：完整 hash 寻址（32bit 前缀会碰撞，v0.5 起用全长） ----------

export function zipBaseName(e: Pick<LocalEntry, 'name' | 'version' | 'hash'>): string {
  const ver = e.version ? `@${e.version}` : ''
  return `${e.name.replace(/[^\w.@+-]+/g, '_')}${ver}-${e.hash}`
}

// ---------- Packager ----------

class PackagerImpl implements Packager {
  async pack(entry: LocalEntry, outDir: string): Promise<PackedEntry> {
    mkdirSync(outDir, { recursive: true })
    const hash = await hashDirectory(entry)
    const zipPath = path.join(outDir, `${zipBaseName({ ...entry, hash })}.zip`)

    const meta: PackMeta = {
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      source: entry.machine ?? { machineId: 'unknown', platform: process.platform, dshVersion: null },
      // 来源路径仅存本地日志价值有限、且泄露用户目录结构——v0.5 起脱敏为 basename，
      // 安装侧本就只用 kind/name/version 路由，不消费该字段。
      originalPath: path.basename(entry.sourceDir || ''),
      packedAt: new Date().toISOString(),
      dshVersion: null,
    }

    // 与 hashDirectory **同一份文件清单**入包（v0.5：早期 archiver.glob 的
    // ignore 只锚定根层，嵌套 node_modules 会"进包不进 hash"，
    // 「同 hash 即同内容」不变式破产）。清单来自 collectFiles，逐条 file() 添加。
    const files = (await collectFiles(entry.sourceDir)).sort()
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(zipPath)
      const archive = archiver('zip', { zlib: { level: 6 } })
      output.on('close', () => resolve())
      archive.on('error', reject)
      archive.pipe(output)
      archive.append(JSON.stringify(meta, null, 2), { name: META_FILE })
      for (const rel of files) {
        archive.file(path.join(entry.sourceDir, rel), { name: rel })
      }
      void archive.finalize()
    })

    const size = (await stat(zipPath)).size
    const zipHash = await hashFileContent(zipPath)
    return { entry: { ...entry, hash, sizeBytes: size }, zipPath, sha256: hash, zipHash, size }
  }

  async unpack(zipPath: string, destDir: string, guard: SafetyGuard = DEFAULT_SAFETY_GUARD): Promise<PackMeta> {
    mkdirSync(destDir, { recursive: true })
    const destResolved = path.resolve(destDir)
    let meta: PackMeta | null = null
    let total = 0
    let fileCount = 0

    const dir = await unzipper.Open.file(zipPath)
    if (dir.files.length > MAX_UNPACK_ENTRIES) {
      throw new Error(`zip bomb protection: ${dir.files.length} entries > ${MAX_UNPACK_ENTRIES}`)
    }
    for (const file of dir.files) {
      const rel = file.path.replace(/\\/g, '/')
      if (!shouldIncludeRel(rel)) continue

      const target = path.resolve(destResolved, rel)
      if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
        throw new Error(`unsafe path in zip: ${rel}`)
      }

      if (file.type === 'Directory') {
        // 目录节点跳过（文件写时会 mkdir -p）
        file.stream().resume()
        continue
      }

      // 声明体积只做**便宜的预筛**；真实防线是下面的逐字节累计。
      const declared = file.uncompressedSize
      if (typeof declared === 'number' && declared > guard.maxFileBytes) {
        throw new Error(`file too large: ${rel} (${declared})`)
      }

      if (rel === META_FILE) {
        meta = JSON.parse((await file.buffer()).toString('utf8')) as PackMeta
        continue
      }

      fileCount += 1
      if (fileCount > MAX_UNPACK_ENTRIES) {
        throw new Error(`zip bomb protection: file count > ${MAX_UNPACK_ENTRIES}`)
      }
      mkdirSync(path.dirname(target), { recursive: true })
      // 实际写入字节累计（v0.5：护栏不再采信中央目录自报值——攻击者可控）
      let written = 0
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(target, { flags: 'w' })
        const guardStream = new Transform({
          transform(chunk: Buffer, _enc: string, cb: (e?: Error | null, data?: unknown) => void) {
            written += chunk.length
            if (written > guard.maxFileBytes) return cb(new Error(`file too large (actual): ${rel}`))
            total += chunk.length
            if (total > guard.maxTotalBytes) return cb(new Error(`zip bomb protection (actual): > ${guard.maxTotalBytes}`))
            cb(null, chunk)
          },
        })
        file.stream().pipe(guardStream).pipe(out).on('finish', () => resolve()).on('error', reject)
        out.on('error', reject)
      })
    }

    if (!meta) throw new Error('invalid pack: missing _meta.json')
    return meta
  }

  hashFile(filePath: string): Promise<string> {
    return hashFileContent(filePath)
  }
}

export function createPackager(): Packager {
  return new PackagerImpl()
}
