# The Dinner Table

A recipe organizer and meal planner for collecting recipes, planning meals, shopping, and sharing selected recipes and availability with friends.

## Project files

- `index.html` — page structure and dialogs
- `styles.css` — layout and visual styles
- `app.js` — recipe, planning, shopping, and import behavior
- `firebase-config.js` — public Firebase Web App configuration
- `firebase-bridge.js` — Firebase Authentication, account sync, groups, and sharing
- `firestore.rules` — access rules for private account data and group sharing
- `worker/` — optional Cloudflare Worker for recipe page imports

## Features

- Recipe box with categories, recipe details, and original links
- Import recipes from public recipe pages, PDFs, and photos
- PDF/photo text reading happens in the browser; the selected file itself is not uploaded
- Review and edit extracted recipe details before saving
- Save TikTok and Instagram links as recipe records, then add details manually
- Share recipe snapshots with selected private groups and save friends’ shared recipes to your own box
- Seven-day meal planning and a shopping list built from planned recipes
- Firebase email/password and Google sign-in
- Recipes, meal plans, shopping lists, and settings sync to the signed-in account across devices
- Private friend groups with group-specific dinner availability
- Party menus shared with selected groups

PDF imports use PDF.js to extract text or render pages for OCR when the PDF is scanned. Photo and scanned-page OCR use Tesseract.js. Both are loaded on demand from a CDN; they read files in the browser and require an internet connection at import time. Recipe extraction is a best effort, so check the review form before saving.

## Firebase setup

The app is registered in Firebase project `thedinnertable-cd2aa`. The public Web App configuration is in `firebase-config.js`; never add a service-account key to this repository.

1. In **Authentication → Sign-in method**, enable **Email/Password** and **Google**.
2. In **Authentication → Settings → Authorized domains**, add the GitHub Pages domain used by the app.
3. Create the **Standard** Cloud Firestore database in the chosen region.
4. In Firestore, open **Rules**, replace the rules with the contents of `firestore.rules`, and publish them.
5. Upload the updated app files to GitHub Pages: `index.html`, `app.js`, `styles.css`, `firebase-config.js`, and `firebase-bridge.js`.

The Firestore rules must be published for group recipes to be visible to selected group members. Keep `firestore.rules` in the repository as your reference copy.

## Recipe link imports

Direct recipe-page reading can be blocked by some sites. For those, deploy the Cloudflare Worker in `worker/` and save its URL in **Settings → Recipe import service**. TikTok and Instagram links can be saved even when ingredients and steps cannot be extracted. The app currently saves the link and recipe details; it does not download or store video files.
