# Capture, vault links, and portable knowledge

The 3D world remains the spatial view of your saved records. Capture and interchange add retained sources, citations, and explicit relationships without importing Canvas positions into world placement.

## Voice and media

In **Sources → Voice & media inbox**, choose **Save audio/video file** or **Record voice**. Select the language and speaker attribution when you know them. Unknown speaker attribution is the default. Capture time is retained separately from the unknown time at which the speaker made each statement.

File capture saves the original bytes and a durable receipt before acknowledging success. A microphone recording is pending until you stop and save it. The limit is 128 MiB per file, and browser codec support varies.

Choose **Transcribe locally** when you want a transcript. This is the action that starts local Whisper and may download its model, approximately 80–110 MB on first use. Capture alone does not start inference. You can revoke transcription access on a receipt or disable AI for its published source. Revoking access, replacing the workspace, or changing accounts cancels pending transcription and prevents its late result from being published.

A failed transcription retains its original and offers **Retry transcription**. Retrying uses the retained bytes. Capturing the same bytes twice returns the existing receipt. A completed transcript is reused; recovery also recognizes a transcript that was published just before its receipt was interrupted.

Open **Read transcript** to read the source. Timed passages cite audio ranges such as `Audio 1:05–1:15`. The source reader can load the retained audio or video at the cited time. Original downloads remain available when decoding or transcription fails. Verified backups include both untranscribed originals and published transcript receipts. Permanently deleting a published transcript removes its associated inbox receipt and original according to the existing source purge policy.

## Markdown vaults

Manual source import and the local folder watcher use one reference resolver. Resolution favors normalized exact paths, then unambiguous relative or suffix paths, and finally a unique basename or alias. Duplicate basenames produce an ambiguity report instead of silently selecting the last file. Explicit relative references remain relative to their source note. Watched folders have separate reference scopes.

Wikilinks retain their display aliases, heading or block locators, and embed markers. References inside code fences, inline code, and Obsidian comments are treated as literal text. Unknown frontmatter is retained alongside the source, including nested properties that Worldview does not interpret. Ambiguous calendar strings and invalid dates do not become authored timestamps.

Explicit resolvable note references create saved relationships after import. Inferred lexical suggestions continue to require review. Manually removing an imported relationship suppresses its automatic recreation on subsequent imports. Updating source text preserves existing pinned field positions, world anchors, and birth dates.

Passages respect message, speaker, page, heading, paragraph, and code boundaries. Their text is a direct UTF-16 slice of the retained source version, with Unicode-safe boundaries. Without a supplied tokenizer, the text budget uses UTF-8 bytes as a conservative approximation; it does not claim to be a model's exact tokenizer.

## Portable exports

In **Sources → Portable knowledge**, choose all included sources or a saved investigation. You can include source history and limit the export to sources currently allowed for AI. The exporter omits deleted and corpus-excluded sources. It does not change source permissions or the active investigation.

The ZIP contains:

- `worldview-sources.json`: source, version, and passage UUIDs, exact text, attribution, dates, policy, provenance metadata, and saved investigations.
- `sources/<source-id>/<version-id>.txt`: exact retained source text for each selected version.
- `notes/`: readable Markdown with stable UUID-bearing filenames, source identity and provenance frontmatter, and rewrites of resolvable wikilinks to the exported note paths.
- `investigations/`: editable Canvas maps and conservative Bases table/filter views. Their 2D layout is independent of world XYZ.
- `link-diagnostics.json`: references that remain missing, ambiguous, or invalid after source scope is applied.

Open the extracted folder as an Obsidian vault. Canvas and Bases can also be downloaded individually; their note references refer to the matching ZIP's `notes/` files. Bases exports do not generate executable formulas. Search questions remain available in the JSON manifest and as comments where the target format cannot represent them exactly.

Reimport **`worldview-sources.json` through Import files** to restore its source/version/passage identities and saved investigations. Importing into a fresh corpus preserves UUIDs, history, attribution, policy, and citation offsets. Existing external source identity takes precedence. UUID collisions, conflicting evidence, conflicting saved-investigation filters, and stale revisions that would replace newer local content are reported without overwriting the conflicting record. Reimporting an unchanged package does not duplicate sources, versions, or passages. Existing AI or exclusion restrictions are never relaxed by an import.

Portable text exports are limited to 5,000 sources and 64 MiB. Binary originals and complete recovery state belong in verified ZIP or folder backups. A portable text package carries its original provenance manifest, but reimported source originals are the retained package; it does not recreate absent original binary files. Use verified backups when exact full-world recovery, original binaries, or spatial state is required.

## Canvas and Bases inputs

Manual import and local folder capture accept `.canvas` and `.base`. Canvas import validates unique node IDs and edge endpoints, retains the exact JSON and unknown fields, and records its readable text. Canvas node coordinates are never applied to world coordinates. Bases files are retained and searchable as text. Their filters and formulas are not evaluated during import.

These inputs become retained sources. Importing a standalone Canvas or Bases file does not reconstruct an arbitrary Obsidian workspace or replace saved world records. The Worldview JSON manifest is the supported identity-preserving source-and-investigation interchange.
