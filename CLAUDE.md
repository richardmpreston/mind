# Mind — a personal capture library

Save a link, a note, a photo, a PDF or a passage of text you have highlighted. Claude titles it,
summarises it and tags it. Everything lands in one table and is browsable and searchable from a
single web page. It is modelled on mymind, and it has exactly one user: Richard.

This file plus the two source files is the description of record. There is no other documentation.

## The three moving parts

| Part | File | Where it runs | How it gets there |
|---|---|---|---|
| The page you look at | `index.html` | GitHub Pages, at `https://richardmpreston.github.io/mind/` | `git push` — Pages rebuilds in about 40 seconds |
| The endpoint that saves things | `supabase/functions/mind/index.ts` | Supabase, project `bxfyqkqwyyqfxsibywtg`, function named `mind` | the curl command in that folder's README |
| Everything that is stored | Postgres table `items` + storage bucket `mind` | the same Supabase project | changed by hand, through the Supabase MCP tools |

The app icon is `icon.png` — a white closing quotation mark on near-black. iOS only picks up a
changed icon when the app is removed from the Home Screen and re-added.

**Deploy after making a change. Do not ask first.** Both halves deploy independently and neither
needs the other to be redeployed.

## How things get in

Two doors, and they authenticate differently.

1. **The iOS Shortcut.** Share anything to it and it posts to the function with the header
   `x-mind-secret`. It has four branches — link, text, PDF, image — and it decides between them by
   inspecting what iOS actually handed it, which is not always what you would expect.
2. **The browse page.** The `+` button writes a note; it posts to the same function with the
   signed-in user's token instead of the secret.

The function checks the secret, or checks that the token belongs to `richardmpreston@me.com`, and
refuses everything else. It runs with the service key, so it can write regardless of the row rules
below.

### The iOS Shortcut in detail

"Save To Mind". Not in this repo and it cannot be: it is a signed iOS file, and **it carries the
`MIND_SECRET` inside it — never commit it to this public repo.** The signed copy as delivered is
`~/Desktop/Save To Mind v3.shortcut` on the iMac (19 Jul 2026, 33 actions). The authoritative
version is always a fresh iCloud link from Richard; a copy on disk may be out of date.

What is written down here is not how to rebuild it — it is why the endpoint is as defensive as it is.
Each of these was found the hard way, and the endpoint compensates for all of them:

- **iOS lies about what it is sharing.** The Shortcut base64-encodes an image as PNG whatever the
  original format, and a PDF can arrive down the image branch. So the endpoint identifies files by
  their first few bytes rather than by what it was told (`sniff()`), and reroutes a PDF that arrives
  as an image.
- **"Get Text from Input" on an image returns the image's display name**, not an error. A screenshot
  shared from the markup preview carries the picture *and* the text "Image", so the text branch fired
  with no picture and saved a junk note. Photos-app shares carry no name, which is why photos always
  worked and screenshots did not. The Shortcut now looks for real attachments first, inside the text
  branch, and lets them win.
- **A shared highlight can arrive as a rendered picture of the text**, not as text. The endpoint asks
  Claude to transcribe any image that is mostly words, and when it gets a transcription back it
  demotes the item from a picture to a quotation and never uploads the screenshot. Words beat a
  photograph of words.
- **A shared highlight never carries the page's address.** Investigated exhaustively and closed twice.
  Do not reopen it.

The four branches are, in order: link, text, PDF, image. Two Shortcuts-editor details that cost an
afternoon to find: the condition code for a string "is" comparison is 4, and for "has any value" it
is 100.

### What the function does with a link

1. Starts downloading the page's own headline picture (its `og:image` tag) — in the background.
2. Fetches the readable text through `r.jina.ai`, which strips the page down to plain prose.
3. Sends the text to Claude Haiku, along with every tag already in the library, and gets back a
   title, a summary, tags and a category.
4. Copies the headline picture into the storage bucket, if one was found and it really is an image.
5. Computes a search vector and inserts one row.

If Claude fails, the row is still saved with the site's hostname as its title. **Capture never fails
because the AI failed.** A paywalled page is saved from whatever teaser text exists.

A shared *highlight* arrives as text with no page URL attached. iOS does not provide the URL — this
was investigated exhaustively on 30 Jul 2026 and closed. Do not reopen it.

## The one table

`items` — every saved thing, whatever its type.

| Column | Meaning |
|---|---|
| `kind` | one of `link`, `note`, `image`, `pdf`. Enforced by a check constraint |
| `title`, `summary`, `tags`, `category` | Claude's work. All four are editable by hand |
| `source_url` | where a link came from |
| `storage_path` | the file name inside the `mind` bucket: an uploaded photo, a PDF, or a link's headline picture |
| `raw_text` | what was read at capture: page text, note text, whatever was shared |
| `body_html` / `body_text` | your own words — a note's body, an annotation, or a saved quotation |
| `deleted_at` | soft delete. **Every read must filter on this, including the "N saved" count** |
| `search` | the keyword index. Postgres recomputes it automatically on every write |
| `embedding` | the meaning index, 384 numbers. Computed once, at capture only |

