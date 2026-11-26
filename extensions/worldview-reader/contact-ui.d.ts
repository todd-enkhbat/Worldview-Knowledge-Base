export type VisiblePerson = {
  name: string
  url: string
  headline?: string
  photoUrl?: string
  existing?: { recordId: string; groupIds?: string[] } | null
  reviewId?: string
  pending?: boolean
}
export function contactActions(kind: string): {save:string; open:string; group:string; activity:string}
export function renderPeopleRows(host: HTMLElement, people: VisiblePerson[], onAction: (person: VisiblePerson, action: 'primary'|'review') => void, busy?: boolean): void
export type ProfileIdentity = { entityType: 'person'|'company'; name:string; headline?:string; role?:string; current?:string[]; schools?:string[]; location?:string; photoUrl?:string }
export function renderProfileIdentity(host: HTMLElement, profile:ProfileIdentity, options?: {saved?:boolean;idPrefix?:string;nameId?:string}):void
