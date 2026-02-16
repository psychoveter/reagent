## reagent-vscode (syntax highlighting only)

Minimal VSCode/Cursor extension that provides **syntax highlighting** for Reagent `.rg` files.

This is intentionally small and stable while the language evolves.

### Local development

- Open this folder in Cursor/VSCode.
- Run the extension in an Extension Development Host.
- Verify `.rg` files highlight:
  - `projects/reagent/examples/**/*.rg`
  - `projects/reagent/lang-spec.md` code fences tagged as `reagent` (optional)

### What to update when the language changes

- TextMate grammar: `syntaxes/reagent.tmLanguage.json`
- Token coverage for new keywords / directives / delimiters.

