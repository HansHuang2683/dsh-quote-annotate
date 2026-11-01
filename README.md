# dsh-quote-annotate

**Select any passage in a DeepSeek Harness conversation, annotate it in place, and send the quote + your comment with your next message.**

A small, dependency-free Web UI plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH 0.2.1-rc.3+). No build step — one hand-written browser module.

[中文说明 →](README.zh.md)

## What it does

1. **Select** any text in the transcript (your message, an assistant reply, a tool output) → a floating **Annotate** button appears above the selection.
2. Click it → a floating comment box opens next to the selection (quote preview + textarea + Cancel / Save; `⌘/Ctrl+Enter` saves, `Esc` cancels).
3. **Save** → the quoted passage is highlighted with a numbered badge (`①`). Click a badge to edit its comment later.
4. A strip the same width as the composer appears **directly above the composer**: `① annotations · attached to your next message` — expand it to review, edit, jump back to the source, or delete each annotation.
5. **Send as usual** (Enter or the send button). The plugin folds every annotation into the message as a compact block:

```text
my question …

【我的批注】

批注 1｜Assistant · turn 3
原文：
   the paragraph you selected
批注：your comment
```

The model therefore receives *the exact quoted text, where it came from, and what you think about it* — which is the whole point: no more "I meant the thing above".

## Install

Requires DeepSeek Harness **0.2.1-rc.3 or newer** (Web / Desktop Web UI).

Using the `plugin_manager` tool (or the Plugins page → Add plugin):

```text
action: install_bundle
target: https://github.com/HansHuang2683/dsh-quote-annotate
```

or point it at a local checkout directory, or at a packed tarball:

```bash
pnpm pack --pack-destination dist
# then: install_bundle, target: <abs path>/dist/dsh-quote-annotate-1.0.0.tgz
```

After installing, reload the page (in the Desktop app: `Ctrl+R`, or fully quit and relaunch). Plugin Manager → Plugins shows **“Selection Annotations”**.

## Design notes

- **Official seams only.** `shell.overlay` renders the selection toolbar, the comment box, the numbered badges **and the annotation strip**; `conversation.input.overlay` holds an invisible “input bridge” that exposes the composer's `inputActions` to the plugin. Standard slot props `useInput` / `inputActions` (`setDraft`, `submit`) drive the composer.
- **Highlighting without touching foreign DOM.** Highlights use the CSS Custom Highlight API (`CSS.highlights`) over `Range`s rebuilt from stored text offsets, so no other plugin's DOM is wrapped or mutated.
- **Send interception is deterministic.** On `Enter` (capture phase, IME-aware) or a send-button click, the plugin writes `body + annotation block` into the composer, waits until the new draft is actually published, then calls `inputActions.submit()` itself. The native submit path never reads a stale draft.
- **Shared state on `window`.** HMR can leave the two halves of a bundle from different module generations; the annotation list / bridge live on `window.__DSH_QUOTE_ANNOTATE_SHARED__` so both halves always see the same state.
- **Light / dark themes.** Reads the host `theme` service (`getTheme().active.colorScheme`), reacts to `theme/change`, falls back to the luminance of `--dsw-alias-bg-base`, and renders its own two palettes (`--dqa-*`). Filled accents deliberately use `--dsw-static-deepseek-500`, because `--dsw-alias-brand-primary` is *white* in dark mode.

## Known limitations

- The composer is **not focused automatically** after saving an annotation (DSH exposes no “focus the editor and keep the caret” seam); click the composer and start typing.
- Badges and highlights depend on the transcript's `data-chat-flow-key` / `data-chat-turn` attributes. If a future DSH changes them, highlighting degrades gracefully (annotations still listed and still sent) — the send fold only uses text.
- A long quote is truncated to 1200 characters in the sent block (the annotation list keeps the whole quote).
- Web / Desktop Web UI only; the TUI is not supported.
- If the annotation strip ever disappears or annotations stop being attached after a plugin update, fully quit and relaunch DSH — a half-mounted bundle after hot reload is a known host quirk, and the strip's 「Insert」 button is a manual fallback that always works.

## Repo layout

| File | Purpose |
|---|---|
| `client.js` | Entire feature: selection tracking, floating UI, badges, strip, send interception |
| `index.js` | Inert Host half — exists so DSH mounts the package's `dsh.client` entry |
| `cordis.patch.yml` | Bundle patch inserting the `quote-annotate` row |
| `locale/{zh,en}.json` | Plugin Manager title / description |
| `icon.svg` | Plugin icon |

## License

MIT © 2026 HansHuang2683
