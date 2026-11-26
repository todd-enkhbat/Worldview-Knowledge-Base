export interface ExtractedArticle { url: string; title: string; text: string; selection: { quote: string; start: number; end: number; prefix: string; suffix: string } | null; profileImages: { url: string; sourceUrl: string; label: string; isProfile: boolean; subjectName?: string }[]; profileLinks: { url: string; rel: 'me'; subjectName?: string }[] }
export function extractArticle(doc?: Document): ExtractedArticle
export interface FolkPhotoRow { photoUrl: string; name: string; nearbyLinks: { href: string; text: string }[]; attributes: Record<string, string>; sourceUrl: string; groupId: string; visibleEmails?: string[]; rowRole?: string; avatarLabel?: string; isPrimaryAvatar?: boolean; imageState?: { alt: string; ariaLabel: string; title: string; rowImageCount: number; complete: boolean; naturalWidth: number; naturalHeight: number; currentSrc: string; requestedSources: string[]; personLinkCount: number; verifiedReason: string } }
export interface ExtractedFolkPhotos { url: string; title: string; groupId: string; scope?: 'network-search-diagnostic'; folkPhotos: { personId: string; name: string; photoUrl: string; sourceUrl: string; groupId: string }[]; folkPhotoRows: FolkPhotoRow[] }
export function extractFolkPhotos(doc?: Document): ExtractedFolkPhotos
export interface ExtractedProfile { url: string; title: string; text: string; html: string; profile: import('../../src/crm/profileCaptureTypes.ts').CapturedProfileData; headerEmployer?: { organization: string; additional: number } }
export function extractProfile(doc?: Document): ExtractedProfile
export function extractProfile(doc: null, reportError: true): ExtractedProfile | { extractorError: string }
export function captureLinkedInExperience(profileUrl: string, employer?: string, doc?: Document): Promise<{ roles: NonNullable<ExtractedProfile['profile']['affiliations']>; continuation?: string }>
export function extractVisiblePeople(doc?: Document | null): {pageUrl: string; people: import('./contact-ui.js').VisiblePerson[]}
export function extractVisiblePeople(doc: Document | null, selectedUrl: string): (ExtractedProfile & {sourcePageUrl: string}) | {extractorError: string}
