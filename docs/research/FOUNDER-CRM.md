# A founder’s CRM in Worldview

Research and implementation notes, November 25, 2026.

A useful founder workflow starts with a person on a webpage and ends with a decision. Can I meet them on this trip? Who could introduce us? What did we last discuss, and do I owe them a reply? Those questions shaped the changes to Worldview Reader, People, Companies, Places, and Tasks.

## What the benchmarks actually do

| Source | What the source establishes | Implication for Worldview |
| --- | --- | --- |
| [Folk’s browser capture](https://help.folk.app/en/articles/5817463-download-folkx-extension) and [enrichment](https://help.folk.app/en/articles/6804416-1-click-enrichment-find-emails-phone-numbers) | Folk retrieves available details from a loaded profile and lets the user pick a group. Finding missing contact details is a separate provider-backed service. | Preview the subject on opening Reader, save the selected group with the record, retain the original, and protect existing edits. Expect coverage to depend on the page. |
| [Attio communication intelligence](https://attio.com/help/reference/managing-your-data/enriched-data) and [relationship attributes](https://attio.com/help/reference/managing-your-data/attributes/relationship-attributes) | Communication attributes distinguish first, last and upcoming events. Record relationships can be navigated in both directions. | Show actual touches and their sources. Make each company a way back to people. Education, overlapping current roles, and former employment need distinct labels. |
| [8VC’s account of using Affinity](https://static.affinity.co/files/8vc-customer-story.pdf) and [Affinity’s relationship intelligence](https://www.affinity.co/product/relationship-intelligence) | Investment teams need to recover context before outreach and find an existing relationship into an organization. | A company page should answer both “who works here?” and “who in my CRM is connected to them?” Confirmed links and recorded context support an introduction request. |
| [Happenstance](https://happenstance.ai/) | Its network search shows a path through a friend or group alongside the person found. Its reach depends on the networks connected to the service. | Explain the path in the result. In Worldview, an introduction path names both saved contacts and the recorded link. A shared employer alone cannot establish that two people know each other. |
| [Twenty’s open-source repository](https://github.com/twentyhq/twenty) | Its configurable CRM combines records, relationships, views and workflows so teams can adapt the system to their process. | Worldview already had groups, custom fields, boards and saved views. Reuse one contact across fundraising, recruiting and customer discovery, with group-specific stages and notes. |
| [Material Security founders interviewed by First Round](https://review.firstround.com/material-securitys-path-to-product-market-fit/) | The founders used Streak during early customer validation. They tracked prospects moving from conversations through concrete commitments such as joining an early-access program. | Put a dated follow-up on the person and surface stale relationships that have no open task. Email volume by itself does not establish deal progress. |
| [Visible’s fundraising workflow](https://pages.visible.vc/fundraising-road-map) | Investor fit, introduction route, feedback and next steps all matter while moving through a raise. | Keep the investor firm, individual partner and introduction source navigable. Stage, thesis fit and next action can live in an existing fundraising group. |

These sources span product documentation, public code, and operating examples. Vendor pages establish documented functionality. The founder interview and 8VC case illustrate particular teams’ practices. They do not establish a universal ranking or the prevalence of any workflow across startups.

## Changes to the daily workflow

**Capture a person you are looking at.** Reader previews the active page, including a recognizable subject and available fields. Adding it to a group saves the contact, affiliations and source together. A named image can become the local portrait or company mark. Repeating the capture should reuse the matching contact. A conflicting identity goes to review. Manual creation can use a supplied website for enrichment and surfaces existing CRM records while typing.

**Open an organization before a meeting.** See links, industry and recorded location alongside current staff, former staff, education and other affiliations. Confirmed person-to-person links into the current roster supply possible introducers. A missing public website can be looked up by name and selected with its Wikidata source. The local profile retains its own notes when enrichment adds fields.

**Work out how you know someone.** Activity shows the earliest and latest recorded touches, recent volume, sent and received counts and dated follow-ups. Email subjects are optional. Explicit introducers and personal notes supply context that a message count cannot. Google connections are authorized separately for each account in Worldview. Gmail coverage starts with retained and synced messages, and pending contact discoveries can be reviewed. Shared addresses, recognized mailing lists and automated notices are excluded from the direct-mail counts. A calendar invitation contributes after attendance is confirmed for that contact. Google Contacts can supply locality and dated employment or school records when those fields are present. [Google People API organization fields](https://developers.google.com/people/api/rest/v1/people#Organization).

**Plan a trip.** Places uses the selected group’s reported locations. Choose a city and radius, then open a person’s record for their work and relationship history. Company locations have their own view. City centers are approximate. Unrecognized or ambiguous locations remain visible in the unmatched list. The offline dataset comprises 7,342 populated places and a world land outline. [Natural Earth populated places](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/) and [Natural Earth land](https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/).

**Decide who needs a follow-up.** Tasks can surface contacts whose last observed interaction was at least 30 days ago and who have no open reminder. This is a practical default for reviewing a founder’s network. A long gap can also mean missing account history. Use the date and source when deciding whether to reach out.

## Where coverage ends

A private social profile supplies the fields visible to Reader when opened. A social link does not grant access to message history. Worldview supports local contact exports and Google account connections; it does not mirror friends’ networks from Happenstance, run Folk’s commercial provider waterfall, or infer a home address from an employer. Accurate enrichment also depends on the page exposing usable information and the organization being identifiable.

Other benchmark capabilities that merit separate product decisions include company-wide relationship scores, stage conversion reports, time-in-stage trends, and tracking investor targets against a funding goal. The useful inputs for those features are explicit team membership, dated stage transitions and amounts. Sales stages or investor interest cannot reliably be reconstructed from the number of emails exchanged.

## Verification on the 8VC example

In a temporary SQLite workspace, selecting 8VC’s Wikidata result and enriching its website produced one company with the official homepage, LinkedIn page, description, saved logo and Austin headquarters. Two source captures were retained. A structured industry value was unavailable in that run. The roster is derived from contacts in the active CRM, so the public lookup alone cannot establish which people the user knows at 8VC. [8VC](https://www.8vc.com/) and [selected Wikidata entry](https://www.wikidata.org/wiki/Q128796094).
