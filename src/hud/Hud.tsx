import { useWorld } from '../app/store.ts'
import { ArchetypePicker } from './ArchetypePicker.tsx'
import { Banners } from './Banners.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { DemonPanel } from './DemonPanel.tsx'
import { FirstRun } from './FirstRun.tsx'
import { Inspector } from './Inspector.tsx'
import { Library } from './Library.tsx'
import { ModeHint } from './ModeHint.tsx'
import { NodeEditor } from './NodeEditor.tsx'
import { ProximityCard } from './ProximityCard.tsx'
import { Settings } from './Settings.tsx'
import { SplatCrystallising, SplatFraming } from './SplatFraming.tsx'
import { StatsPanel } from './StatsPanel.tsx'
import { Timeline } from './Timeline.tsx'
import { TopBar } from './TopBar.tsx'
import { Trash } from './Trash.tsx'
import { UndoToast } from './UndoToast.tsx'
import { useGlobalShortcuts } from './shortcuts.ts'

// DOM overlay over the canvas. The root lets the pointer through to the world; panels and
// controls take it back. Layout: a top strip (TopBar, then durability Banners) and below it
// a stage for the docked panels, so Banners push the panels down instead of covering them.
// Modals (picker, editor, settings, trash, palette, first run) and toasts position
// themselves (fixed).

// Anything interactive inside the HUD receives the pointer even if its owner forgot to
// opt in; plain text and empty layout boxes stay click-through.
const POINTER_OPT_IN =
  '[&_.hud-panel]:pointer-events-auto [&_[role=dialog]]:pointer-events-auto [&_[role=alertdialog]]:pointer-events-auto [&_button]:pointer-events-auto [&_a]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_label]:pointer-events-auto'

export function Hud() {
  useGlobalShortcuts()
  const ready = useWorld((s) => s.loaded && s.settings?.firstRunComplete === true)

  return (
    <div className={`pointer-events-none fixed inset-0 z-10 flex flex-col font-mono text-bone ${POINTER_OPT_IN}`}>
      <div className="flex shrink-0 flex-col gap-2 p-3">
        {ready && <TopBar />}
        <Banners />
      </div>

      {ready && (
        <>
          <div className="relative min-h-0 flex-1">
            <Library />
            <Inspector />
            <ProximityCard />
            <StatsPanel />
            <ModeHint />
            <DemonPanel />
            <SplatFraming />
            <SplatCrystallising />
          </div>
          {/* In the flow under the stage, so bottom-docked panels sit above it. */}
          <Timeline />
          <ArchetypePicker />
          <NodeEditor />
          <Settings />
          <Trash />
          <CommandPalette />
        </>
      )}

      <FirstRun />
      <UndoToast />
    </div>
  )
}
