# Changelog

## [0.3.0](https://github.com/ottonic/simulation-mcp-server/compare/simulation-mcp-server-v0.2.1...simulation-mcp-server-v0.3.0) (2026-10-31)


### ⚠ BREAKING CHANGES

* require Node 26 and move to MCP SDK 2.4.0 ([#15](https://github.com/ottonic/simulation-mcp-server/issues/15))

### Features

* require Node 26 and move to MCP SDK 2.4.0 ([#15](https://github.com/ottonic/simulation-mcp-server/issues/15)) ([52ca895](https://github.com/ottonic/simulation-mcp-server/commit/52ca895fd4905194f3b07ae5adf8c75eaa915388))

## [0.2.1](https://github.com/ottonic/simulation-mcp-server/compare/simulation-mcp-server-v0.2.0...simulation-mcp-server-v0.2.1) (2026-10-31)


### Bug Fixes

* **ci:** make the release publish step idempotent and retryable ([#9](https://github.com/ottonic/simulation-mcp-server/issues/9)) ([f88070e](https://github.com/ottonic/simulation-mcp-server/commit/f88070e25ff7a85093217cc6445335bb072c29a6))
* ship dist/package.json so the published server can start ([#13](https://github.com/ottonic/simulation-mcp-server/issues/13)) ([6dc1905](https://github.com/ottonic/simulation-mcp-server/commit/6dc1905316c59e3945f993030d55d992ba78d602))

## [0.2.0](https://github.com/ottonic/simulation-mcp-server/compare/simulation-mcp-server-v0.1.0...simulation-mcp-server-v0.2.0) (2026-10-30)


### Features

* add standalone simulation MCP server ([002b965](https://github.com/ottonic/simulation-mcp-server/commit/002b965a721a59f2548b4d65f26927a313c3b623))
* add Windows snapshot root identity ([f73e75e](https://github.com/ottonic/simulation-mcp-server/commit/f73e75e9a1ae46195c8188af5d9a43d975508356))
* bound job waits, honour cancellation, publish the study schema (S14-S16) ([81fd509](https://github.com/ottonic/simulation-mcp-server/commit/81fd509b9ddf359d25ef256a511c6ff4c213d363))
* **simulation:** accept engineering units and convert to SI ([b81a927](https://github.com/ottonic/simulation-mcp-server/commit/b81a92756fc2e568bba89bd3d30d23c387367805))
* unify tooling and align the MCP surface with 2026-07-28 ([36c5a8d](https://github.com/ottonic/simulation-mcp-server/commit/36c5a8df82816f2f2d26acb828c5a550981fac57))
* use rooted snapshot helpers on Unix ([2272ae2](https://github.com/ottonic/simulation-mcp-server/commit/2272ae2ab471fadc8c9a043e9f36330b189ffbbd))


### Bug Fixes

* avoid unsupported UCX transport in solver runs ([1accdd1](https://github.com/ottonic/simulation-mcp-server/commit/1accdd1930df1de27b9447abd84484c40df03d86))
* **ci:** generate the bar fixture and normalise line endings ([#8](https://github.com/ottonic/simulation-mcp-server/issues/8)) ([86d2789](https://github.com/ottonic/simulation-mcp-server/commit/86d2789a76583c6164c2075f2ddf80c53cc0e616))
* keep the registry description within the 100-character limit ([#5](https://github.com/ottonic/simulation-mcp-server/issues/5)) ([4cf597d](https://github.com/ottonic/simulation-mcp-server/commit/4cf597d880b0823bc0cbf8ab72ac815dfb00a1b5))
* **simulation:** import STEP files declared in inches ([3112b15](https://github.com/ottonic/simulation-mcp-server/commit/3112b15866c13039a0dd01a782af1a3352857bf8))
* **simulation:** validate solver workflow outputs ([44e4c20](https://github.com/ottonic/simulation-mcp-server/commit/44e4c20332c20bdaeb5349cc826e4d964055cd9c))


### Miscellaneous

* simplify artifacts for trusted local use ([977a631](https://github.com/ottonic/simulation-mcp-server/commit/977a6318912ad302e4c9364d7a0d859ed1e9cc6f))
