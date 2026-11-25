import { expect, it } from 'vitest'
import { extractProfilePage } from '../../server/crmProfileMedia.ts'

it('finds exactly named directory photos without admitting other people or generic group art', () => {
  const person = { fullName: 'Nima Mesgarani', firstName: '', lastName: '', urls: [] }
  const page = '<h1>Nima Mesgarani</h1><meta property="og:image" content="/bad-crop.jpg"><img alt="photo of Nima Mesgarani " src="/directory.jpg"><img alt="photo of Other Person" src="/other.jpg"><img alt="photo of Nima Mesgarani and the lab" src="/group.jpg">'
  const result = extractProfilePage(page, 'https://faculty.example.org/nima', person)
  expect(result.photos.filter(photo => photo.automatic).map(photo => photo.url)).toEqual(['https://faculty.example.org/directory.jpg'])
  expect(result.photos.find(photo => photo.url.endsWith('bad-crop.jpg'))?.automatic).toBe(false)
  expect(extractProfilePage(page.replace('<h1>Nima Mesgarani</h1>', '<h1>Our faculty</h1>'), 'https://faculty.example.org/nima', person).photos.some(photo => photo.automatic)).toBe(false)
})
