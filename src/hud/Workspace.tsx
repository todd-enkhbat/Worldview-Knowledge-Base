import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, ArrowsClockwise, BookOpen, CaretDown, ChatCircle, Compass, DotsThree, FileText, GearSix, Info, Leaf, MagnifyingGlass, Pause, Planet, Play, Plus, Robot, Sparkle, Stack, Sun, UploadSimple } from '@phosphor-icons/react'
import { useApp, useWorld } from '../app/store.ts'
import { seedDemo, useRepoStatus } from '../data/repo.ts'
import { buildTypedLinks } from '../world/links/style.ts'
import { recenterWorld } from '../world/camera/OrbitRig.tsx'
import { stopOrbitMotion, toggleOrbitMotion, useOrbitMotion } from '../world/camera/orbitMotion.ts'
import { spatialGroundFor } from '../world/environment/knowledgeGround.ts'
import { exploreDistrict } from '../world/environment/exploreDistrict.ts'
import { MOD_KEY, canNavigateTo, navigateTo, openPalette, openPicker, selectAndFly, setWorldView } from './shortcuts.ts'
import { openSceneFilePicker } from './SceneDrop.tsx'
import { Sources } from './Sources.tsx'
import { Reflection } from './Reflection.tsx'
import { Agents } from './Agents.tsx'
import { OPEN_AGENTS_EVENT, openAgentsPanel } from '../world/agents/model.ts'
import { ProductDialog } from './ProductDialog.tsx'
import { returnToWorkspace } from '../workspace/state.ts'

function revealWorld() {
  if (window.matchMedia('(max-width: 660px)').matches) useApp.getState().togglePanel('chat', false)
}

