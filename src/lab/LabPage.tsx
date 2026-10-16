import { useEffect } from 'react'
import { ArrowPanel } from './demos/ArrowPanel.tsx'
import { GrowthPanel } from './demos/GrowthPanel.tsx'
import { installLabDevApi } from './demos/devApi.ts'
import { releaseJobs } from './demos/labClient.ts'
import { LabWorldPanel } from './demos/LabWorldPanel.tsx'
import { DustIdentityPanel } from './s2/DustIdentityPanel.tsx'
import { S2Panel } from './s2/S2Panel.tsx'

// #/lab: the physics demos (birth-free lab world, S(t), exact reversal and the Loschmidt
// flip, the arrow of time, the measured growth rate) and the CPU↔GPU dust checks.
export default function LabPage() {
  useEffect(() => {
    installLabDevApi()
    return releaseJobs
  }, [])
  return (
    <div className="h-full overflow-auto bg-void p-6 font-mono text-bone">
      <header className="mb-6 flex items-baseline gap-4">
        <h1 className="text-[13px] uppercase tracking-[0.2em]">lab</h1>
        <nav className="flex gap-3 text-[11px] uppercase tracking-wider text-concrete">
          <a className="hover:text-bone" href="#/">
            world
          </a>
          <a className="hover:text-bone" href="#/lab/perf">
            perf
          </a>
          <a className="hover:text-bone" href="#/lab/s1">
            s1
          </a>
        </nav>
      </header>
      <div className="max-w-6xl">
        <LabWorldPanel />
        <ArrowPanel />
        <GrowthPanel />
        <S2Panel />
        <DustIdentityPanel />
      </div>
    </div>
  )
}
