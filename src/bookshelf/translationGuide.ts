import { editionIsbn, type EditionResult } from './catalog.ts'

interface Assessment {
  by: string
  publication: string
  url: string
  judgment: string
}

interface Translation {
  translator: string
  publisher: string
  year: number
  isbn: string
  workId: string
  editionId: string
  coverId: number | null
  pages: number | null
  format: string
  reason: string
  assessments: Assessment[]
}

interface ReadingGuide {
  title: string
  author: string
  authorId: string
  translations: Translation[]
}

const rush = {
  by: 'Fred Rush', publication: 'Notre Dame Philosophical Reviews',
  url: 'https://ndpr.nd.edu/reviews/the-phenomenology-of-spirit/'
}
const brown = {
  by: 'Eric Brown', publication: 'Stanford Encyclopedia of Philosophy',
  url: 'https://plato.stanford.edu/archives/fall2017/entries/plato-ethics-politics/#Bib'
}

// ISBNs identify the particular copies offered here. Assessments concern the
// translation. A citation or an assignment on a syllabus alone is not a vote.
const guides: ReadingGuide[] = [
  {
    title: 'The Phenomenology of Spirit', author: 'Georg Wilhelm Friedrich Hegel', authorId: 'OL53216A',
    translations: [
      { translator: 'Michael Inwood', publisher: 'Oxford University Press', year: 2018,
        isbn: '9780198790624', workId: 'OL20184040W', editionId: 'OL27369032M', coverId: 8832213, pages: 544, format: 'Hardcover',
        reason: 'For close reading, Inwood gives you a commentary keyed to each paragraph, particularly helpful in the Preface and Introduction.',
        assessments: [
          { ...rush, judgment: 'Finds both new translations dependable and singles out Inwood’s commentary on Hegel’s opening sections.' },
          { by: 'Robert Stern', publication: 'Hegel Bulletin', url: 'https://doi.org/10.1017/hgl.2022.47',
            judgment: 'Praises the precision of the English and explains how Inwood’s notes illuminate difficult passages.' }
        ] },
      { translator: 'Terry Pinkard', publisher: 'Cambridge University Press', year: 2018,
        isbn: '9780521855792', workId: 'OL20176448W', editionId: 'OL27360249M', coverId: 8823341, pages: 536, format: 'Hardcover',
        reason: 'A close rendering of Hegel’s terminology, with German-edition page references for comparing passages.',
        assessments: [{ ...rush, judgment: 'Praises Pinkard’s clarity and shows how his choice of “conduct” brings out Hegel’s account of consciousness as activity.' }] }
    ]
  },
  {
    title: 'Republic', author: 'Plato', authorId: 'OL12823A',
    translations: [
      { translator: 'C. D. C. Reeve', publisher: 'Hackett', year: 2004, isbn: '9780872207363',
        workId: 'OL51831W', editionId: 'OL8374406M', coverId: 14390203, pages: 392, format: 'Paperback',
        reason: 'Reeve casts the arguments as direct dialogue, making it easier to follow who is speaking.',
        assessments: [
          { by: 'Lloyd P. Gerson', publication: 'Endorsement published by Hackett', url: 'https://hackettpublishing.com/republic',
            judgment: 'Commends Reeve’s accuracy and the immediacy he brings to the dialogue.' },
          { ...brown, judgment: 'Includes Reeve among the good modern English translations, with a particular preference for Rowe.' }
        ] },
      { translator: 'Christopher Rowe', publisher: 'Penguin', year: 2012, isbn: '9780141442433',
        workId: 'OL51831W', editionId: 'OL29121509M', coverId: 14410204, pages: 496, format: 'Paperback',
        reason: 'Eric Brown’s particular choice among the modern English translations in his reading guide.',
        assessments: [{ ...brown, judgment: 'Singles out Rowe while also recommending several other English translations.' }] }
    ]
  },
  {
    title: 'Discourses on Livy', author: 'Niccolò Machiavelli', authorId: 'OL23135A',
    translations: [
      { translator: 'Harvey C. Mansfield and Nathan Tarcov', publisher: 'University of Chicago Press', year: 1998,
        isbn: '9780226500362', workId: 'OL1089260W', editionId: 'OL29216175M', coverId: null, pages: 424, format: 'Paperback',
        reason: 'A glossary makes it easy to trace Machiavelli’s recurring terms across chapters. Explanatory notes accompany the translation.',
        assessments: [{ by: 'Peter Stothard', publication: 'The Times, excerpted by Chicago', url: 'https://press.uchicago.edu/ucp/books/book/chicago/D/bo3622353.html',
          judgment: 'The classics writer praises the translators’ care and their feel for Machiavelli’s idiom.' }] }
    ]
  },
  {
    title: 'The Prince', author: 'Niccolò Machiavelli', authorId: 'OL23135A',
    translations: [
      { translator: 'Harvey C. Mansfield', publisher: 'University of Chicago Press', year: 1998,
        isbn: '9780226500447', workId: 'OL1089297W', editionId: 'OL346696M', coverId: 2335834, pages: 151, format: 'Second edition',
        reason: 'Political philosophers Thomas Pangle and Timothy Burns specifically recommend Mansfield’s second edition for this work.',
        assessments: [{ by: 'Thomas L. Pangle and Timothy W. Burns', publication: 'The Key Texts of Political Philosophy',
          url: 'https://doi.org/10.1017/CBO9781139047555.010', judgment: 'Their chapter on Machiavelli recommends this translation in its references.' }] }
    ]
  },
  {
    title: 'The Iliad', author: 'Homer', authorId: 'OL18404A',
    translations: [
      { translator: 'Emily Wilson', publisher: 'W. W. Norton', year: 2023, isbn: '9781324001805',
        workId: 'OL34350313W', editionId: 'OL46720993M', coverId: 14626179, pages: null, format: 'Hardcover',
        reason: 'For reading aloud, Wilson’s modern English verse carries you through the battle scenes and gives the speakers distinct voices.',
        assessments: [
          { by: 'Richard Jenkyns', publication: 'Classics for All', url: 'https://classicsforall.org.uk/reading-room/book-reviews/iliad-homer',
            judgment: 'Praises the pace and directness, while finding some colloquial passages too flat.' },
          { by: 'Edith Hall', publication: 'The Guardian', url: 'https://www.theguardian.com/books/2023/sep/27/the-iliad-by-homer-translated-by-emily-wilson-review-a-bravura-feat',
            judgment: 'Highlights the distinct voices and Wilson’s command of Homeric language.' }
        ] }
    ]
  }
]

