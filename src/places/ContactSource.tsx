import { useRef, useState } from 'react'
import { AddressBook } from '@phosphor-icons/react'
import { crmAll, crmCommand, crmMessage } from '../crm/client.ts'
import { getWorldGeneration, useRepoStatus } from '../data/repo.ts'

export function ContactSource() {
  const writer=useRepoStatus(s=>s.writer), [busy,setBusy]=useState(false), [message,setMessage]=useState('')
  const running=useRef(false), match=window.worldviewDesktop?.matchContactNames
  async function sync() {
    if (!writer || !match || running.current) return
    const generation=getWorldGeneration()
    let added=0
    running.current=true; setBusy(true); setMessage('Checking names on this Mac…')
    try {
      const people=(await crmAll('people')).filter(p=>!p.mergedIntoId && !p.archivedAt)
      const result=await match(people.map(p=>({id:p.id,name:p.fullName || [p.firstName,p.lastName].filter(Boolean).join(' ')})))
      const ids=new Set(result.ids)
      for (const person of people) {
        if (!ids.has(person.id) || person.tags.includes('Apple Contacts')) continue
        if (generation!==getWorldGeneration()) throw new Error('Workspace changed. Run the match again.')
        await crmCommand({operation:'update',collection:'people',id:person.id,expectedRecordRevision:person.revision,patch:{tags:[...person.tags,'Apple Contacts']}})
        added++
      }
      setMessage(ids.size+' exact matches · '+added+' newly tagged · '+result.ambiguous+' ambiguous names skipped.')
    } catch(e) { setMessage((added ? added+' tagged before the check stopped. ' : '')+crmMessage(e)) }
    finally { running.current=false;setBusy(false) }
  }
  return <section><h3><AddressBook/>Apple Contacts</h3><p>Check names on this Mac and tag existing CRM people with a unique full-name match.</p>
    {match ? <button disabled={!writer || busy} onClick={()=>void sync()}>{busy?'Matching…':'Match Apple Contacts'}</button> : <small>Open the Worldview Mac app to match contacts.</small>}
    {message && <p role="status">{message}</p>}</section>
}
