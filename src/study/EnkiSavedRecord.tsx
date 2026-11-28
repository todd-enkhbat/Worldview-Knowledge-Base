import { useEffect, useRef } from 'react'
import { mountOrganizationEditor, type ReaderRecord } from '../../extensions/worldview-reader/organization-ui.js'
import readerStyles from '../../extensions/worldview-reader/popup.css?inline'
import type { ProfileBridge } from './EnkiPerson.tsx'

const styles = readerStyles.slice(readerStyles.search(/#organization-editor\s*\{/))

export function EnkiSavedRecord({ bridge, previewId, entityType }: {
  bridge: ProfileBridge; previewId: string; entityType: 'person' | 'company'
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current || !bridge.organization) return
    let model: ReaderRecord | undefined
    const request = async (fields: Record<string, unknown>): Promise<ReaderRecord> => {
      if (fields.action === 'organization-logo') {
        const company = model?.connections?.find(company => company.id === fields.companyId)
        if (!company?.logoAssetId || !/^crm-avatar-[a-f0-9]{64}$/.test(company.logoAssetId)) throw Error('No saved logo.')
        const response = await fetch('/api/blobs/' + encodeURIComponent(company.logoAssetId), {
          headers: { 'x-wv-client': 'enki-record' }, signal: AbortSignal.timeout(8000),
        })
        if (!response.ok) throw Error('The saved logo could not be loaded.')
        const blob = await response.blob()
        if (!blob || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw Error('No supported saved logo.')
        const logo = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(Error('The logo could not be read.'))
          reader.readAsDataURL(blob)
        })
        return { record: {}, logo }
      }
      const updated = await bridge.organization!(previewId, fields)
      if ('record' in updated) model = updated
      return updated
    }
    const open = (type: 'person' | 'company', id: string) => {
      if (bridge.openLinkedRecord) void bridge.openLinkedRecord(previewId, type, id)
    }
    return mountOrganizationEditor(host.current, {
      actionHost: host.current.closest('.enki-profile')?.querySelector<HTMLElement>('.enki-record-actions'),
      request, entityType, personLink: id => open('person', id), companyLink: id => open('company', id), onChange() {},
    })
  }, [bridge, previewId, entityType])
  return <div className="enki-saved-record">
    <style>{styles}</style>
    <div id="organization-editor" ref={host} />
  </div>
}
