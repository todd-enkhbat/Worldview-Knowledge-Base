import { useEffect, type ReactNode } from 'react'
import { useApp, useWorld } from '../app/store.ts'
import { ArchetypePicker } from './ArchetypePicker.tsx'
import { Banners } from './Banners.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { DemonPanel } from './DemonPanel.tsx'
import { FirstRun } from './FirstRun.tsx'
import { Inspector } from './Inspector.tsx'
import { Library } from './Library.tsx'
import { ModeHint } from './ModeHint.tsx'
import { NodeEditor } from './NodeEditor.tsx'
import { Omnibox } from './Omnibox.tsx'
import { ProximityCard } from './ProximityCard.tsx'
import { SceneDrop } from './SceneDrop.tsx'
import { Settings } from './Settings.tsx'
import { SplatCrystallising, SplatFraming } from './SplatFraming.tsx'
import { StatsPanel } from './StatsPanel.tsx'
import { Timeline } from './Timeline.tsx'
import { Trash } from './Trash.tsx'
import { UndoToast } from './UndoToast.tsx'
import { useGlobalShortcuts } from './shortcuts.ts'
import { LinkLegend } from './LinkLegend.tsx'
import { Chat } from './Chat.tsx'
import { WorkspaceNav, WorldToolbar } from './Workspace.tsx'
import type { ExploreRecord } from '../world/exploreRecords.ts'

const POINTER_OPT_IN = '[&_.hud-panel]:pointer-events-auto [&_[role=dialog]]:pointer-events-auto [&_[role=alertdialog]]:pointer-events-auto [&_button]:pointer-events-auto [&_a]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_label]:pointer-events-auto'

interface HudProps {
  children?: ReactNode
  records?: readonly ExploreRecord[]
  recordsOpen?: boolean
  onOpenRecords?: (search?: boolean) => void
  onCloseRecords?: () => void
  onFrame?: () => void
}

export function Hud({ children, records, recordsOpen, onOpenRecords, onCloseRecords, onFrame }: HudProps) {
  useGlobalShortcuts(onOpenRecords)
  const ready = useWorld((s) => s.loaded && s.settings?.firstRunComplete === true)
  const noNodes = useWorld((s) => s.nodes.size === 0)
  const empty = noNodes && records === undefined
  const chat = useApp((s) => s.panels.chat)
  // A populated world opens on the world. Empty worlds offer capture as the next action.
  useEffect(() => { if (ready && empty && !window.matchMedia('(max-width: 660px)').matches) useApp.getState().togglePanel('chat', true) }, [ready, empty])
  return <div className={`workspace-hud pointer-events-none fixed inset-0 z-10 font-sans text-bone ${chat ? 'has-chat' : ''} ${POINTER_OPT_IN}`}>
    {ready && <>
      <WorkspaceNav onOpenRecords={onOpenRecords} onFrame={onFrame} />
      <div className="world-hud">
        <WorldToolbar records={records} recordsOpen={recordsOpen} onOpenRecords={onOpenRecords} onCloseRecords={onCloseRecords} onFrame={onFrame} />
        <div className="world-banners"><Banners /></div>
        <div className="world-panels"><Library /><Inspector /><ProximityCard /><StatsPanel /><ModeHint /><LinkLegend /><DemonPanel /><SplatFraming /><SplatCrystallising /></div>
        {children}
        <div className="world-timeline"><Timeline records={records} /></div>
      </div>
      <aside className={`workspace-chat ${chat ? '' : 'is-closed'}`}><Chat embedded /></aside>
      <ArchetypePicker /><NodeEditor /><Settings /><Trash /><CommandPalette /><SceneDrop /><Omnibox />
    </>}
    <FirstRun /><UndoToast />
  </div>
}
