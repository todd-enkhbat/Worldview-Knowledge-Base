import type { WritingAppearance, WritingFormat, WritingNode } from './types.ts'
import { defaultWritingAppearance } from './model.ts'

export const WRITING_FORMS: { id: WritingFormat; name: string; description: string; sections: string[] }[] = [
  { id: 'note', name: 'Blank page', description: 'Start anywhere. Follow the thought.', sections: [] },
  { id: 'essay', name: 'Essay', description: 'An opening, an argument, a point of view.', sections: ['The idea', 'A closer look', 'What follows'] },
  { id: 'newsletter', name: 'Newsletter', description: 'A personal opening and stories worth sharing.', sections: ['This week', 'Worth your attention', 'One last thought'] },
  { id: 'journal', name: 'Journal', description: 'A little space to notice and reflect.', sections: ['What happened', 'What I noticed', 'What I want to remember'] },
  { id: 'poem', name: 'Poem', description: 'Room for a different rhythm.', sections: [] },
  { id: 'research', name: 'Research note', description: 'Questions, observations, and evidence.', sections: ['The question', 'Observations', 'Evidence & sources', 'Open questions'] },
]
export function writingTemplate(format: WritingFormat): WritingNode {
  const sections = WRITING_FORMS.find((entry) => entry.id === format)?.sections ?? []
  return { type: 'doc', content: [{ type: 'paragraph' }, ...sections.flatMap((heading) => [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: heading }] }, { type: 'paragraph' }])] }
}
export const WRITING_DESIGNS: { name: string; appearance: WritingAppearance }[] = [
  { name: 'Paper', appearance: defaultWritingAppearance() },
  { name: 'Clean', appearance: { ...defaultWritingAppearance(), fontFamily: 'sans', pageColor: '#ffffff', textColor: '#252832', accentColor: '#426a80', backgroundColor: '#edeff2', waveColor: '#b9c8d1' } },
  { name: 'Midnight', appearance: { ...defaultWritingAppearance(), pageColor: '#202428', textColor: '#e2e5e8', accentColor: '#a3bacb', backgroundColor: '#14181d', waveColor: '#415363', background: 'waves', waveIntensity: 32 } },
  { name: 'Sage', appearance: { ...defaultWritingAppearance(), pageColor: '#f7f8f2', textColor: '#29392e', accentColor: '#57745c', backgroundColor: '#dce4da', waveColor: '#93ac98', background: 'gradient' } },
  { name: 'Ocean', appearance: { ...defaultWritingAppearance(), pageColor: '#f8fafb', textColor: '#253b4a', accentColor: '#416d86', backgroundColor: '#dce5eb', waveColor: '#8aaec3', background: 'waves', waveIntensity: 30 } },
]
