# The Dinner Table

A simple, local-first recipe organizer and weekly meal planner. Save recipes from around the web, put meals on the calendar, and collect ingredients into a checkable shopping list.

## Run locally

Open `index.html` in a modern browser. There is no build step or dependency installation. Your recipes, plans, and shopping list are saved in that browser's local storage.

## Project files

- `index.html` — page structure and app entry point
- `styles.css` — layout and visual styles
- `app.js` — recipe, planning, and shopping-list behavior
- `README.md` — project overview and setup
- `.gitignore` — common local/editor files excluded from Git

## Current features

- Recipe box with source, ingredients, notes, and search
- Recipe categories with filtering, plus a detail view with saved ingredients and original recipe links
- Recipe link importer that reads structured page data directly and falls back to Jina Reader when needed
- Seven-day meal plan with breakfast, lunch, and dinner slots
- Shopping list assembled from recipes planned for the displayed week
- Manually added shopping items and checkboxes
- Party menus with host controls and a guest contribution preview
- Party dates shown on the weekly calendar, reserving that day from regular meals
- Local collaboration profile with a friend-code preview and weekday dinner availability
- Browser-local persistence

Party menus, friend codes, and availability currently run as a local prototype: data stays in the current browser. Firebase still needs to be connected before accounts, verified friend connections, shared availability, and live cross-device collaboration will work.

For recipe imports that are blocked by browser security, deploy the free Cloudflare Worker in `worker/`, then save its URL in **Settings → Recipe import service**. The Worker reads recipe structured data and falls back to Jina Reader. Both services receive the public recipe URL. Pages that require sign-in or do not expose clear ingredient and direction sections can still fail.

Firebase is not connected yet. To start on the free Spark plan, create a Firebase project, register a Web App, enable Email/Password Authentication and Firestore, then provide the public Web App config values (`apiKey`, `authDomain`, `projectId`, and `appId`). Cloud Functions are unavailable on Spark; the importer Worker is kept separate so it does not require enabling Firebase billing.

## Publish with GitHub Pages

1. Create a new repository on GitHub.
2. In this project folder, add the repository as `origin` and push the `main` branch:

   ```sh
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
   git add .
   git commit -m "Build the first Dinner Table app version"
   git push -u origin main
   ```

3. In the repository, open **Settings → Pages**. Select **Deploy from a branch**, choose `main` and `/ (root)`, then save.

The app is static, so GitHub Pages can serve it directly. Data stays in each visitor's browser and does not sync between devices.

## Ideas for next steps

- Import structured recipes from recipe pages
- Improve support for social links and recipes in captions/videos
- Edit saved recipes and ingredient quantities
- Export/import a backup or add account-based sync

