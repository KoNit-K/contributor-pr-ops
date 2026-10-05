# Contributor PR Ops development

Read docs/DESIGN_V1.md and docs/ACCEPTANCE_V1.md. Keep runtime targets generic.
Runtime GitHub access is read-only, through the shared client. Never execute scanned repository code or hooks.
Use synthetic fixtures and temporary Git histories. Offline tests must reject network access.
Before committing, run npm run verify and public-content checks. Before releasing, run npm run acceptance and all required real read-only acceptance checks.
Local configuration, credentials, databases, reports and actual API responses are private and ignored.
Do not weaken acceptance assertions or replace implemented algorithms with unknown placeholders.
