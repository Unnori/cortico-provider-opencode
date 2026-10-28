# AGENTS.md

Release checklist for this Cortico provider extension. How to write one:
[docs/providers.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/providers.md) and
[docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

- [ ] **Contract version**: `cortico.api` equals the provider version on the `Contracts:` line that
  `check:extension` prints (provider v6 at 0.2.0). A package with any other value does not load.
- [ ] **Self-description**: after changing protocols, sign-in methods, local model or accepted input,
  run `pnpm describe:extension <dir>`. `cortico.describe` names the written file and `files` ships it.
- [ ] **Panel bundle**: `pnpm build:webui` after changing anything under `src/webui/`, and commit
  `dist/webui.js`. It is loaded from the installed package without a build step, so a stale bundle ships
  the old panel; `files` must keep `dist`.
- [ ] **Prices**: `src/pricing.ts` is generated from the two official pages; re-read both when the
  published tables change and regenerate rather than editing numbers by hand. The generation scripts
  live in the development scratch directory, not in this package.
- [ ] **Tags**: `cortico.tags` is empty on purpose. A provider's own key is not `requires-key`, and
  talking only to the model endpoint is not `internet`; no tag in the vocabulary describes this package.
- [ ] **CHANGELOG.md** has a `## <version>` section for the version being published.
- [ ] **`os`**: none, the package is platform-independent.
- [ ] **`pnpm typecheck && pnpm typecheck:web && pnpm test`** and **`pnpm check:extension <dir>`** pass.
- [ ] **Requests to the maintainers** (tag changes, certification, a replacement package, appeals)
  are issues in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions), in
  the plain-text format that `check:extension` prints and the README describes.