export function WorkspaceNav() {
  const nodes = useWorld((s) => s.nodes)
  const library = useApp((s) => s.panels.library)
  const selected = useApp((s) => s.selectedId)
  const fallback = useRepoStatus((s) => s.fallback)
  const writer = useRepoStatus((s) => s.writer)
  const [modal, setModal] = useState<'sources' | 'reflection' | 'agents' | null>(null)
  useEffect(() => { const open = () => setModal('agents'); window.addEventListener(OPEN_AGENTS_EVENT, open); return () => window.removeEventListener(OPEN_AGENTS_EVENT, open) }, [])
  const agentCount = useMemo(() => [...nodes.values()].filter((r) => r.archetype === 'demon' && r.demon?.active && r.demon.query.trim()).length, [nodes])
  const recent = useMemo(() => [...nodes.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5), [nodes])
  return <>
    <aside className="workspace-nav" aria-label="Main navigation">
      <a className="workspace-brand" href="#/" aria-label="Worldview home"><Planet size={29} weight="duotone" /><span>Worldview</span></a>
      <button className="workspace-search" onClick={() => openPalette()} title={`Search your world (${MOD_KEY}K)`}><MagnifyingGlass size={17} /><span>Search your world</span><kbd>{MOD_KEY}K</kbd></button>
      <button aria-label="Add to your world" className="workspace-add" onClick={() => useApp.getState().togglePanel('chat', true)} disabled={!writer}><Plus size={18} /><span>Add to your world</span></button>
      <nav className="workspace-links">
        <button aria-label="Return to knowledge workspace" onClick={() => returnToWorkspace()}><BookOpen size={20} /><span>Back to workspace</span></button>
        <button aria-label="My world" className={!library ? 'is-active' : ''} onClick={() => { revealWorld(); useApp.getState().togglePanel('library', false); useApp.getState().setMode('orbit'); recenterWorld() }}><Compass size={20} /><span>My world</span></button>
        <button aria-label="Library" className={library ? 'is-active' : ''} onClick={() => { revealWorld(); useApp.getState().togglePanel('library') }}><BookOpen size={20} /><span>Library</span><small>{nodes.size}</small></button>
        <button aria-label="Agents" className={modal === 'agents' ? 'is-active' : ''} onClick={() => setModal('agents')}><Robot size={20} /><span>Agents</span><small>{agentCount || 'Guide'}</small></button>
        <button aria-label="Daily reflection" onClick={() => setModal('reflection')}><Sun size={20} /><span>Daily reflection</span></button>
        <button aria-label="Sources" onClick={() => setModal('sources')}><Stack size={20} /><span>Sources</span></button>
      </nav>
      <div className="workspace-recents"><h2>Recently added</h2>
        {recent.length ? recent.map((n) => <button key={n.id} aria-current={selected === n.id ? 'true' : undefined} onClick={() => { revealWorld(); selectAndFly(n.id) }} title={n.title}><span className={`recent-icon kind-${n.archetype}`}>{n.archetype === 'idea' ? <Sparkle size={18} /> : n.archetype === 'memory' ? <Leaf size={18} /> : <FileText size={18} />}</span><span><strong>{n.title}</strong><small>{n.archetype} · {new Date(n.temporalOrigin).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</small></span></button>) : <p>Your thoughts, memories, and files will appear here.</p>}
      </div>
      <footer className="workspace-nav-footer"><button aria-label="Settings and backups" onClick={() => useApp.getState().togglePanel('settings', true)}><GearSix size={19} /><span>Settings & backups</span></button><div><span className={`storage-dot ${writer ? '' : 'is-readonly'}`} /><span>{fallback ? 'Session storage' : 'Saved locally'}{writer ? '' : ' · Read only'}</span></div></footer>
    </aside>
    {modal === 'agents' && <Agents onClose={() => setModal(null)} />}
    {modal === 'sources' && <Sources onClose={() => setModal(null)} />}
    {modal === 'reflection' && <Reflection onClose={() => setModal(null)} />}
  </>
}

export function WorldToolbar() {
  const nodes = useWorld((s) => s.nodes)
  const neighborhoods = useMemo(() => spatialGroundFor(nodes), [nodes])
  const count = nodes.size
  const connections = useMemo(() => buildTypedLinks(nodes).length, [nodes])
  const memories = useMemo(() => [...nodes.values()].filter((n) => n.archetype === 'memory').length, [nodes])
  const flow = useApp((s) => s.view.flow)
  const field = useApp((s) => s.view.world === 'field')
  const chat = useApp((s) => s.panels.chat)
  const mode = useApp((s) => s.mode)
  const orbiting = useOrbitMotion((s) => s.playing)
  const writer = useRepoStatus((s) => s.writer)
  const [tools, setTools] = useState(false)
  const [help, setHelp] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const navigation = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!navigationOpen) return
    const outside = (event: PointerEvent) => { if (!navigation.current?.contains(event.target as Node)) setNavigationOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setNavigationOpen(false); navigation.current?.querySelector('button')?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [navigationOpen])
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState('')
  const example = async () => {
    setSeedBusy(true)
    try { await seedDemo(); recenterWorld() } catch (e) { setSeedError(e instanceof Error ? e.message : 'Could not load the example') } finally { setSeedBusy(false) }
  }
  const controlsHint = mode === 'third_person' ? 'WASD walk · Drag to look · O orbit'
    : mode === 'autonav' ? 'Following dated memories · Esc to stop'
      : mode === 'orbit' ? orbiting ? 'Orbiting · Drag or scroll to take control' : 'Select a cluster to explore · Drag to rotate · Scroll to zoom'
        : 'WASD move · Q / E down / up · Esc to leave'
  return <>
    <header className="world-toolbar">
      <div><h1>Your world</h1><p>{count ? `${count} ${count === 1 ? 'note' : 'notes'} · ${connections} saved ${connections === 1 ? 'link' : 'links'}` : 'Add a thought, memory, or file to begin'}</p></div>
      <div className="world-toolbar-actions">
        <div className="world-view-switch" aria-label="Render treatment">
          <button aria-label="World view" aria-pressed={field} title="Embodied notes in three-dimensional neighborhoods" onClick={() => setWorldView('field')}><Planet size={17} /><span>World</span></button>
          <button aria-label="Structure view" aria-pressed={!field} title="The same spatial positions, with structural detail" onClick={() => setWorldView('classic')}><Stack size={17} /><span>Structure</span></button>
        </div>
        {field && <button className="world-motion-control" aria-label={flow ? 'Pause scene motion' : 'Resume scene motion'} title="Agents, particles, and galaxy motion. History has its own play control." aria-pressed={flow} onClick={() => { useApp.getState().setView({ flow: !flow }); if (flow) stopOrbitMotion() }}>{flow ? <Pause size={15} /> : <Play size={15} />}<span>{flow ? 'Motion on' : 'Motion paused'}</span></button>}
        <button className="world-icon-button" aria-label={chat ? 'Hide conversation' : 'Open conversation'} title="Conversation" onClick={() => useApp.getState().togglePanel('chat')}><ChatCircle size={22} /></button>
        <div className="world-tools">
          <button className="world-icon-button" aria-label="World tools" aria-expanded={tools} onClick={() => setTools(!tools)}><DotsThree size={25} /></button>
          {tools && <div className="world-tools-menu">
            <button onClick={() => { openAgentsPanel(); setTools(false) }}><Robot size={17} />Meet your agents</button>
            <button onClick={() => { openPicker(); setTools(false) }} disabled={!writer}><Plus size={17} />Create a note</button>
            <button onClick={() => { openSceneFilePicker(); setTools(false) }} disabled={!writer}><UploadSimple size={17} />Import a 3D capture</button>
            <button onClick={() => { useApp.getState().togglePanel('demons'); setTools(false) }}><MagnifyingGlass size={17} />Saved queries</button>
            <button onClick={() => { useApp.getState().togglePanel('stats'); setTools(false) }}><ArrowSquareOut size={17} />Physics diagnostics</button>
          </div>}
        </div>
      </div>
    </header>
    {count === 0 && <div className="world-empty">
      <span className="world-empty-mark"><Sparkle size={28} weight="duotone" /></span>
      <h2>Your world starts here.</h2><p>Related thoughts form neighborhoods.<br />Add something to give it a place in your world.</p>
      <button className="product-primary" disabled={!writer} onClick={() => useApp.getState().togglePanel('chat', true)}>Add your first thought</button>
      <button className="world-example-button" disabled={seedBusy || !writer} onClick={() => void example()}>{seedBusy ? 'Loading sample notes…' : 'Explore an example world'}</button>
      <small>Loads sample notes into this world.</small>{seedError && <p role="alert">{seedError}</p>}
    </div>}
    <div className="world-guide" data-label-avoid>
      <button className="world-guide-help" aria-label="How to read and navigate your world" onClick={() => setHelp(true)}><Info size={16} /></button>
      <div><p className="world-axis-cue">3D neighborhoods · timeline = history · lines = saved links</p><p className="world-control-cue">{controlsHint}</p></div>
    </div>
    {help && <ProductDialog title="Read your world" description="Explore meaning in three dimensions, and revisit it through time." onClose={() => setHelp(false)}>
      <dl className="world-help">
        <div><dt>XYZ is space</dt><dd>Notes occupy a three-dimensional world. Height is spatial elevation, not a calendar date. Both World and Structure use the same neighborhood positions.</dd></div>
        <div><dt>Neighborhoods follow meaning</dt><dd>Shared topics and saved relationships bring notes into related regions. A note's embodiment and size help identify its kind and significance. Nearby notes do not automatically become saved links.</dd></div>
        <div><dt>Read the things themselves</dt><dd>Ideas have crystals, documents have slabs, and memories have frames. Select a title or object to read its text, date, links and original media. Imported Gaussian splat captures can be entered as 3D scenes.</dd></div>
        <div><dt>Lines are saved relationships</dt><dd>Open Links for the key, or select a connection to see what it means. Use Link to… on a note to add a relationship. Nearby objects alone do not create a saved link.</dd></div>
        <div><dt>Move through your world</dt><dd>Walk world explores at ground level. Ride memories follows memories in date order and needs at least two memories. Fly explores freely. O returns to orbit; Esc leaves a ride or flight.</dd></div>
        <div><dt>Revisit and correct dates</dt><dd>Play or scrub the timeline to reveal notes as they entered your world. Back to today restores the present. Select a note to read its history date separately from its spatial position. Editing that date changes when it appears, not its neighborhood.</dd></div>
        <div><dt>Capture stays simple</dt><dd>Drop original files into chat or type a thought. Save writes it directly to your world; Send asks the AI assistant for help. A single photo remains an image unless you supply a 3D capture.</dd></div>
      </dl>
    </ProductDialog>}
    <div className="world-explore-tools" aria-label="World navigation">
      {mode === 'orbit' ? <button className="world-orbit-control" aria-pressed={orbiting} onClick={() => toggleOrbitMotion()}><ArrowsClockwise size={17} /><span>{orbiting ? 'Stop orbit' : 'Orbit scene'}</span></button>
        : <button className="world-orbit-control" disabled={!canNavigateTo('orbit', mode)} onClick={() => navigateTo('orbit')}><Compass size={17} />Return to orbit</button>}
      <button className="world-frame-control" aria-label="Recenter world" title="Frame the whole world" onClick={() => recenterWorld()}><Compass size={16} /><span>Frame world</span></button>
      <div ref={navigation} className="world-navigation-picker">
        <button aria-expanded={navigationOpen} aria-controls="world-navigation-choices" onClick={() => setNavigationOpen(!navigationOpen)}>Navigate<CaretDown size={13} /></button>
        {navigationOpen && <div id="world-navigation-choices" className="world-navigation-choices" aria-label="Navigation choices">
          {neighborhoods.districts.length > 0 && <>
            <p className="world-navigation-section-title">Clusters</p>
            <div className="world-navigation-clusters">
              {neighborhoods.districts.map((district) => <button key={district.id} className="world-navigation-cluster" aria-label={`Explore ${district.label} cluster`} disabled={!canNavigateTo('orbit', mode)} onClick={() => { exploreDistrict(neighborhoods, district); setNavigationOpen(false) }}><span>{district.label}</span><small>{district.count} {district.count === 1 ? 'note' : 'notes'}</small></button>)}
            </div>
            <p className="world-navigation-section-title is-separated">Move freely</p>
          </>}
          <button disabled={!canNavigateTo('third_person', mode)} onClick={() => { navigateTo('third_person'); setNavigationOpen(false) }}><Compass size={17} /><span>Walk world<small>WASD · follow the ground</small></span><kbd>T</kbd></button>
          <button disabled={!canNavigateTo('first_person', mode)} onClick={() => { navigateTo('first_person'); setNavigationOpen(false) }}><ArrowSquareOut size={17} /><span>Fly freely<small>Move through all three dimensions</small></span><kbd>F</kbd></button>
          <button disabled={memories < 2 || !canNavigateTo('autonav', mode)} onClick={() => { navigateTo('autonav'); setNavigationOpen(false) }}><Play size={17} /><span>Ride memories<small>{memories < 2 ? 'Add at least two memories' : 'Visit memories in date order'}</small></span></button>
        </div>}
      </div>
    </div>
  </>
}