function words(text: string) {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\bphenomonology\b/g, 'phenomenology').replace(/\billiad\b/g, 'iliad')
    .match(/[a-z0-9]+/g)?.filter(word => !['the', 'of', 'on', 's'].includes(word)) ?? []
}

export function translationGuide(query: string) {
  const tokens = words(query)
  const isbn = editionIsbn(query)
  for (const guide of guides) {
    const title = words(guide.title), author = words(guide.author)
    const byTitle = title.every(word => tokens.includes(word))
    const byAuthorAndTitle = tokens.includes(author[author.length - 1]) && title.some(word => tokens.includes(word))
    const translations = guide.translations.filter(t => {
      if (isbn) return t.isbn === isbn
      const allowed = new Set([...title, ...author, ...words(t.translator), ...words(t.publisher), ...words(t.format), String(t.year)])
      return (byTitle || byAuthorAndTitle) && tokens.every(token => allowed.has(token))
    })
    if (translations.length) {
      // One signed assessment per independent reviewer or coauthor group.
      const support = (t: Translation) => new Set(t.assessments.map(a => a.by)).size
      const ranked = translations.sort((a, b) => support(b) - support(a))
      return { guide, ranked, tied: ranked.length > 1 && support(ranked[0]) === support(ranked[1]) }
    }
  }
  return null
}

export function reviewedEdition(guide: ReadingGuide, copy: Translation): EditionResult {
  const { title, author, authorId } = guide
  return {
    work: { id: copy.workId, title, authors: [{ id: authorId, name: author }], year: null, editionCount: 1, preferredEdition: copy.editionId },
    edition: { id: copy.editionId, title, subtitle: '', translator: copy.translator, publisher: copy.publisher,
      editionLabel: copy.format, date: String(copy.year), year: copy.year, language: 'eng', isbn: copy.isbn, pages: copy.pages, coverId: copy.coverId }
  }
}
