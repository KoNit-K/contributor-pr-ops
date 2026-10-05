# Contributor PR Ops

Local, read-only contributor pull request maintenance and contribution evidence.
A TypeScript CLI that runs without agents, models, or MCP.

## Development status

This is an unreleased implementation. A release requires all gates in
[DESIGN_V1](docs/DESIGN_V1.md) and [ACCEPTANCE_V1](docs/ACCEPTANCE_V1.md).
No successful real-target validation or published version is claimed by this document.

## Reference environment and installation

Reference: Node **24.20.0** (LTS), npm **11.19.0**. `.nvmrc` is the single Node
selection file. Node 24 and npm 11 compatible patches are accepted. Git is required
for contribution analysis. `gh` is required only for gh authentication or project
publishing; environment-token authentication and offline operations do not require it.

```sh
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js init
```

Edit `config/local.yaml` using the one generic sample. Configuration-relative paths
are resolved from the configuration file directory. The authenticated account can
differ from the contribution author. Credentials are never configuration values.
For `auth.method: env`, set the variable named by `auth.token_env` in your local shell.
An existing environment file may be explicitly sourced by the user; the application
does not search for environment files or credentials.

SQLite uses the Node 24 built-in `node:sqlite` module, with extensions disabled.
Node labels this API **release candidate (stability 1.2)**; this is a documented
runtime limitation. It avoids a separate native addon/toolchain. The initially
cached native addon failed an expanded test and was removed. macOS checks are
local; clean Linux CI remains a release gate.

## Verification

```sh
npm run verify
npm run acceptance
```

`verify` checks static safety, types, offline tests, build and intended public paths.
Full-history Gitleaks and real-target acceptance are additional release requirements.
See the acceptance specification for fixed expected results and evidence fields.

## Privacy

Real configuration and all operational data belong in ignored local storage.
The runtime does not modify scanned GitHub repositories or contribution branches.
This package is private to prevent accidental npm publication.
