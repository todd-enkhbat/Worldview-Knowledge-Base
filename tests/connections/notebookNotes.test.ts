// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { notePreview, noteResults } from '../../src/connections/notebookNotes.ts'

it('keeps the selected Granola meeting separate from AI summaries and agent background', () => {
  const src={structured:null,content:'<pagination next_cursor="next"/><meetings_data><meeting id="one" title="Reading group" meeting_at="2026-01-10" updated_at="2026-01-12"><private_notes>My notes</private_notes><summary>A summary</summary><context_for_agents>Context</context_for_agents></meeting></meetings_data>'}
  const page=noteResults('granola','meeting',src)
  expect(page.next).toBe('next')
  expect(notePreview('granola','meeting',page.rows[0],src)).toMatchObject({id:'one',date:'2026-01-10',modified:'2026-01-12',parts:[{text:'My notes',role:'unknown'},{text:'A summary',role:'assistant'}]})
})
it('uses the Wispr scratchpad identity and refuses a mismatched selected note', () => {
  const src={content:'',structured:{notes:[{id:'abc',title:'Reading list',modified_at:'2026-11-01'}],next_cursor:null}}
  const {rows}=noteResults('wispr','scratchpad',src)
  expect(rows[0].title).toBe('Reading list')
  expect(()=>notePreview('wispr','scratchpad',rows[0],{content:'',structured:{id:'another',content:'different'}})).toThrow('different note')
  expect(notePreview('wispr','scratchpad',rows[0],{content:'',structured:{id:'abc',content:'Source text'}}).parts[0]).toMatchObject({role:'unknown',text:'Source text'})
})
