# Security

Keep tokens only in existing gh authentication or an explicitly selected environment
variable. Do not include secrets, real configuration, raw responses or personal reports
in issues, pull requests or public logs. Report suspected vulnerabilities privately
through the repository owner's available private contact or GitHub private vulnerability
reporting if enabled. No email address or private-reporting availability is implied.

The runtime has no GitHub write interface and never executes scanned code or hooks.
Before publishing, scan staged files, complete Git history and clean release archives
with Gitleaks and the project public-path checker. A pattern scan is not proof that
arbitrary personal data is safe to publish; review the actual file and archive lists.
