// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { libraryDestination, parseAppRoute } from '../../src/workspace/routes.ts'
import { exploreWorkspaceRecord, QUICK_CAPTURE_DRAFT_LIMIT, rememberReaderPosition, restoreWorkspaceContext, returnToWorkspace, setQuickCaptureDraft, setWorkspaceQuery, setWorkspaceSources, useWorkspace, validateWorkspaceContext, workspaceHomeHash } from '../../src/workspace/state.ts'

beforeEach(() => {
  localStorage.clear()
  restoreWorkspaceContext()
  location.hash = '#/search'
})

describe('knowledge workspace navigation', () => {
  it('bounds the separate quick-capture draft, preserves functional edits and restores older contexts safely', () => {
    expect(validateWorkspaceContext({ draft: 'Today draft', quickCaptureDraft: 25 })).toMatchObject({ draft: 'Today draft', quickCaptureDraft: '' })
    expect(validateWorkspaceContext({ quickCaptureDraft: 'x'.repeat(QUICK_CAPTURE_DRAFT_LIMIT + 10) }).quickCaptureDraft).toHaveLength(QUICK_CAPTURE_DRAFT_LIMIT)
    setQuickCaptureDraft('First line')
    setQuickCaptureDraft((previous) => `${previous}\nSecond line`)
    expect(useWorkspace.getState().quickCaptureDraft).toBe('First line\nSecond line')
    restoreWorkspaceContext()
    expect(useWorkspace.getState().quickCaptureDraft).toBe('First line\nSecond line')
    setQuickCaptureDraft('x'.repeat(QUICK_CAPTURE_DRAFT_LIMIT + 10))
    expect(useWorkspace.getState().quickCaptureDraft).toHaveLength(QUICK_CAPTURE_DRAFT_LIMIT)
  })

  it('keeps daily reading separate from the optional spatial renderer and preserves lab routes', () => {
    expect(parseAppRoute('')).toBe('today')
    expect(parseAppRoute('#/library?record=note')).toBe('library')
    expect(parseAppRoute('#/search')).toBe('search')
    expect(parseAppRoute('#/todos')).toBe('todos')
    expect(validateWorkspaceContext({ lastSection: 'todos', returnHash: '#/todos' })).toMatchObject({ lastSection: 'todos', returnHash: '#/todos' })
    expect(parseAppRoute('#/knowledge?page=topic')).toBe('knowledge')
    expect(parseAppRoute('#/explore?record=note')).toBe('world')
    expect(parseAppRoute('#/lab/perf')).toBe('perf')
    expect(parseAppRoute('#/lab/s1')).toBe('s1')
    expect(parseAppRoute('#/sandbox/nodes', true)).toBe('sandbox')
    expect(parseAppRoute('#/sandbox/nodes', false)).toBe('today')
  })

  it('returns from a spatial investigation without losing source scope, question, selection or reading position', () => {
    location.hash = '#/library?passage=quote-one'
    setWorkspaceQuery('Why did I choose local storage?')
    setWorkspaceSources(['source-a', 'source-b'])
    useWorkspace.setState({ selectedPassageId: 'quote-one', lastSection: 'library' })
    rememberReaderPosition('quote-one', 435)
    exploreWorkspaceRecord('record-a')
    expect(location.hash).toBe('#/explore?record=record-a')
    returnToWorkspace()
    expect(location.hash).toBe('#/library?passage=quote-one')
    expect(useWorkspace.getState()).toMatchObject({ query: 'Why did I choose local storage?', sourceIds: ['source-a', 'source-b'], selectedRecordId: 'record-a', selectedPassageId: 'quote-one', readerPositions: { 'quote-one': 435 } })
    restoreWorkspaceContext()
    expect(workspaceHomeHash()).toBe('#/library?passage=quote-one')
    expect(useWorkspace.getState().readerPositions['quote-one']).toBe(435)
  })

  it('separates saved research context by account and rejects unsafe resume destinations', () => {
    restoreWorkspaceContext('person-one')
    setWorkspaceQuery('A private research question')
    setWorkspaceSources(['secret-source'])
    restoreWorkspaceContext('person-two')
    expect(useWorkspace.getState().query).toBe('')
    expect(useWorkspace.getState().sourceIds).toEqual([])
    restoreWorkspaceContext('person-one')
    expect(useWorkspace.getState().query).toBe('A private research question')
    localStorage.setItem('worldview.workspace.v1:person-two', JSON.stringify({ returnHash: 'https://example.com/steal', lastSection: 'not-a-section' }))
    restoreWorkspaceContext('person-two')
    expect(useWorkspace.getState().returnHash).toBe('#/today')
    expect(workspaceHomeHash()).toBe('#/today')
  })

  it('keeps exact citation and digest identifiers in readable deep links', () => {
    expect(libraryDestination('#/library?passage=source%3Aversion%3A2&digest=abc')).toEqual({ recordId: null, passageId: 'source:version:2', sourceId: null, digest: 'abc' })
    expect(libraryDestination('#/library?record=note-id')).toEqual({ recordId: 'note-id', passageId: null, sourceId: null, digest: null })
  })

  it('retains the maintained page destination after a 3D round trip and reload', () => {
    location.hash = '#/knowledge?page=topic-one'
    exploreWorkspaceRecord('reference-node')
    restoreWorkspaceContext()
    returnToWorkspace()
    expect(location.hash).toBe('#/knowledge?page=topic-one')
  })
})
