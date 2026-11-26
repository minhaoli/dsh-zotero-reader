# Zotero Paper Reader

Bring the papers in your Zotero library into a DSH conversation. When the assistant mentions a paper you own, the right sidebar offers a way in: the local PDF opens there, and citations, translation and annotations all happen in one place.

## What it does

- **Open the source inline**: a `zotero://…` link in the conversation opens the paper in the right sidebar at the cited page.
- **Page-aware Q&A**: ask about a page or search inside the document; page numbers in answers link back to the source.
- **Selection translation and explanation**: select text to translate or explain it, with formulas preserved; switch between original, bilingual and Chinese-only views, and export either.
- **Annotations in sync**: highlights and notes added in the sidebar are written back to Zotero; when the local API is unavailable it falls back to the cloud Web API.
- **Scanned PDFs**: pages without a text layer can be parsed by MinerU (local or cloud) and then searched, translated and annotated like any other paper.

## Interface

- **Right sidebar**: a new "Zotero Paper Reader" tab holds the paper list and the PDF reader, with page, zoom, view-mode, translation and annotation controls on its toolbar.
- **Left sidebar menu**: a "Zotero Paper Reader" row opens the full-page settings view.
- **Conversation**: `zotero://` links carry the paper title and open the reader on click.

## Notes

- PDFs are read from the local Zotero data directory and never uploaded; translation and Q&A use the model selected for the conversation.
- Turning the plugin off removes the sidebar tab and the menu entry; saved settings remain.
