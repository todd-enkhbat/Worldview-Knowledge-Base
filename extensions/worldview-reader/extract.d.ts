export interface ExtractedArticle { url: string; title: string; text: string; selection: { quote: string; start: number; end: number; prefix: string; suffix: string } | null }
export function extractArticle(doc?: Document): ExtractedArticle
