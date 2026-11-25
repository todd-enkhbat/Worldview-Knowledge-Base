// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupAppearanceDialog, GroupIdentity } from '../../src/crm/GroupAppearance.tsx'
import { createCrmRecord, crmAssetReferences, emptyCrm, validateCrmRow } from '../../src/crm/model.ts'
import { groupAppearance } from '../../src/crm/groupAppearanceModel.ts'

const mocks = vi.hoisted(() => ({ command: vi.fn(), portrait: vi.fn() }))
vi.mock('../../src/crm/client.ts', () => ({ crmCommand: mocks.command, crmMessage: (value: unknown) => value instanceof Error ? value.message : String(value) }))
vi.mock('../../src/crm/commentMedia.ts', () => ({ retainCrmPortrait: mocks.portrait }))
vi.mock('../../src/data/repo.ts', () => ({ isRepoReady: () => false, getStore: vi.fn(), getWorldGeneration: () => 1 }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const group = { ...createCrmRecord('groups', { id: 'g', name: 'Columbia', description: 'University connections' }, 1), revision: 4 }
const imageId = `crm-avatar-${'a'.repeat(64)}`, oldImageId = `crm-avatar-${'b'.repeat(64)}`
const button = (label: string) => { const value = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === label); if (!value) throw new Error(`Missing ${label}`); return value }
async function input(selector: string, value: string) { await act(async () => { const element = host.querySelector<HTMLInputElement>(selector)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); mocks.command.mockReset(); mocks.portrait.mockReset(); mocks.command.mockResolvedValue({ ok: true }); Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute('open', '') } }); Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute('open') } }) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('Group appearance persistence and originals', () => {
  it('derives contextual display defaults without mutating source records', () => { expect(groupAppearance(group)).toMatchObject({ icon: 'graduation', coverStyle: 'contours', coverPosition: 50 }); expect(group.icon).toBeUndefined(); expect(group.coverStyle).toBeUndefined(); expect(validateCrmRow('groups', group)).toEqual(group) })
  it.each([{ coverAssetId: 'https://tracker.example/image.png' }, { iconAssetId: '../private' }, { coverPosition: NaN }, { coverDim: 81 }, { titleColor: 'url(javascript:bad)' }, { icon: 'unknown' }, { emoji: '\n' }])('rejects invalid appearance data %j', patch => { expect(() => validateCrmRow('groups', { ...group, ...patch })).toThrow() })
  it('retains group pictures and covers referenced by archived records, history and proposals', () => {
    const snapshot = emptyCrm(); snapshot.groups.push({ ...group, archivedAt: 100, iconAssetId: imageId }); snapshot.history.push(createCrmRecord('history', { id: 'h', collection: 'groups', recordId: group.id, before: { ...group, coverAssetId: oldImageId }, after: group }, 1)); snapshot.proposals.push(createCrmRecord('proposals', { id: 'proposal', collection: 'groups', targetId: group.id, patch: { coverAssetId: imageId } }, 1)); expect([...crmAssetReferences(snapshot)].sort()).toEqual([imageId, oldImageId].sort())
  })
  it('saves emoji, palette and cover choices against the captured group revision', async () => {
    const onSaved = vi.fn(), onClose = vi.fn(); await act(async () => root.render(<GroupAppearanceDialog group={group} onSaved={onSaved} onClose={onClose} />)); await act(async () => [...host.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === 'Use 🪐 for this group')!.click()); await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Use accent #476d88"]')!.click()); await act(async () => button('Save appearance').click()); expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ operation: 'update', collection: 'groups', id: group.id, expectedRecordRevision: 4, patch: expect.objectContaining({ emoji: '🪐', iconAssetId: null, color: '#476d88', coverStyle: 'contours' }) })); expect(onSaved).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce()
  })
  it('retains selected original picture bytes before saving its identity', async () => {
    mocks.portrait.mockResolvedValue({ assetId: imageId, name: 'portrait.png', mime: 'image/png', bytes: 20 }); await act(async () => root.render(<GroupAppearanceDialog group={group} onClose={() => {}} />)); const chosen = new File(['picture'], 'portrait.png', { type: 'image/png' }), picker = host.querySelector<HTMLInputElement>('input[aria-label="Group picture file"]')!; await act(async () => { Object.defineProperty(picker, 'files', { configurable: true, value: [chosen] }); picker.dispatchEvent(new Event('change', { bubbles: true })) }); expect(mocks.portrait).toHaveBeenCalledWith(chosen, expect.objectContaining({ shouldWrite: expect.any(Function) })); expect(mocks.command).not.toHaveBeenCalled(); await act(async () => button('Save appearance').click()); expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ iconAssetId: imageId, iconOriginal: expect.objectContaining({ name: 'portrait.png' }) }) }))
  })
  it('keeps customizations after a stale save and never silently adopts a newer revision', async () => {
    mocks.command.mockRejectedValue(new Error('This group changed elsewhere. Review its latest version.')); const close = vi.fn(); await act(async () => root.render(<GroupAppearanceDialog group={group} onClose={close} />)); await input('input.crm-group-emoji-input', '🌿'); await act(async () => root.render(<GroupAppearanceDialog group={{ ...group, revision: 9 }} onClose={close} />)); await act(async () => button('Save appearance').click()); expect(mocks.command).toHaveBeenCalledWith(expect.objectContaining({ expectedRecordRevision: 4 })); expect(host.querySelector<HTMLInputElement>('input.crm-group-emoji-input')!.value).toBe('🌿'); expect(host.textContent).toContain('changed elsewhere'); expect(close).not.toHaveBeenCalled()
  })
  it('disables appearance mutations in a read-only window', async () => { await act(async () => root.render(<GroupAppearanceDialog group={group} disabled onClose={() => {}} />)); expect(button('Save appearance').disabled).toBe(true); expect(host.querySelector('fieldset')!.disabled).toBe(true); expect(mocks.command).not.toHaveBeenCalled() })
  it('renders a native emoji as the group identity when no retained picture is chosen', async () => { await act(async () => root.render(<GroupIdentity group={{ ...group, emoji: '🎓' }} />)); expect(host.textContent).toBe('🎓'); expect(host.querySelector('img')).toBeNull() })
})
