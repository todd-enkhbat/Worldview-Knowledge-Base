/** Imported addresses can be plain text, structured postal addresses, or both. */
export function crmRecordLocation(record: { location?: unknown; addresses?: unknown }): string {
  if (typeof record.location === 'string' && record.location.trim()) return record.location.trim()
  if (!Array.isArray(record.addresses)) return ''
  for (const address of record.addresses) {
    if (typeof address === 'string' && address.trim()) return address.trim()
    if (!address || typeof address !== 'object') continue
    const city = address.city || address.addressLocality
    const parts = [city, address.region || address.state || address.addressRegion, address.country || address.addressCountry]
    if (typeof city === 'string' && city.trim()) return [...new Set(parts.filter((part): part is string => typeof part === 'string' && !!part.trim()).map(part => part.trim()))].join(', ')
    if (typeof address.formattedValue === 'string' && address.formattedValue.trim()) return address.formattedValue.trim()
  }
  return ''
}
