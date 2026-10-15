import type { ReactNode } from 'react'

// Static copy of docs/CREDITS.md (Settings → Credits). Keep the two in sync: the splat
// fixtures are CC-BY-4.0, which requires the attribution to be visible in the app.

interface FixtureCredit {
  file: string
  title: string
  author: string
  authorUrl: string
  source: string
  via: string
}

const FIXTURES: readonly FixtureCredit[] = [
  {
    file: 'lion.v3.spz',
    title: 'Lion',
    author: 'Renaud',
    authorUrl: 'https://superspl.at/user?id=rohls',
    source: 'https://superspl.at/scene/56155c3f',
    via: 'three.js examples/models/spz',
  },
  {
    file: 'tomatoes.v4.spz',
    title: '“Scan was created on my DIY automated rig.”',
    author: 'Grail',
    authorUrl: 'https://superspl.at/user?id=grail',
    source: 'https://superspl.at/scene/2826d2c0',
    via: 'three.js examples/models/spz',
  },
  {
    file: 'apartment.sog',
    title: 'SA3D_R&D_XP47',
    author: 'Stephane Agullo',
    authorUrl: 'https://sa3d.fr',
    source: 'https://superspl.at/view?id=cdcec084',
    via: 'PlayCanvas engine examples/assets/splats',
  },
  {
    file: 'knock-community-hall.sog',
    title: 'Knock Community Hall',
    author: 'scbenoit',
    authorUrl: 'https://superspl.at/user?id=scbenoit',
    source: 'https://superspl.at/scene/0ff2e6dc',
    via: 'PlayCanvas engine examples/assets/splats',
  },
]

const FONTS: readonly [string, string][] = [
  ['Inter', 'SIL Open Font License 1.1 (via @fontsource/inter)'],
  ['JetBrains Mono', 'SIL Open Font License 1.1 (via @fontsource/jetbrains-mono)'],
]

const LIBRARIES: readonly [string, string][] = [
  ['three.js', 'MIT'],
  ['Spark', 'MIT'],
  ['React Three Fiber / drei / postprocessing', 'MIT'],
  ['zustand', 'MIT'],
  ['fflate', 'MIT'],
  ['idb', 'ISC'],
]

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/'
const LINK = 'underline decoration-bone/30 underline-offset-2 hover:text-ember focus-visible:outline focus-visible:outline-2 focus-visible:outline-signal'

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={LINK}>
      {children}
    </a>
  )
}

/** Credits table (fonts, CC-BY splat fixtures, libraries). */
export function Credits() {
  return (
    <div className="space-y-5 text-[11px] leading-relaxed text-bone/85">
      <div>
        <div className="hud-label mb-1.5">Splat fixtures · CC-BY-4.0</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <caption className="sr-only">Splat fixtures and their authors</caption>
            <thead>
              <tr className="border-b border-bone/20 text-concrete">
                <th scope="col" className="py-1 pr-3 font-normal uppercase tracking-wider">File</th>
                <th scope="col" className="py-1 pr-3 font-normal uppercase tracking-wider">Title · Author</th>
                <th scope="col" className="py-1 pr-3 font-normal uppercase tracking-wider">Source</th>
                <th scope="col" className="py-1 font-normal uppercase tracking-wider">License</th>
              </tr>
            </thead>
            <tbody>
              {FIXTURES.map((f) => (
                <tr key={f.file} className="border-b border-bone/10 align-top">
                  <td className="py-1.5 pr-3 text-bone">{f.file}</td>
                  <td className="py-1.5 pr-3">
                    {f.title} · <Ext href={f.authorUrl}>{f.author}</Ext>
                  </td>
                  <td className="py-1.5 pr-3">
                    <Ext href={f.source}>superspl.at</Ext> <span className="text-concrete">via {f.via}</span>
                  </td>
                  <td className="py-1.5">
                    <Ext href={CC_BY}>CC-BY-4.0</Ext>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-concrete">Author must be credited. Commercial use is allowed.</p>
      </div>
      {(
        [
          ['Fonts', FONTS],
          ['Libraries', LIBRARIES],
        ] as const
      ).map(([head, rows]) => (
        <div key={head}>
          <div className="hud-label mb-1.5">{head}</div>
          <ul className="m-0 list-none p-0">
            {rows.map(([name, lic]) => (
              <li key={name} className="grid grid-cols-[minmax(0,16rem)_1fr] gap-x-4 border-b border-bone/10 py-1">
                <span className="text-bone">{name}</span>
                <span>{lic}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
