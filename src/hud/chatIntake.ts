import { useApp } from '../app/store.ts'
import { fileToIntake, importVault, readDirectoryEntry, type IntakeItem } from '../ai/chat/apply.ts'
import { stage, useChat } from '../ai/chat/session.ts'

// Drop anything (milestone 1): a folder is read as an Obsidian vault and imported at once
// (no Claude needed); files become staged attachments for the next chat message. Directory
// entries must be taken from the DataTransfer synchronously, inside the drop event.

export function entriesOf(dt: DataTransfer | null): FileSystemEntry[] {
  if (!dt) return []
  const out: FileSystemEntry[] = []
  for (const item of Array.from(dt.items)) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    if (entry) out.push(entry)
  }
  return out
}

/** Open the chat and take in what was dropped or picked. */
export async function intake(files: readonly File[], entries: readonly FileSystemEntry[] = []): Promise<void> {
  useApp.getState().togglePanel('chat', true)
  const dirs = entries.filter((e): e is FileSystemDirectoryEntry => e.isDirectory)
  const dirNames = new Set(dirs.map((d) => d.name))
  const errors: string[] = []
  const staged: IntakeItem[] = []

  for (const dir of dirs) {
    try {
      const vault = await readDirectoryEntry(dir)
      if (!vault.length) {
        errors.push(`${dir.name} has no markdown notes.`)
        continue
      }
      const r = await importVault(vault)
      staged.push({
        name: `Vault · ${dir.name} (${r.added} notes)`,
        kind: 'text',
        bytes: 0,
        block: {
          type: 'text',
          text: `[ui:imported] I imported my Obsidian vault "${dir.name}": ${r.added} notes added${r.skipped ? `, ${r.skipped} already here` : ''}${r.unresolved ? `, ${r.unresolved} links to notes outside it` : ''}. Their kinds and dates came from frontmatter or file dates; help me fix any that look wrong.`,
        },
      })
    } catch (e) {
      errors.push(`${dir.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  for (const f of files) {
    if (dirNames.has(f.name) && f.size === 0) continue // the folder itself, already handled
    const item = await fileToIntake(f)
    if ('error' in item) errors.push(item.error)
    else staged.push(item)
  }
  if (staged.length) stage(staged)
  useChat.setState({ error: errors.length ? errors.join(' ') : null })
}

/** Import a vault picked with <input webkitdirectory> (no directory entries there). */
export async function intakeVaultFiles(files: readonly File[]): Promise<void> {
  useApp.getState().togglePanel('chat', true)
  const md = files.filter((f) => /\.md$/i.test(f.name) && !/(^|\/)\./.test(f.webkitRelativePath))
  if (!md.length) return void useChat.setState({ error: 'That folder has no markdown notes.' })
  const root = md[0].webkitRelativePath.split('/')[0] || 'vault'
  try {
    const vault = await Promise.all(md.map(async (f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/') || f.name, text: await f.text(), lastModified: f.lastModified })))
    const r = await importVault(vault)
    stage([
      {
        name: `Vault · ${root} (${r.added} notes)`,
        kind: 'text',
        bytes: 0,
        block: { type: 'text', text: `[ui:imported] I imported my Obsidian vault "${root}": ${r.added} notes added${r.skipped ? `, ${r.skipped} already here` : ''}.` },
      },
    ])
    useChat.setState({ error: null })
  } catch (e) {
    useChat.setState({ error: e instanceof Error ? e.message : String(e) })
  }
}
