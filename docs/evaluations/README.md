# Evidence retrieval regression evaluation

Run `node scripts/eval-retrieval.ts` from the repository root. It executes all 50 cases against the actual SQLite FTS5 index and portable lexical fallback, then writes `docs/evaluations/retrieval-eval.v1.json`. `npm test -- tests/artifacts/retrievalEvaluation.test.ts` also checks the fixture and metric formulas. No model or network service is called.

The fixture contains 18 synthetic sources with versioned passages, human/assistant/third-party/unknown roles, known and unknown authored dates, conflicting statements, current restrictions, an intentionally corrupt offset, Unicode, and a deliberately oversized passage. Seven maintained-page fixtures include approved profile/project wording plus proposed, stale, withdrawn and AI-private counterexamples. Each engine executes 50 questions: 38 have graded relevant-source labels and 12 require abstention.

Measured on Node 26.5.0 with the checked-in fixture:

| Engine | Source recall@5 | MRR@5 | Graded nDCG@5 | Abstention | Policy/citation/delivery checks |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQLite FTS5 | 1.0000 | 1.0000 | 0.9995 | 12/12 | 700/700 |
| Portable lexical fallback | 1.0000 | 1.0000 | 0.9913 | 12/12 | 700/700 |

Ranking metrics deduplicate full source identities before the cutoff. Recall uses all labeled relevant sources as its denominator. Reciprocal rank uses the first relevant source position. nDCG uses gains `2^grade - 1` and discounts `log2(rank + 1)` against the ideal graded ordering. Empty-relevance cases are scored separately as abstention and are excluded from ranking averages. The JSON report retains each question, expected source grades, actual passage/source ranking, full citation identities, packet contents, omissions, budgets and failed invariant names.

Checks cover exact source-version offsets and attribution; source, kind, role and inclusive authored-date filters; explicit historical retrieval; current exclusion/deletion/AI rules on cached historical results; exact rendered citations; actual approved context text in the rendered provider packet; UTF-8 byte measurement; and omission accounting. A local non-AI read can see an AI-disabled source, while the packet independently suppresses it. Long evidence is omitted intact rather than shortened behind unchanged offsets. These cases caught and fixed the fallback treating `Tern` as a substring of `lantern` and `eastern`.

These numbers describe this controlled regression fixture. They do **not** measure semantic embeddings, real-user relevance, answer faithfulness, belief correctness, or whether a model followed supplied context. Provider delivery means that the exact text reaches the serialized packet; no provider request is made here. Add consented real-corpus queries and independent relevance judgments before using these results to choose a search model or claim general retrieval quality.
