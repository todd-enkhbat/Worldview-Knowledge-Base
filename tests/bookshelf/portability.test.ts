import { expect, it } from 'vitest'
import { parseBookshelfCsv } from '../../src/bookshelf/portability.ts'

it('understands quoted CSV/Goodreads columns without dropping personal remarks or custom collections', () => {
  const parsed = parseBookshelfCsv('Title,Author,Exclusive Shelf,My Rating,My Review,ISBN13,Original Publication Year,Collections\r\n"A book, with a comma","Family, Given",currently-reading,4.5,"My first thought\nAnd a second, with ""quotes""",="9781234567890",2023,"Science;Questions"\r\nA saved article,Another author,to-read,0,Keep this response,,2026,Research')
  expect(parsed.errors).toEqual([]); expect(parsed.total).toBe(2)
  expect(parsed.books[0]).toMatchObject({ title: 'A book, with a comma', authors: ['Family, Given'], status: 'reading', rating: 4.5, notes: 'My first thought\nAnd a second, with "quotes"', isbn: '9781234567890', year: 2023, collectionNames: ['Science', 'Questions'] })
  expect(parsed.books[1].status).toBe('unread')
})
it('reports invalid rows and malformed CSV explicitly instead of silently changing their data', () => {
  const parsed = parseBookshelfCsv('Title,Rating,URL\nValid title,4,https://example.org/book\nInvalid rating,8,\nInvalid URL,3,javascript:alert(1)')
  expect(parsed.books.map((book) => book.title)).toEqual(['Valid title'])
  expect(parsed.errors.map((error) => error.row)).toEqual([3, 4])
  expect(() => parseBookshelfCsv('Author,Notes\nSomeone,Text')).toThrow(/Title column/)
  expect(() => parseBookshelfCsv('Title\n"An unfinished cell')).toThrow(/quoted cell/)
})
