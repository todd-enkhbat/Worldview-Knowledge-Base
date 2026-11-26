import type { CrmCandidate, CrmJson, CrmSourceRef } from './types.ts'

export type GoogleCrmCapability = 'calendar' | 'contacts' | 'otherContacts' | 'gmail' | 'send'
export interface CrmGoogleAccount { id: string; label: string; email: string | null; configured: boolean; connected: boolean; capabilities: GoogleCrmCapability[]; scopes: string[]; connectedAt: number | null; lastSyncAt: number | null; autoSync?: boolean; includeSubjects?: boolean; autoSyncError?: string; gmailSync?: { pendingMessages: number; hasMore: boolean; retryAt: number | null } }
export interface CrmConnectionsStatus { available: boolean; accounts: CrmGoogleAccount[]; driveClientAvailable: boolean; aiRequired: false; happenstance: { configured: boolean; automaticResearch: false; mcpUrl: string }; folk?: { configured: boolean } }
export interface CrmCalendar { id: string; summary: string; primary: boolean; selected: boolean; timeZone: string; accessRole: string }
export interface CrmCalendarEvent { id: string; accountId: string; calendarId: string; iCalUID: string; title: string; body: string; status: string; startAt: number | null; endAt: number | null; timezone: string; allDay: boolean; htmlLink: string; attendees: { email: string; name: string; responseStatus: string; self: boolean; organizer: boolean }[]; organizer: { email: string; name: string }; updated: string; originalStartTime: string; raw: CrmJson }
export interface CrmConnectorCandidate extends Record<string, unknown> { kind: CrmCandidate['kind']; status: 'pending'; provider: string; accountId: string; externalId: string; payload: Record<string, unknown>; targetId: string | null; confidence: CrmCandidate['confidence']; evidence: CrmCandidate['evidence']; sourceRefs: CrmSourceRef[]; raw?: CrmJson }
export interface CrmConnectorBatch { provider: string; accountId: string; name: string; originalAssetIds: string[]; candidates: CrmConnectorCandidate[]; counts: Record<string, number>; errors: string[] }
export interface CrmImportMapping { name?: string; firstName?: string; lastName?: string; email?: string; phone?: string; company?: string; jobTitle?: string; url?: string }
export interface CrmImportPreview { name: string; provider: string; hash: string; format: string; columns: string[]; mapping: CrmImportMapping; count: number; samples: Record<string, string>[]; warnings: string[] }
export interface CrmCapturedContactSource { id: string; title: string; url: string; provider: 'google-drive' | 'website-reader'; currentVersionId: string }

export interface RelationshipTouch {
  channel?: string
  id: string
  at: number
  title: string
  source: string
  direction: 'sent' | 'received' | 'logged'
  url?: string
}
export interface RelationshipHistory {
  total: number
  recentCount: number
  introductions: { personId: string; name: string; source: string }[]
  first: RelationshipTouch | null
  last: RelationshipTouch | null
  sent: number
  received: number
  ambiguousEmails: number
  unavailableSources: number
  offset: number
  timeline: RelationshipTouch[]
}

export interface ReconnectQueue {
  total: number
  unavailableSources: number
  rows: { id: string; name: string; idleDays: number; last: RelationshipTouch }[]
}
