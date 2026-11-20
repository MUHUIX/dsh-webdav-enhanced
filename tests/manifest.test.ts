import { describe, expect, it } from 'vitest'
import {
  emptyManifest,
  entryKey,
  isSafeEntryName,
  isSafeRemoteFile,
  markDeleted,
  remoteZipRelPath,
  upsertEntry,
  validateRemoteManifest,
} from '../src/core/manifest.js'
import type { RemoteEntry } from '../src/types.js'

function mkEntry(over: Partial<RemoteEntry>): RemoteEntry {
  return {
    kind: 'skill',
    name: 's1',
    version: '1.0.0',
    hash: 'a'.repeat(64),
    file: 'skills/s1@1.0.0-aaaaaaaa.zip',
    size: 100,
    source: { machineId: 'm1', platform: 'win32', dshVersion: null },
    firstSeenAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    deleted: false,
    ...over,
  }
}

describe('manifest', () => {
  it('upsert creates new entry with timestamps', () => {
    const m = emptyManifest()
    const next = upsertEntry(m, mkEntry({}), '2026-01-02T00:00:00Z')
    expect(next.entries).toHaveLength(1)
    expect(next.entries[0].firstSeenAt).toBe('2026-01-02T00:00:00Z')
  })

  it('upsert dedupes by hash (no update when unchanged)', () => {
    const m = upsertEntry(emptyManifest(), mkEntry({}), '2026-01-01T00:00:00Z')
    const again = upsertEntry(m, mkEntry({}), '2026-06-01T00:00:00Z')
    expect(again.entries).toHaveLength(1)
    expect(again.entries[0].updatedAt).toBe('2026-01-01T00:00:00Z') // 未变则不动
  })

  it('upsert bumps updatedAt when hash changes', () => {
    const m = upsertEntry(emptyManifest(), mkEntry({}), '2026-01-01T00:00:00Z')
    const changed = upsertEntry(m, mkEntry({ hash: 'b'.repeat(64), size: 200, file: 'skills/s1@1.0.0-bbbbbbbb.zip' }), '2026-06-01T00:00:00Z')
    expect(changed.entries[0].updatedAt).toBe('2026-06-01T00:00:00Z')
    expect(changed.entries[0].hash).toBe('b'.repeat(64))
  })

  it('markDeleted writes tombstone, keeps entry', () => {
    const m = upsertEntry(emptyManifest(), mkEntry({}), '2026-01-01T00:00:00Z')
    const killed = markDeleted(m, 'skill', 's1', '2026-02-01T00:00:00Z')
    expect(killed.entries[0].deleted).toBe(true)
    expect(killed.entries[0].updatedAt).toBe('2026-02-01T00:00:00Z')
  })

  it('entryKey is kind+name', () => {
    expect(entryKey({ kind: 'bundle', name: 'x' })).toBe('bundle:x')
  })

  it('remoteZipRelPath uses full 64-hex hash (no 32-bit collision)', () => {
    const p = remoteZipRelPath(mkEntry({}))
    expect(p).toMatch(/^skills\/s1@1\.0\.0-a{64}\.zip$/)
  })

  it('remoteZipRelPath rejects unsafe entry names', () => {
    expect(() => remoteZipRelPath(mkEntry({ name: '../evil' }))).toThrow(/unsafe entry name/)
    expect(() => remoteZipRelPath(mkEntry({ name: 'a/b' }))).toThrow(/unsafe entry name/)
  })

  it('isSafeEntryName / isSafeRemoteFile 边界', () => {
    expect(isSafeEntryName('dsh-webdav-enhanced')).toBe(true)
    // v0.5 真机验证发现的回归：npm scope 包名必须放行（曾因未处理 '/' 被误杀）
    expect(isSafeEntryName('@hytime/dsh-thinking-effort')).toBe(true)
    expect(isSafeEntryName('@michengai/dsh-archive-manager')).toBe(true)
    expect(isSafeEntryName('../../etc')).toBe(false)
    expect(isSafeEntryName('a/b')).toBe(false) // 非 scope 的裸斜杠仍拒
    expect(isSafeEntryName('@a/b/c')).toBe(false) // scope 只允许一段 org
    expect(isSafeEntryName('@/x')).toBe(false)
    expect(isSafeEntryName('C:\\x')).toBe(false)
    expect(isSafeEntryName('')).toBe(false)
    expect(isSafeRemoteFile('skills/a@1-deadbeef.zip')).toBe(true)
    expect(isSafeRemoteFile('bundles/@hytime_pkg@1-deadbeef.zip')).toBe(true)
    expect(isSafeRemoteFile('bundles/../escape.zip')).toBe(false)
    expect(isSafeRemoteFile('/abs/x.zip')).toBe(false)
    expect(isSafeRemoteFile('trash/x.zip')).toBe(false) // 只允许三个已知子目录
  })

  it('remoteZipRelPath 把 scope 名的斜杠压平，不凭空造远端子目录', () => {
    const p = remoteZipRelPath({ kind: 'bundle', name: '@hytime/dsh-thinking-effort', version: '0.3.12', hash: 'f'.repeat(64) })
    expect(p).toBe('bundles/@hytime_dsh-thinking-effort@0.3.12-' + 'f'.repeat(64) + '.zip')
    expect(p.split('/').length).toBe(2) // 仅 bundles/ + 文件名
  })

  it('validateRemoteManifest：坏条目丢弃、版本拒读、结构容错', () => {
    const good = {
      kind: 'skill', name: 'ok-skill', version: '1.0.0', hash: 'a'.repeat(64),
      file: 'skills/ok-skill@1.0.0-' + 'a'.repeat(64) + '.zip', size: 10,
      source: { machineId: 'm1', platform: 'linux', dshVersion: null },
      firstSeenAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', deleted: false,
    }
    const { manifest, dropped } = validateRemoteManifest({
      version: 1, updatedAt: 'x',
      entries: [
        good,
        { ...good, name: '../evil', hash: 'b'.repeat(64) },
        { ...good, name: 'bad-hash', hash: 'zz' },
        { ...good, name: 'bad-file', hash: 'c'.repeat(64), file: '/etc/passwd' },
        null,
      ],
    })
    expect(manifest.entries.length).toBe(1)
    expect(dropped.length).toBe(4)
    expect(() => validateRemoteManifest({ version: 99, entries: [] })).toThrow(/版本/)
    expect(() => validateRemoteManifest('not object')).toThrow()
    expect(() => validateRemoteManifest({ version: 1, entries: 'x' })).toThrow()
  })
})
