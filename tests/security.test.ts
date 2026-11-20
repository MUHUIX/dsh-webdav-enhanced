/*
 * v0.5 安全回归测试：REVIEW-0.4.0.md 的 C-1 / C-2 / C-3 / C-4 修复钉死在这里。
 * 任何一条重新变红 = 信任边界被改破。
 */
import { describe, expect, it } from 'vitest'
import { isSafeEntryName } from '../src/core/manifest.js'
import { assertWithin, pruneBackupDir } from '../src/core/install.js'
import { originAllowed, redactSecrets } from '../src/http.js'
import { trashEntryAgeMs } from '../src/core/webdav-store.js'

describe('安装路径信任边界（C-1）', () => {
  it('远端包名注入样例全部拒收', () => {
    for (const evil of [
      '../../../../Windows/System32/config',
      '..%2f..%2fetc',
      'C:\\Users\\public',
      '/etc/cron.d/x',
      'ok-name/../../etc',
      '',
      'x'.repeat(200),
      'name with spaces',
      '名字中文',
    ]) {
      expect(isSafeEntryName(evil), `must reject: ${evil}`).toBe(false)
    }
    for (const good of ['dsh-webdav-enhanced', 'a.b_c-d', 'skill-2']) {
      expect(isSafeEntryName(good), `must accept: ${good}`).toBe(true)
    }
  })

  it('assertWithin：越出根目录即抛', () => {
    const root = '/tmp/allow'
    expect(assertWithin(root, '/tmp/allow/pkg', 'x')).toBeTruthy()
    expect(() => assertWithin(root, '/tmp/evil/pkg', 'x')).toThrow(/escapes/)
    expect(() => assertWithin(root, '/etc/passwd', 'x')).toThrow(/escapes/)
  })

  it('maxBackups=0 不再删掉最新一份备份（M-11 由 keep≥1 兜底）', () => {
    // pruneBackupDir 内部 Math.max(1, keep)：传 0 时仍保留 1 份
    // 用不存在目录验证不抛错即可，真实轮转在 install.test 覆盖
    expect(pruneBackupDir('/definitely/not/a/dir', 0)).toEqual([])
  })
})

describe('HTTP 来源守卫（C-3）', () => {
  it('无头本机客户端放行', () => {
    expect(originAllowed({ headers: { host: '127.0.0.1:56559' } } as never)).toBe(true)
  })
  it('跨浏览器 Origin 拒绝', () => {
    expect(
      originAllowed({ headers: { host: '127.0.0.1:56559', origin: 'http://evil.example' } } as never),
    ).toBe(false)
  })
  it('Sec-Fetch-Site: cross-site 拒绝（即便没带 Origin）', () => {
    expect(
      originAllowed({ headers: { host: '127.0.0.1:56559', 'sec-fetch-site': 'cross-site' } } as never),
    ).toBe(false)
  })
  it('同源 / 无 headers 容错放行', () => {
    expect(
      originAllowed({ headers: { host: '127.0.0.1:56559', origin: 'http://127.0.0.1:56559' } } as never),
    ).toBe(true)
    expect(originAllowed({} as never)).toBe(true)
  })
})

describe('错误原文脱敏（L-4）', () => {
  it('URL userinfo 与 key=value 形态都被遮蔽', () => {
    expect(redactSecrets('GET https://user:pw@example.com/dav failed')).toBe('GET https://user:***@example.com/dav failed')
    expect(redactSecrets('password=hunter2 token: abc123')).toBe('password=*** token: ***')
  })
})

describe('trash 过期判定（H-5）', () => {
  const now = Date.UTC(2026, 10, 20, 12)
  it('文件名内嵌时间戳优先', () => {
    expect(trashEntryAgeMs('s@1-aa.zip.' + (now - 8 * 24 * 3600 * 1000), null, now)).toBe(8 * 24 * 3600 * 1000)
  })
  it('无时间戳退回 mtime', () => {
    expect(trashEntryAgeMs('legacy.zip', new Date(now - 1000).toISOString(), now)).toBe(1000)
  })
  it('两者皆无 → null（本轮保留，不再立即物理删除）', () => {
    expect(trashEntryAgeMs('mystery.zip', null, now)).toBeNull()
  })
})
