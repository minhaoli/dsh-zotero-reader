# dsh-zotero-reader — Zotero reader for DSH

[中文](README.md) | **English**

Read your Zotero PDFs in the DSH right sidebar: page-accurate Q&A, a real outline, and annotations that round-trip with Zotero.

## Why

Research in DSH means papers live in Zotero but reading happens elsewhere. Citing a passage means noting the page by hand; finding out what a paper argues means flipping through it; highlights made in Zotero are invisible everywhere else.

This plugin lets the assistant read PDFs straight out of your Zotero library, keeping content aligned to pages:

- Ask it to search your Zotero library; every result carries an `itemKey`, and `zotero://<key>` in an answer opens the paper
- The right sidebar renders the PDF, so answers cite "page N" exactly — click the page to jump there and highlight it
- The outline is extracted from the PDF text layer by font size, so the real section structure shows up
- Select text to translate, explain, or write it back to Zotero as a highlight

## Features

| Feature | Notes |
|---|---|
| Library tools | `search_zotero_library` / `read_zotero_paper` / `ask_zotero_paper` for the model |
| Sidebar reader | pdf.js rendering with zoom, page jump, continuous scroll |
| Library browsing | All papers grouped two levels deep by your Zotero collections, searchable; plus a "found in this conversation" view |
| Page-accurate Q&A | Passages come from the text layer, so page numbers are real; page references in answers are clickable |
| Outline | Headings detected by font size (more reliable than line length or word lists); click to jump |
| Selection actions | Translate / explain / ask / highlight |
| Annotations | Shows existing Zotero annotations; highlights write back to Zotero |
| Multiple PDFs | One sidebar tab per paper, each keeping its own page and zoom |
| MinerU (optional) | Re-parse scanned or formula-garbled PDFs; off by default |

## Install

```bash
cd <your DSH profile>/node_modules
git clone https://github.com/<user>/dsh-zotero-reader.git
```

Add the dependency and bundle to your profile `package.json`:

```json
{
  "dependencies": { "dsh-zotero-reader": "link:<absolute path to the plugin>" },
  "dsh": { "profile": { "bundles": ["dsh-zotero-reader"] } }
}
```

Restart DSH. A "Zotero reader" card appears on the right sidebar's start page.

The plugin ships its own `pdfjs-dist` dependency — install it once:

```bash
cd <plugin dir> && npm i
```

## Configuration

Settings live in the plugin's `cordis.patch.yml`, and can also be changed from the ⚙ panel in the reader toolbar (applied immediately, stored in `~/.dsh-zotero-reader/settings.json`).

| Key | Default | Meaning |
|---|---|---|
| `zoteroDataDir` | auto-detected | Zotero data directory (contains `zotero.sqlite`) |
| `mineruMode` | `none` | `none` / `local` / `cloud` |
| `mineruLocalUrl` | `http://127.0.0.1:8000` | Local MinerU service URL |
| `mineruCloudToken` | empty | mineru.net token |
| `mineruAutoOnScanned` | `true` | Switch to MinerU automatically for scanned PDFs |
| `selectionProvider` / `selectionModel` | empty | Model for selection actions; empty follows the host |

### Writing annotations

Writes go through the [Zotero local API](https://www.zotero.org/support/dev/web_api/v3/local_api), which requires:

1. **Zotero 10 or later** (the local API is read-only in 7/8)
2. Zotero running, with Settings → Advanced → "Allow other applications on this computer to communicate with Zotero" enabled
3. A one-time confirmation dialog on the first write — choose "Allow" or "Always Allow"

Reading existing annotations has none of these requirements: it uses a database snapshot and works while Zotero is running.

## Where data lives

- Settings and cache: `~/.dsh-zotero-reader/` (`settings.json`, `cache/`, `translate/`)
- The Zotero database is never modified directly; writes go through the local API so Zotero handles indexing and sync itself

## Development

```bash
node --check index.js          # syntax check
node test/host-e2e.mjs         # host-side end-to-end (needs a local Zotero library)
```

`test/host-e2e.mjs` exercises the real code path: it runs `apply()` against a minimal proxy context, captures the handler passed to `webServer.register`, and drives it with fake req/res objects.

## Known limitations

- Page numbers are exact on the native text-layer path; files re-parsed by MinerU get approximate pages, marked "≈" in the UI
- Multi-page selections only use the first page (Zotero stores annotations per page)
- Writing annotations needs Zotero 10+; otherwise the Highlight button is disabled with an explanation
- The outline falls back to section keywords for layouts where headings match body text in size

## License

Not specified; all rights reserved.
