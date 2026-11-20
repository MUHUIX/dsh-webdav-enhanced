/*
 * 本地凭据存储：WebDAV 密码单独落盘，不进 cordis 配置、不进远端、不进日志。
 * 注意（README 同步修订）：0600 仅 POSIX 有效；Windows 上依赖用户目录 ACL，
 * mode 只是尽力声明。v0.5 起写入原子化（唯一 tmp + rename），
 * 读取失败不再静默归零——置 lastError 供 host 记一条 warn 日志。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DATA_DIRNAME } from './config-store.js'

export const CREDENTIALS_FILENAME = 'credentials.json'

interface CredentialsFile {
  password?: string
}

export class CredentialStore {
  private readonly filePath: string
  /** 最近一次读取失败原因（host 用于"密码看起来没配过"时向用户如实报告） */
  lastError: string | null = null

  constructor(dshHome: string) {
    const dir = path.join(dshHome, DATA_DIRNAME)
    mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, CREDENTIALS_FILENAME)
  }

  /** 读取明文密码；文件缺失或损坏返回空串（损坏时置 lastError） */
  read(): string {
    try {
      this.lastError = null
      if (!existsSync(this.filePath)) return ''
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as CredentialsFile
      return typeof raw.password === 'string' ? raw.password : ''
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      return ''
    }
  }

  write(password: string): void {
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    let fd: number | null = null
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, JSON.stringify({ password }, null, 2), { encoding: 'utf8', mode: 0o600 })
      try {
        fsyncSync(fd)
        closeSync(fd)
        fd = null
      } catch {
        /* 平台不支持 fsync：继续 rename */
      }
      renameSync(tmp, this.filePath)
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* ignore */
        }
      }
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      throw err
    }
  }

  clear(): void {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
    } catch {
      /* 尽力而为 */
    }
  }
}
