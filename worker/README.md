# The Dinner Table recipe importer

This Cloudflare Worker fetches public recipe pages server-side, reads Schema.org Recipe JSON-LD when available, and falls back to Jina Reader for pages without structured recipe data. The free Workers plan currently includes up to 100,000 requests/day; requests beyond that limit fail until reset.

## Deploy from the Cloudflare dashboard

1. Create a Cloudflare account and open **Workers & Pages → Create → Worker**.
2. Choose **Deploy Worker**, then edit the code and paste the contents of `src/index.js`.
3. In **Settings → Variables and Secrets**, add a variable named `ALLOWED_ORIGINS` with the exact published app origin, for example `https://your-name.github.io`. Do not leave `*` for a public deployment.
4. Deploy and copy the Worker URL.
5. In The Dinner Table, open **Settings → Recipe imports** and paste the Worker URL.

The app calls the Worker with the recipe URL. The Worker fetches only public HTTP/HTTPS pages, follows a limited number of redirects, and caps webpage size and fetch time. Pages behind sign-in or publisher anti-bot controls may still not import.

The URL is sent to the Worker and, when needed, to Jina Reader as a fallback.
