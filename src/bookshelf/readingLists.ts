// Each list has a first-party source. Version describes the course text. An ISBN,
// when supplied, identifies a catalog copy of that version, not a syllabus mandate.
export type Reading = readonly [title: string, author: string, version?: string, copyIsbn?: string]
export interface ReadingList {
  by: string
  context: string
  url: string
  relation: 'Assigned' | 'Recommended' | 'Listed' | 'Favorite'
  readings: Reading[]
}
export const readingLists: ReadingList[] = [
  {
    by: 'Patricia Kitcher', context: 'Columbia Philosophy · PHIL 3251 with Yarran Hominh, Spring 2020',
    url: 'https://blogs.cuit.columbia.edu/rmy5/files/2020/01/syllabus-kant.pdf', relation: 'Assigned',
    readings: [
      ['Critique of Pure Reason', 'Immanuel Kant', 'Werner S. Pluhar · Hackett', '9780872202573'],
      ['Critique of Practical Reason', 'Immanuel Kant', 'Werner S. Pluhar · Hackett', '9780872206175']
    ]
  },
  {
    by: 'Bernard E. Harcourt', context: 'Columbia Center for Contemporary Critical Thought · Hegel 13/13, Spring 2026',
    url: 'https://hegel1313.law.columbia.edu/files/2026/02/Harcourt-Hegel-1313-Syllabus-2026.01.24.pdf', relation: 'Assigned',
    readings: [
      ['Phenomenology of Spirit', 'Georg Wilhelm Friedrich Hegel', 'A. V. Miller · Oxford. Paragraphs 178–196.', '9780198245971'],
      ['Philosophy of Right', 'Georg Wilhelm Friedrich Hegel', 'T. M. Knox · Clarendon. Preface.']
    ]
  },
  {
    by: 'Mariana Beatriz Noé', context: 'Columbia College · Contemporary Civilization, Fall 2020',
    url: 'https://static1.squarespace.com/static/631639a2b8061e5643fa29e1/t/632cc01a07556623aef46f81/1663877146959/Syllabus%2BContemporary%2BCivilization%2B%28web%29%2BNoe%CC%81.pdf', relation: 'Assigned',
    readings: [
      ['Republic', 'Plato', 'G. M. A. Grube, revised by C. D. C. Reeve · Hackett', '9780872201361'],
      ['Nicomachean Ethics', 'Aristotle', 'W. D. Ross, revised by Lesley Brown · Oxford', '9780199213610'],
      ['Politics', 'Aristotle', 'Ernest Barker, revised by R. F. Stalley · Oxford', '9780199538737'],
      ['City of God', 'Augustine', 'Henry Bettenson · Penguin'],
      ['The Prince', 'Niccolò Machiavelli', 'Peter Bondanella · Oxford', '9780199535699'],
      ['Discourses on Livy', 'Niccolò Machiavelli', 'Julia Conaway Bondanella and Peter Bondanella · Oxford', '9780199555550'],
      ['Discourse on Method and Meditations on First Philosophy', 'René Descartes', 'Ian Johnston · Broadview'],
      ['Leviathan', 'Thomas Hobbes', 'Edited by J. C. A. Gaskin · Oxford'],
      ['Political Writings', 'John Locke', 'Edited by David Wootton · Hackett']
    ]
  },
  {
    by: 'Charles McNamara', context: 'Columbia College · Contemporary Civilization, Fall 2018',
    url: 'https://charlesmcnamara.com/wp-content/uploads/McNamaraCCSyllabusFall2018.pdf', relation: 'Assigned',
    readings: [
      ['Republic', 'Plato', 'Hackett · translator unspecified'], ['Politics', 'Aristotle', 'Hackett · translator unspecified'],
      ['Nicomachean Ethics', 'Aristotle', 'Oxford World’s Classics · translator unspecified'],
      ['Discourses on Livy', 'Niccolò Machiavelli', 'Penguin · translator unspecified'],
      ['The Prince', 'Niccolò Machiavelli', 'Hackett · translator unspecified'],
      ['The Basic Political Writings', 'Jean-Jacques Rousseau', 'Hackett'],
      ['Handbook', 'Epictetus', 'Hackett'], ['Leviathan', 'Thomas Hobbes', 'Oxford']
    ]
  },
  {
    by: 'Columbia College Core Curriculum', context: 'Literature Humanities · 2021–22 reading list',
    url: 'https://www.college.columbia.edu/sites/default/files/literature_humanities_reading_lists_2021-2022.pdf', relation: 'Assigned',
    readings: [
      ['The Iliad', 'Homer', 'Richmond Lattimore · Chicago', '9780226470498'],
      ['The Odyssey', 'Homer', 'Emily Wilson · Norton', '9780393089059'],
      ['If Not, Winter', 'Sappho', 'Anne Carson · Vintage'], ['Symposium', 'Plato', 'Alexander Nehamas and Paul Woodruff · Hackett'],
      ['Aeneid', 'Virgil', 'Allen Mandelbaum · Bantam'], ['The Golden Ass', 'Apuleius', 'Sarah Ruden · Yale'],
      ['Confessions', 'Augustine', 'Henry Chadwick · Oxford'], ['Inferno', 'Dante Alighieri', 'Allen Mandelbaum · Bantam'],
      ['Don Quixote', 'Miguel de Cervantes', 'Edith Grossman · HarperCollins'],
      ['Crime and Punishment', 'Fyodor Dostoevsky', 'Richard Pevear and Larissa Volokhonsky · Vintage'],
      ['The Metamorphosis', 'Franz Kafka', 'Susan Bernofsky · Norton'], ['Othello', 'William Shakespeare', 'Oxford World’s Classics'],
      ['Pride and Prejudice', 'Jane Austen', 'Oxford'], ['Song of Solomon', 'Toni Morrison', 'Vintage'],
      ['The Oresteia', 'Aeschylus', 'Richmond Lattimore · Chicago']
    ]
  },
  {
    by: 'Carlos Alonso Nugent', context: 'Columbia · Literature Humanities, Fall 2025',
    url: 'https://static1.squarespace.com/static/5dc4b8cf1fd92703daf39d62/t/697d7754cfa642412af9ad21/1769830228516/CNugent_Literature%2BHumanities_F25.pdf', relation: 'Assigned',
    readings: [['The Iliad', 'Homer', 'Richmond Lattimore · Chicago', '9780226470498'], ['The Odyssey', 'Homer', 'Emily Wilson · Norton', '9780393089059'], ['The Oresteia', 'Aeschylus', 'Richmond Lattimore · Chicago']]
  },
  {
    by: 'Christia Mercer', context: 'Columbia Philosophy · Aquinas to Kant, Spring 2005',
    url: 'https://www.columbia.edu/~cm50/hist_phil.pdf', relation: 'Assigned',
    readings: [
      ['Principles of the Most Ancient and Modern Philosophy', 'Anne Conway', 'Cambridge'],
      ['Three Dialogues between Hylas and Philonous', 'George Berkeley', 'Hackett'],
      ['An Enquiry Concerning Human Understanding', 'David Hume', 'Hackett'],
      ['Prolegomena to Any Future Metaphysics', 'Immanuel Kant', 'Hackett'],
      ['Discourse on Metaphysics', 'Gottfried Wilhelm Leibniz']
    ]
  },
  {
    by: 'Achille C. Varzi', context: 'Columbia Philosophy · Metaphysics, Fall 2022',
    url: 'https://www.columbia.edu/~av72/Teaching/metaphysics/syllabus.pdf', relation: 'Assigned',
    readings: [['Metaphysics: A Contemporary Introduction', 'Michael J. Loux and Thomas M. Crisp', 'Fourth edition · Routledge'], ['Metaphysics: Contemporary Readings', 'Michael J. Loux', 'Second edition · Routledge']]
  },
  {
    by: 'Katja Vogt', context: 'Columbia Philosophy · Topics in Hellenistic Philosophy, Spring 2009',
    url: 'https://katjavogt.github.io/wp-content/uploads/syllabus-vogt-hellenistic-philosophy-skepticism.pdf', relation: 'Assigned',
    readings: [['On Academic Scepticism', 'Cicero', 'Charles Brittain · Hackett'], ['Against the Ethicists', 'Sextus Empiricus', 'Richard Bett · Oxford'], ['The Hellenistic Philosophers', 'A. A. Long and D. N. Sedley', 'Volume 1 · Cambridge'], ['Meno', 'Plato', 'Selections']]
  },
  {
    by: 'Taylor Carman', context: 'Barnard Philosophy · Later Heidegger, Spring 2018',
    url: 'https://static1.squarespace.com/static/5c2fcf4570e80205338517b2/t/5c4a0d6203ce64a9870fe588/1548356963093/Syllabus.pdf', relation: 'Assigned',
    readings: [['Introduction to Metaphysics', 'Martin Heidegger', 'Yale'], ['Off the Beaten Track', 'Martin Heidegger', 'Cambridge'], ['Pathmarks', 'Martin Heidegger', 'Cambridge'], ['The Question Concerning Technology and Other Essays', 'Martin Heidegger', 'Harper']]
  },
  {
    by: 'Justin Clarke-Doane', context: 'Columbia · Contemporary Civilization, Fall 2014',
    url: 'https://www.columbia.edu/~jc4345/Syllabus2.pdf', relation: 'Assigned',
    readings: [['An Enquiry into the Principles of Morals', 'David Hume'], ['The Basic Political Writings', 'Jean-Jacques Rousseau', 'Hackett'], ['The Wealth of Nations', 'Adam Smith', 'Modern Library'], ['Groundwork of the Metaphysics of Morals', 'Immanuel Kant', 'Cambridge'], ['A Vindication of the Rights of Woman', 'Mary Wollstonecraft', 'Oxford'], ['Democracy in America', 'Alexis de Tocqueville', 'Penguin'], ['The Souls of Black Folk', 'W. E. B. Du Bois', 'Norton']]
  },
  {
    by: 'Melissa Fusco', context: 'Columbia Philosophy · Methods & Problems, Fall 2017',
    url: 'https://www.columbia.edu/~mf3095/Welcome_files/Methods%20and%20Problems%20Syllabus%20%28August%29.pdf', relation: 'Assigned',
    readings: [['Meditations on First Philosophy', 'René Descartes', 'Meditations II and VI · translator unspecified']]
  },
  {
    by: 'Akeel Bilgrami', context: 'Columbia Philosophy · Methods and Problems, Fall 2000',
    url: 'https://www.columbia.edu/itc/philosophy/bilgrami/methods/', relation: 'Assigned', readings: [['Utilitarianism', 'John Stuart Mill']]
  },
  {
    by: 'Haim Gaifman and Achille C. Varzi', context: 'Columbia Philosophy · Seminar on Truth, Spring 1998',
    url: 'https://www.columbia.edu/~av72/Teaching/Truth/syllabus.pdf', relation: 'Assigned',
    readings: [['Tractatus Logico-Philosophicus', 'Ludwig Wittgenstein', 'Excerpts'], ['Truth', 'Paul Horwich', 'Excerpts'], ['The Philosophy of Logical Atomism', 'Bertrand Russell', 'Sections 1–2']]
  },
  {
    by: 'Allison Aitken', context: 'Faculty teaching site · Philosophy without Borders, venue and term unspecified',
    url: 'https://www.allisonaitken.net/uploads/1/2/7/1/127135012/aitken_philosophy_without_borders_syllabus.pdf', relation: 'Assigned',
    readings: [['Meditations on First Philosophy', 'René Descartes', 'Selections in The Philosophical Writings of Descartes · Cambridge']]
  },
  {
    by: 'Columbia Department of Political Science', context: 'Political Theory · comprehensive examination list, November 2020',
    url: 'https://polisci.columbia.edu/sites/polisci.columbia.edu/files/content/pdfs/Comps/PT%20comps%20revised%20reading%20list%20final%20%28Nov%202020%29.pdf', relation: 'Listed',
    readings: [['Republic', 'Plato'], ['The Republic', 'Cicero'], ['Discourses on Livy', 'Niccolò Machiavelli', 'Selections in David Wootton’s Selected Political Writings'], ['The Prince', 'Niccolò Machiavelli'], ['Leviathan', 'Thomas Hobbes', 'Selections · Norton Critical Edition, edited by David Johnston'], ['The Theory of Moral Sentiments', 'Adam Smith', 'Selected parts'], ['Second Treatise of Government', 'John Locke'], ['The Rights of Man', 'Thomas Paine', 'Part II']]
  },
  {
    by: 'Caroline Bowman', context: 'Faculty teaching site · NYU Ethics and Society, Fall 2023',
    url: 'https://www.carolinebowman.org/wp-content/uploads/2023/10/Ethics-and-Society-syllabus-v-9-14.pdf', relation: 'Assigned',
    readings: [['Abolish the Family', 'Sophie Lewis', 'Chapters 1, 2 and 4'], ['Are Prisons Obsolete?', 'Angela Davis', 'Chapters 1, 2 and 6'], ['The Idea of Prison Abolition', 'Tommie Shelby', 'Chapter 3'], ['Capital', 'Karl Marx', 'Volume I · excerpts']]
  },
  {
    by: 'John Morrison and Don Garrett', context: 'Columbia and NYU · Spinoza’s Metaphysics, Fall 2017',
    url: 'https://www.columbia.edu/~jrm2182/GR9670.pdf', relation: 'Assigned',
    readings: [['Ethics', 'Baruch Spinoza', 'Edwin Curley · Penguin paperback or Princeton Collected Works, volume 1'],
      ['Being and Reason', 'Martin Lin', 'Chapter 4'], ['Meditations on First Philosophy', 'René Descartes', 'Fourth Meditation']]
  },
  {
    by: 'Taylor Carman', context: 'Interview with Richard Marshall · Mature: Heidegger and Merleau-Ponty',
    url: 'https://www.3-16am.co.uk/articles/mature-heidegger-and-merleau-ponty', relation: 'Recommended',
    readings: [['Heidegger and the Measure of Truth', 'Denis McManus'], ['Merleau-Ponty and Phenomenology of Perception', 'Komarine Romdenh-Romluc']]
  },
  {
    by: 'Marc Andreessen', context: 'The Tim Ferriss Show · interview 163',
    url: 'https://tim.blog/2018/01/01/the-tim-ferriss-show-transcripts-marc-andreessen/', relation: 'Recommended',
    readings: [['High Output Management', 'Andrew S. Grove'], ['Only the Paranoid Survive', 'Andrew S. Grove'], ['Zero to One', 'Peter Thiel and Blake Masters']]
  },
  {
    by: 'Ben Horowitz', context: 'a16z · foreword, 2015', url: 'https://a16z.com/andy/', relation: 'Recommended',
    readings: [['High Output Management', 'Andrew S. Grove']]
  },
  {
    by: 'Francis Pedraza', context: 'Favorite identified by interviewer Johnathan Bi, September 2025',
    url: 'https://www.johnathanbi.com/p/unicorn-founder-reacts-to-his-old', relation: 'Favorite',
    readings: [['The Once and Future King', 'T. H. White']]
  },
  {
    by: 'a16z', context: 'a16z New Media · Qasar Younis’s selection, 2025', url: 'https://a16z.com/you-can-just-read-25-books/', relation: 'Listed',
    readings: [['Sam Walton: Made in America', 'Sam Walton and John Huey']]
  }
]
