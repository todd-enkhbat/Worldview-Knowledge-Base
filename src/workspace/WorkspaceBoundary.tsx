import { Component, type ReactNode } from 'react'

/** A failed lazy download must leave a recovery action instead of an empty screen. */
export class WorkspaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  override render() {
    if (!this.state.failed) return this.props.children
    return <main className="workspace-recovery" role="alert"><h1>Your workspace could not open</h1><p>Your saved record is retained. Reload to reconnect and open it again.</p><button type="button" onClick={() => location.reload()}>Reload workspace</button></main>
  }
}
