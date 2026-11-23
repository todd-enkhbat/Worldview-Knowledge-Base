# GBrain source attribution

`rrf-page-fusion.ts` copies `src/core/search/rrf-page-fusion.ts` from the same pinned commit under MIT. Its algorithm is retained; the type import points to a narrow local `search-types.ts` contract carrying full Worldview passage identities. `src/knowledge/retrievalTrace.ts` adapts those records and exposes source-version ranks and individual votes. No GBrain database or runtime is installed.

`supersede-interval.ts` is an unchanged copy of `src/core/facts/supersede-interval.ts` from [garrytan/gbrain commit 47512aa50fa2be1ab3af55bf60c242a11be76392](https://github.com/garrytan/gbrain/blob/47512aa50fa2be1ab3af55bf60c242a11be76392/src/core/facts/supersede-interval.ts), reused under the accompanying MIT license.

Worldview validates dates at its command boundary and uses this helper only to derive an accepted claim revision's effective validity end. It does not use similarity to decide whether a statement supersedes another. Source revisions and previous claim wording are retained; XYZ world anchors and physics are unaffected.
