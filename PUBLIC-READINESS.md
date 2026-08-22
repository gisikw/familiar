# Public-readiness inventory

This inventory records private-project terminology and personal/deployment identifiers intentionally left after the `rewrite` public-readiness scrub. Line numbers describe this revision. The branch's genuinely new trees (`agents/`, `packages/`, `services/server/`, `services/presence/`, `integrations/pi/extensions/agents/`, and `RESTRUCTURE-NOTES.md`) were searched separately and contain none of the audited identifiers.

The entries below predate `rewrite` (confirmed with rename-aware diffs and `git log --follow`) or are protected/behavior-bearing values. They were not mass-renamed because doing so would risk compatibility or violate the scrub constraints.

| Remaining instance(s) | What it reveals | Why left | Suggested future remedy |
|---|---|---|---|
| `README.md:29` | Public GitHub account/repository URL (`gisikw`) | This is the functional clone URL for the already-public repository, not private infrastructure. | Replace with the final organization URL if ownership changes. |
| `apps/desktop/package.json:14` | Reverse-domain app identifier containing `gisi` | Changing `appId` can change signing/update identity and installed application data behavior. | Plan an explicit desktop application-ID migration. |
| `integrations/pi/extensions/worklist/index.ts:639,651`; `integrations/pi/extensions/worklist/policy.ts:135` | Personal first name in user-facing/policy language | Functional conversational policy/config explicitly excluded from this scrub. | Make the operator display name configurable and use a neutral fallback. |
| `integrations/pi/extensions/web/index.ts:96,106` | Generic tailnet terminology and CGNAT classification | This is functional private-network request filtering, not a specific tailnet/topology. | Rename comments to generic overlay-network terminology without changing address classification. |
| `scripts/herdr-sidebar.sh:7` | Personal first name in provenance comment | Pre-existing validation provenance; unrelated to branch changes. | Replace with “validated” in a focused shell-script cleanup. |
| `skills/herdr/SKILL.md:68,70`; `skills/herdr/reference/agents.md:17` | Personal first name in agent-use guidance | `skills/` was explicitly out of bounds for this scrub. | Review and parameterize skill prose separately. |

## Scrub summary

- **Tier 1 (new branch content):** 0 instances found, 0 fixed. Rename-aware review found no audited PII/private-infrastructure identifiers in genuinely new content.
- **Tier 2 (cheap wins):** 25 flagged lines across 11 files neutralized. This removed the private hostname/auth topology and non-functional personal-name comments/provenance. The desktop fallback is now the local gateway (`http://localhost:1692`); `FAMILIAR_BASE_URL` and user config still take precedence.
- **Tier 3 (inventory):** The remaining instances are listed above. They are limited to protected policy/skill prose, a stable desktop app ID, the public clone URL, and generic private-network filtering terminology.