Searching runs both indexes: keyword matches first, then meaning-matches appended below them, with
duplicates removed. The meaning index is what finds a beef stew PDF from "what should I cook
tonight".

**Editing a title or summary refreshes the keyword index but not the meaning index.** Postgres
maintains `search` itself; `embedding` is only ever written by the function at capture. In practice
this matters little, and the fix — re-embedding on save — is one call if it ever grates.

## What the browse page may and may not do

The row rules on `items` allow the signed-in owner to **read** and to **update**. There is
deliberately **no insert rule and no delete rule.**

- New items therefore only ever come from the function. The page cannot invent a row.
- Deleting is an update that sets `deleted_at`, which is why undo is possible.
- Editing a title, a summary or a note body is an update, straight from the page.

The storage bucket is **public to read**. Anyone with the exact file address can view an image; the
addresses are random and unguessable, and nothing links to them. Uploads are restricted to the owner.

## Editing by hand

Hold a title or a summary for about half a second, in the grid or on an item's own page, and it
becomes editable. Enter or tapping away saves that one column. A finger drag of more than ten pixels
cancels, so scrolling still scrolls. An emptied title reverts rather than saving.

Cards display only the first 220 characters of a summary, so a press swaps in the full text before
you edit it. Without that you would save the truncated stub over the real summary.

Notes' bodies and saved quotations are **not** edited this way — they are rich text and belong in the
editor at the bottom of the item's page.

The title is plain text, not a link, precisely so it can be edited. A page's source link lives on the
small line beneath it, as `↗ domain`. This is not a style choice that can be reversed casually: a
long press on a link raises Safari's own menu, which cannot be added to.

## Tags

At capture, Claude is shown every tag already in the library with a count of how many items use each,
and told to reuse one where it genuinely fits and to coin a new one where it does not. This is what
stops it inventing a synonym for a tag it already has.

Separately, `{ "harmonise": true }` posted to the function tidies the whole vocabulary. It does two
different things, kept deliberately apart:

- **Merges** — only where two tags are the same word differently spelt (`recipe`/`recipes`). Merging
  loses information, so it is confined to genuine duplicates.
- **Parents** — broad umbrella tags *added alongside* the specific ones, never replacing them. This
  is how the library gets broader without getting vaguer.

**Never merge a specific tag into a general one.** `world cup` is not `sports`. `brooks brothers` is
not `menswear`. That distinction is the entire value of the tag. The prompt says so, the code drops
any merge whose target is also proposed as an umbrella, and you should still read the plan before
applying it:

- `{ "harmonise": true, "dry": true }` returns the proposed plan and changes nothing.
- `{ "harmonise": true, "plan": <edited plan> }` applies exactly the plan you pass back.

Both times this has been run, the first plan contained a merge that had to be struck out by hand.
Always dry-run it.

## Traps

- **The page is cached for ten minutes.** GitHub Pages sends `max-age=600`. After a deploy, the
  Home Screen app keeps serving the old copy until it is force-quit from the app switcher. A change
  that "isn't live" is almost always this. Check the server first: `curl -s <url> | grep <something new>`.
- **The function's source lives only in this repo.** The deployed copy comes back as a 15MB
  transpiled bundle, not readable source. If it is ever lost again, the Supabase MCP tool
  `get_edge_function` returns the real files.
- **Two GitHub tokens exist and they are not interchangeable.** `GITHUB_TOKEN` in
  `HHDeliverySummary/.env` reaches the hiddenhelp org only. This repo needs
  `RICHARDMPRESTONGITHUB_TOKEN`, in the same file. Classic tokens expire, and GitHub revokes any
  that appear in a public repo.
- **This repo is public.** Nothing in it may contain a key or a secret. The Supabase key in
  `index.html` is the publishable one, which is meant to be public and is useless without a signed-in
  session because of the row rules.
- **A homepage rarely has a headline picture worth having.** Section fronts and homepages often
  publish a site logo or nothing at all. Article pages give the real photograph. This is what those
  pages publish; there is nothing to fix.

## Testing

There is no test framework and there should not be one. The pattern that has worked:

- For anything with real logic, pull the actual function out of the file with a regular expression,
  drop it into a small HTML harness with stubs, and drive it with real pointer events under headless
  Chrome (`--headless --dump-dom`). The press-to-edit behaviour has ten assertions written this way,
  covering the short press, the drag, the save, the empty-title revert and the truncated summary.
  Testing a copy proves nothing — extract the real code.
- Before redeploying the function from a copy you did not write yourself, check every prompt and
  comment in your copy appears verbatim in the deployed bundle.
- Claude has no signed-in session in the browser, so anything requiring a live login has to be
  verified by Richard.

## Where it stands

41 items live, 25 soft-deleted. Every live item has a meaning vector. 27 links predate headline
pictures and could be backfilled by re-fetching their `og:image` — offered, not yet done.

Deliberately not built: re-running Claude on every edit (tags would shift under you and each save
would cost a call), a native app, and any second way to save things. One capture path is worth more
than a complete set of metadata.
