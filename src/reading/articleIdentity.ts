/** Keep article identity independent of tracking parameters and in-page anchors. */
export function articleIdentity(value: string): { url: string; canonicalUrl: string; host: string; externalId: string } {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Enter an article URL up to 4096 characters.')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('Enter a complete http or https article URL.') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an http or https URL without embedded credentials.')
  const url = parsed.href
  if (!/^#!?\//.test(parsed.hash)) parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) if (/^(?:utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) parsed.searchParams.delete(key)
  const canonicalUrl = parsed.href
  return { url, canonicalUrl, host: parsed.hostname, externalId: `article:${canonicalUrl}` }
}
