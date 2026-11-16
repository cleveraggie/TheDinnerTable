# The Dinner Table

A simple, local-first recipe organizer and weekly meal planner. Save recipes from around the web, put meals on the calendar, and collect ingredients into a checkable shopping list.

## Run locally

Serve the project over HTTP (for example, with GitHub Pages or a simple local static server) and open it in a modern browser. There is no build step or dependency installation. The Firebase bridge uses browser modules, so opening `index.html` directly as a `file://` URL will not load it correctly. Recipes, plans, and shopping lists are saved in that browser's local storage.

## Project files

- `index.html` — page structure and app entry point
- `styles.css` — layout and visual styles
- `app.js` — recipe, planning, and shopping-list behavior
- `firebase-config.js` — public Firebase Web App configuration
- `firebase-bridge.js` — Firebase Authentication and live collaboration
- `firestore.rules` — access rules for profiles, friend codes, friendships, and party menus
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
- Firebase email/password and Google accounts
- Friend codes, dinner availability, and connected-friend availability synced through Firestore
- Shared party menus that hosts can invite collaborators to by friend code
- Browser-local persistence

Recipes, weekly meal plans, and shopping lists remain local to each browser. Accounts, friend codes, availability, and shared party menus use Firebase Authentication and Cloud Firestore.

For recipe imports that are blocked by browser security, deploy the free Cloudflare Worker in `worker/`, then save its URL in **Settings → Recipe import service**. The Worker reads recipe structured data and falls back to Jina Reader. Both services receive the public recipe URL. Pages that require sign-in or do not expose clear ingredient and direction sections can still fail.

## Firebase setup (Spark)

The web app is registered as `The Dinner Table` in Firebase project `thedinnertable-cd2aa`. The public Web App config is in `firebase-config.js`; Firebase Web App config is intended to be included in client apps. Do not add a service-account key to this repository.

1. In **Authentication → Sign-in method**, enable **Email/Password** and **Google**. Phone sign-in is intentionally not used because SMS authentication requires billing and charges per message.
2. In **Authentication → Settings → Authorized domains**, add `cleveraggie.github.io` so the GitHub Pages app can sign users in.
3. Create the **Standard** Cloud Firestore database in `us-south1 (Dallas)` and choose production mode. Scheduled backups remain off on Spark.
4. In Firestore, open **Rules**, replace the rules with the contents of `firestore.rules`, and publish them. The database stays closed until these rules are published.
5. Upload the updated root files to GitHub Pages: `index.html`, `app.js`, `styles.css`, `firebase-config.js`, and `firebase-bridge.js`. Keep `firestore.rules` in the repository for reference and paste it into the Firebase Rules editor.

Spark includes no-cost Authentication providers such as email/password and Google, plus Firestore's free quota. Firestore currently includes 1 GiB stored data, 50,000 reads/day, and 20,000 writes/day; on Spark, a service pauses if its free quota is exceeded until the quota resets. The recipe importer remains a separate Cloudflare Worker, so this setup does not require enabling Firebase billing.

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

