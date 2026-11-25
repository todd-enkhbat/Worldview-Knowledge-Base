# People workspace design

The three generated references in `references/crm-*.png` are synthetic design studies, not screenshots of working features or real contacts. They were generated for a warm, local personal CRM inside Worldview with a table, contact inspector, relationship map and calendar event picker. No sample contacts are seeded into the user's workspace.

Implementation retains Worldview's Earth mark, self-hosted Inter typography and light/dark tokens. A restrained forest-green accent gives People its own navigation state. Compact group navigation, 48px table rows and a 350px inspector keep the contact record and comment composer close together. On smaller screens the inspector becomes an overlay; mobile uses a full-width drawer.

The network uses stable group-based positioning with searchable people. Solid lines represent explicit connections; calendar context is separately styled and never presented as friendship. Labels are bounded and detail appears on focus. Motion is finite and respects reduced-motion preferences. Calendar selection retains account, calendar, event and recurrence identities, and separates scheduled or unconfirmed events from confirmed attendance.

Dense tables use TanStack Table and Virtual rather than decorative dashboard cards. All controls need keyboard focus, visible save/error states and real persistence. Provider connection states and unavailable migration history must remain explicit. Existing notes and the 3D world are separate from CRM records.
