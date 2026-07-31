import { describe, expect, it } from 'vitest'
import { parseExtraDirs, resolveFileAccess } from './file-access.js'

describe('resolveFileAccess', () => {
  it('workspace səviyyəsində yalnız cwd verilir', () => {
    const r = resolveFileAccess({
      fileAccess: 'workspace',
      extraDirsJson: '["/tmp/başqa"]',
      cwd: '/repo',
    })
    expect(r).toEqual({ level: 'workspace', dirs: ['/repo'] })
  })

  it('extended səviyyəsində əlavə qovluqlar da daxil olur', () => {
    const r = resolveFileAccess({
      fileAccess: 'extended',
      extraDirsJson: '["/b","/a"]',
      cwd: '/repo',
    })
    // Sıra DETERMİNİSTDİR — keşin sınmaması bundan asılıdır (qayda 1).
    expect(r.dirs).toEqual(['/a', '/b', '/repo'])
  })

  it('təkrarlanan qovluq bir dəfə verilir', () => {
    const r = resolveFileAccess({
      fileAccess: 'extended',
      extraDirsJson: '["/repo","/repo"]',
      cwd: '/repo',
    })
    expect(r.dirs).toEqual(['/repo'])
  })

  it('read-only səviyyəsi qovluğu yenə verir — oxumaq üçün lazımdır', () => {
    const r = resolveFileAccess({
      fileAccess: 'read-only',
      extraDirsJson: '[]',
      cwd: '/repo',
    })
    expect(r).toEqual({ level: 'read-only', dirs: ['/repo'] })
  })

  it('cwd yoxdursa dirs boş qalır', () => {
    const r = resolveFileAccess({
      fileAccess: 'workspace',
      extraDirsJson: '[]',
      cwd: undefined,
    })
    expect(r.dirs).toEqual([])
  })

  it('tanınmayan səviyyə workspace sayılır — icra dayanmır', () => {
    const r = resolveFileAccess({
      fileAccess: 'zibil',
      extraDirsJson: '[]',
      cwd: '/repo',
    })
    expect(r.level).toBe('workspace')
  })
})

describe('parseExtraDirs', () => {
  it('sınıq JSON boş massiv verir', () => {
    expect(parseExtraDirs('{{{')).toEqual([])
  })

  it('massiv olmayan JSON boş massiv verir', () => {
    expect(parseExtraDirs('"/tmp"')).toEqual([])
  })

  it('sətir olmayan elementlər atılır', () => {
    expect(parseExtraDirs('["/a",5,null,"/b"]')).toEqual(['/a', '/b'])
  })

  it('boş sətirlər atılır', () => {
    expect(parseExtraDirs('["/a","","  "]')).toEqual(['/a'])
  })
})
