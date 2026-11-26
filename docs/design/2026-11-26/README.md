# A note's history in Obsidian (26-11-2026)

The design the owner signed off on 26-11-2026 on the canvas
[Knap in Obsidian](https://claude.ai/artifact/LPUd1ogfviqFAx3jCmU5tR). The
`.dc.html` files are its boards, copied as published; `canvas.json` holds the
notes beside them. What ships is described in [../../ui-ux.md](../../ui-ux.md),
"A note's history"; the server side is admin ADR-0116.

| Board | What |
|---|---|
| `Main` | The corner: click opens a menu with the status, Last changed, Created and Version history. Try again only under Problem. No Settings item. |
| `Panel` | Version history in the right sidebar, following the open note. |
| `Version`, `Restore` | One version in a tab, its changes marked; Restore asks first and names who else has the note open. |
| `Phone`, `PhonePanel`, `PhoneVersion` | No status bar on a phone: the icon sits in the note's header and opens the same view as the right drawer. |
| `Settings` | As it was, plus when it last synced. |

`screenshots/` are the real plugin in Obsidian 1.15.1 against a local vault
service (dev login), taken 26-11-2026: the menu, the sidebar with two versions,
a version, the Restore question, and the list after the restore.

Restore runs on the server and lands in the live note as a change; it is never
a write to the file on this device. Restoring from a local file is what an
offline device in Obsidian Sync undoes later (see the ADR).
