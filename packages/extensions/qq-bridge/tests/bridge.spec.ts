/**
 * Unit tests for the pure helpers of {@link QqBridge}: reply splitting, the
 * workspace/session listing backed by the GUI storage records, and help text.
 *
 * @module @deepseek-ai/dsh-qq-bridge/tests/bridge
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HELP_TEXT, listRecentSessions, splitMessage,
} from '../src/bridge.ts'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
  tempDirs.length = 0
  delete process.env.DSH_HOME
})

/** Write `workspace.json` + `session_projcache.json` into a temp DSH_HOME. */
async function makeStorages(home: string, data: {
  workspaces: Record<string, { path?: string; title?: string; sessionIds?: string[] }>
  archived?: string[]
  titles?: Record<string, string>
}): Promise<void> {
  const storages = join(home, 'storages')
  await mkdir(storages, { recursive: true })
  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: Object.keys(data.workspaces), archivedSessionIds: data.archived ?? [] },
    tables: { workspaces: data.workspaces },
  }
  const proj = {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: Object.fromEntries(Object.entries(data.titles ?? {}).map(([id, title]) => [
        id,
        { identity: { cwd: '' }, rows: { title: { ver: 1, seq: 1, val: title } } },
      ])),
    },
  }
  await writeFile(join(storages, 'workspace.json'), JSON.stringify(registry), 'utf8')
  await writeFile(join(storages, 'session_projcache.json'), JSON.stringify(proj), 'utf8')
}

describe('splitMessage', () => {
  it('returns a short message untouched', () => {
    expect(splitMessage('hello', 4000)).toEqual(['hello'])
  })

  it('splits at the exact boundary without extra chunks', () => {
    expect(splitMessage('12345', 5)).toEqual(['12345'])
  })

  it('splits long messages and ordinals every chunk', () => {
    const parts = splitMessage('a'.repeat(9), 4)
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('(1/3) aaaa')
    expect(parts[1]).toBe('(2/3) aaaa')
    expect(parts[2]).toBe('(3/3) a')
  })

  it('handles an empty message', () => {
    expect(splitMessage('', 4000)).toEqual([''])
  })
})

describe('listRecentSessions', () => {
  it('groups sessions by workspace with titles, cwd workspace first', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-qq-bridge-'))
    tempDirs.push(home)
    process.env.DSH_HOME = home
    const cwd = process.cwd().replaceAll('\\', '/')

    await makeStorages(home, {
      workspaces: {
        'ws-other': { path: 'D:/Other/Project', title: 'other', sessionIds: ['session-old'] },
        'ws-cwd': { path: cwd, title: 'cwd-project', sessionIds: ['session-a', 'session-b'] },
      },
      titles: { 'session-a': '第一个会话标题', 'session-old': '旧会话标题' },
    })

    const recent = await listRecentSessions(5)
    // cwd workspace first, sessions newest-first in registry order.
    expect(recent.map(session => session.workspaceTitle)).toEqual(['cwd-project', 'cwd-project', 'other'])
    expect(recent[0]).toMatchObject({ id: 'session-a', title: '第一个会话标题', workspaceTitle: 'cwd-project' })
    expect(recent[1]?.id).toBe('session-b')
    expect(recent[2]?.id).toBe('session-old')
  })

  it('respects the limit and skips archived sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-qq-bridge-'))
    tempDirs.push(home)
    process.env.DSH_HOME = home

    await makeStorages(home, {
      workspaces: {
        ws: { path: process.cwd(), title: 'ws', sessionIds: ['session-1', 'session-2', 'session-archived'] },
      },
      archived: ['session-archived'],
    })

    const recent = await listRecentSessions(1)
    expect(recent).toHaveLength(1)
    expect(recent[0]?.id).toBe('session-1')
  })

  it('tolerates a missing storages root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-qq-bridge-'))
    tempDirs.push(home)
    process.env.DSH_HOME = home
    expect(await listRecentSessions(5)).toEqual([])
  })
})

describe('HELP_TEXT', () => {
  it('documents every supported command', () => {
    for (const command of ['/mulu', '/目录', '/huihua', '/new', '/link', '/forget', '/help']) {
      expect(HELP_TEXT).toContain(command)
    }
  })
})
