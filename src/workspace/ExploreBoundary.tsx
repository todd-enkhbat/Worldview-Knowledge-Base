import { Component, type ReactNode } from 'react'
import { useWorkspace } from './state.ts'
import './recovery.css'

/** A renderer failure must leave a direct path back to the independently loaded reader. */
export class ExploreBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  override render() {
    if (!this.state.failed) return this.props.children
    return <main className="knowledge-renderer-recovery" role="alert"><div><span>Worldview · Explore</span><h1>The 3D view couldn’t open.</h1><p>Your saved record is available in the knowledge workspace.</p><div><a href={useWorkspace.getState().returnHash || '#/today'}>Return to workspace</a><button onClick={() => this.setState({ failed: false })}>Try 3D again</button></div></div></main>
  }
}
