import { useApp } from '../app/store.ts'
import { fileToIntake, importVault, isVault, readDirectoryEntry, type FolderFile, type IntakeItem } from '../ai/chat/apply.ts'
import { formatBytes } from '../ai/chat/preview.ts'
import { stage, useChat } from '../ai/chat/session.ts'

// Drop anything: files become staged attachments for the next chat message (Claude reads
// them, the originals are kept with the notes); a folder of notes is imported as an Obsidian
// vault at once (no Claude); any other folder is staged file by file with its layout.
// Directory entries must be taken from the DataTransfer synchronously, inside the drop event.

/** Files a non-vault folder may stage at once (each one is sent to Claude). */
const MAX_FOLDER_FILES = 60

export function entriesOf(dt: DataTransfer | null): FileSystemEntry[] {
  if (!dt) return []
  const out: FileSystemEntry[] = []
  for (const item of Array.from(dt.items)) {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    if (entry) out.push(entry)
  }
  return out
}

async function intakeFolder(name: string, files: FolderFile[], staged: IntakeItem[], errors: string[]): Promise<void> {
  if (!files.length) return void errors.push(`${name} is empty.`)
  if (isVault(files)) {
    const r = await importVault(files)
    staged.push({
      name: `Vault · ${name} (${r.added} notes)`,
      kind: 'text',
      bytes: 0,
      blocks: [
        {
          type: 'text',
          text: `[ui:imported] I imported my Obsidian vault "${name}": ${r.added} notes added${r.attached ? ` with ${r.attached} attached files` : ''}${r.skipped ? `, ${r.skipped} already here` : ''}${r.unresolved ? `, ${r.unresolved} links to notes outside it` : ''}. Their kinds and dates came from frontmatter or file dates; help me fix any that look wrong.`,
        },
      ],
    })
    return
  }
  const visible = files.filter((f) => !f.path.split('/').some((p) => p.startsWith('.')))
  const take = visible.slice(0, MAX_FOLDER_FILES)
  const layout = visible.map((f) => `${f.path} (${formatBytes(f.file.size)})`)
  staged.push({
    name: `Folder · ${name} (${visible.length} files)`,
    kind: 'text',
    bytes: 0,
    blocks: [
      {
        type: 'text',
        text: `<folder name=${JSON.stringify(name)} files="${visible.length}">\n${layout.slice(0, 500).join('\n')}${layout.length > 500 ? '\n…' : ''}\n</folder>${visible.length > take.length ? `\n(Only the first ${take.length} files are attached below; the rest are listed.)` : ''}`,
      },
    ],
  })
  for (const f of take) {
    const item = await fileToIntake(f.file)
    if ('error' in item) errors.push(item.error)
    else staged.push(item)
  }
}

/** Open the chat and take in what was dropped, pasted or picked. */
export async function intake(files: readonly File[], entries: readonly FileSystemEntry[] = []): Promise<void> {
  useApp.getState().togglePanel('chat', true)
  const dirs = entries.filter((e): e is FileSystemDirectoryEntry => e.isDirectory)
  const dirNames = new Set(dirs.map((d) => d.name))
  const errors: string[] = []
  const staged: IntakeItem[] = []
  useChat.setState({ error: null })

  for (const dir of dirs) {
    try {
      await intakeFolder(dir.name, await readDirectoryEntry(dir), staged, errors)
    } catch (e) {
      errors.push(`${dir.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const f of files) {
    if (dirNames.has(f.name) && (f.size === 0 || f.type === '')) continue // the folder itself
    const item = await fileToIntake(f)
    if ('error' in item) errors.push(item.error)
    else staged.push(item)
  }
  if (staged.length) stage(staged)
  if (errors.length) useChat.setState({ error: errors.join(' ') })
}

/** A folder picked with <input webkitdirectory> (no directory entries there). */
export async function intakeFolderFiles(files: readonly File[]): Promise<void> {
  useApp.getState().togglePanel('chat', true)
  if (!files.length) return
  const root = files[0].webkitRelativePath.split('/')[0] || 'folder'
  const folder = files.map((f) => ({ path: f.webkitRelativePath.split('/').slice(1).join('/') || f.name, file: f }))
  const staged: IntakeItem[] = []
  const errors: string[] = []
  try {
    await intakeFolder(root, folder, staged, errors)
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
  }
  if (staged.length) stage(staged)
  useChat.setState({ error: errors.length ? errors.join(' ') : null })
}
