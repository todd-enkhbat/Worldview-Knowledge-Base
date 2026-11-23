# Selected source references for reuse

These are exact upstream files selected during the November 23, 2026 study. They are **inert references**, not imported into the app and not installed as agent skills. TypeScript filenames end in `.ts.txt` so project discovery cannot compile or execute them accidentally. File contents are unchanged; [manifest.json](manifest.json) records original paths, commits and SHA-256 hashes.

| Reference | Why keep it | Work needed before application use |
| --- | --- | --- |
| GBrain `src/core/facts/supersede-interval.ts` | Small, zero-import validity-interval primitive | Validate dates first; map our proposed claim fields and add boundary tests. This helper does not decide whether one assertion replaces another. |
| GBrain `src/core/search/rrf-page-fusion.ts` | Page-level voting, distinct chunk representation and explainable rank contributions | Supply a Worldview-compatible result type; retain full source/version IDs; validate parameters and benchmark source-diversity effects. The upstream type import is not included. |
| QMD `src/bench/types.ts` | A compact example of structured retrieval fixtures and result reporting | Use our exact passage IDs and conventional metrics. Do not copy QMD's scoring implementation unchanged. |
| Claude-Mem `src/shared/progressive-search.ts` | Progressive search/detail budgeting and explicit bounds | Node `Buffer` usage and a parameter-property constructor require adaptation for our runtime/erasable TypeScript. It is not a browser drop-in. |
| Claude-Mem `src/services/context/ContextBudget.ts` | Budget the context packet assembled for the agent | Its `ContextConfig` type import is not bundled here; define our packet fields and measure final rendered size/model budget. |
| Obsidian `obsidian-markdown` plus properties/embeds/callouts references | Correct Markdown interchange instead of a partial invented grammar | Implement parsing/serialization and ambiguity handling in our existing importer; imported document text is never privileged instruction. |
| Obsidian `json-canvas` and example reference | Portable investigation maps | Map supported nodes/edges and full source identity; retain separate 2D versus world-XYZ semantics. |
| Obsidian `obsidian-bases` and function reference | Collection/view interchange | Export a documented safe subset; this does not authorize building or executing an arbitrary formula engine. |

GBrain and QMD files retain their root MIT licenses. Obsidian copies include both root and plugin MIT licenses. Claude-Mem copies retain Apache-2.0 LICENSE and NOTICE. No Basic Memory core or Karpathy gist prose was placed in this redistributable kit. Root licenses do not automatically clear unrelated dependencies, vendored code or model weights.

The complete upstream source copies, including all seven Obsidian skills, remain under the local ignored research download directory. This deliberately small kit captures useful material without adding four overlapping engines or automatically changing active agent instructions. See [the study](../README.md) and [integration plan](../INTEGRATION-PLAN.md) before selecting an implementation.
