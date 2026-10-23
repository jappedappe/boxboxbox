# Storrrage – notes for Claude Code

Storrrage is a phone-first web app (PWA) for keeping track of what's stored where: storage places (basement, attic, garage…) → boxes (also boxes inside boxes) → items, plus items that aren't in a box. It is hosted on GitHub Pages at https://jappedappe.github.io/boxboxbox/ and installed on an Android phone (Samsung, Chrome). The owner speaks Swedish; the app is in Swedish and English.

## Files today

- `index.html` – the whole app in one file: CSS in `<style>`, then two inlined libraries (qrcode-generator 1.4.4, jsQR 1.4.0), then the app script in the last `<script>`.
- `sw.js` – offline cache. Bump `CACHE` when the file list changes.
- `manifest.json`, `icon-192.png`, `icon-512.png` – home-screen app.

## Code layout (split done 2026-10-20)

`index.html` is ~600 kB. Split it so later changes only touch small files:

- `src/template.html` (page shell with placeholders), `src/style.css`, `src/app.js`
- `vendor/qrcode.js`, `vendor/jsQR.js`
- `build.py` that inlines everything back into `index.html`

Keep committing the built `index.html` (GitHub Pages serves it). After the split, never edit `index.html` by hand: edit `src/`, run `python3 build.py`, run `node --check src/app.js`, commit both.

## Rules for every change

- Bump `APP_VERSION` in app.js (format `YYYY-MM-DD.N`); it shows at the bottom of the ☰ menu so the owner can see which version is live.
- All UI text goes through `tr('key')` with entries in both `STR.en` and `STR.sv`. Item names are never translated. Colours are stored as English words (`Black`, `Red`…) and shown translated.
- Never use `window.prompt` / `window.confirm` / `alert` (they can be blocked in an installed PWA). Use `askText()` / `askConfirm()` / `openSheet()`.
- Data lives only on the phone in IndexedDB `boxes-app` (stores: `boxes`, `photos`, `meta`, `notes`; meta also holds `trash`, `listSort`, `boxOrder`). Never rename the database or stores, and migrate old data when the model changes. Photos can be shared by several items: delete them only via `dropPhoto()` (it checks `refInUse`).
- Test at 360, 384 and 412 px wide, in light and dark mode. Nothing may be wider than the screen.
- Keep pull requests focused, with a short description in Swedish of what changed.

## Data model (short)

- Place (`meta.places`): `id, name, icon, zones[], door, far`.
- Box: `id, code` (B-001, numbered per place by default; setting `meta.numbering`), `name, autoName, placeId, parentId` (box inside a box), `location` (= zone), `stack, level, fav, out {since, until}, checkedAt, openedAt, updatedAt, items[], documents[]`. Box documents store `id, ref, name, type, itemId` (optional link to an item); their files use the existing `photos` store. Each place has one hidden box with `loose: true` for things not in a box.
- Item: `id, name, photos[], files[], tags[]` (tags = collections), `owner, status, loanTo, size, color, season, brand, model, serial, qty, value, storedOn, lastUsed, remindMonths, remindAt, icon, fav, out {since, until}, outLog[]`; loose items also have `zone, stack, level` on the map.

## Design principles (decided with the owner – keep them)

- A box always looks the same everywhere: square tile like an item, with a whole closed box (`boxArt()`) with the number on its label, name under it, count as a small badge. The box art is only used for boxes. The freshness dot only shows when a box hasn't been checked for ~5 months.
- An item always looks the same: tile with photo or icon, name under it. Default icon is the "items popping out of a box" SVG (`DEFAULT_ITEM_ICON`), never 📦. On the map, loose items are round markers with the same footprint as a box.
- Fixed top bar shows the current place (tap to switch). Back (‹ and the phone's back button) goes back to where you came from (`backStack` / `goBack()`); only when there is nothing to go back to does it go one step up (`parentView()`).
- Place views: Shelf (one tile size) · List (group header = box icon, name + contents, count, +; sort: own order / A–Ö / last changed / added / used; long-press to drag boxes or items; swipe right = take out/put back, left = delete; ☆ on the right = favourite) · Map (zones, stacks, drag and drop; door and far end are markers on any side, the map layout itself doesn't rotate).
- "Out" (Framme) keeps the item's or box's place; it's shown faded and dashed.
- Palette (lighter since 2026-10-20): purple #6A51C4 (dark mode #7A63D3), ink #43307F, lavender #A49CD6, bright purple #6200FF, orange #F97F26 for dots and highlights. Thin markings (1.5–2 px).
- Deleted items go to Borttaget (meta `trash`) for 30 days before photos are dropped; `refInUse` also checks the trash. Fonts Poppins and Montserrat.
- Simple voice commands work offline (rule-based); the AI assistant (Gemini free tier for testing, Claude paid) is optional and falls back to the rules.

## Privacy and security (requirements from the owner)

- The data must never become a map of who owns what and where. No street addresses; keep items, owners and places separable.
- Ads and affiliate suggestions must be matched on the phone; partners never receive inventory data. Ads are clearly labelled.

## Roadmap (not built yet)

Login and a shared database for the household (with the privacy rules above), selling via Blocket/Tradera/Vinted, affiliate placements, moving the AI to a paid option.
