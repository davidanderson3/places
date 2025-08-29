# Places Scalability Plan

Goal: Evolve the “Places” app from a personal tool to a multi‑tenant product that reliably serves hundreds to thousands of users, while keeping the interface simple and responsive.

## 1) Objectives
- Simple UX for tracking interesting places (add, search, filter, map view).
- Low latency interactions and resilient performance globally.
- Per‑user data isolation and strong security.
- Operational excellence: safe deploys, monitoring, and cost awareness.

## 2) Current State Summary
- Frontend: Vanilla HTML/CSS/JS (Leaflet for map), Service Worker for caching.
- Data: User places stored directly from client in Firestore under `users/{uid}/travel` with localStorage fallback when not signed in.
- Auth: Firebase Auth in use (siteName logic present; auth hooks in `travel.js`).
- Backend: Node/Express server for misc APIs (email, recipes proxy, etc.).
- Geocoding/Search: Client calls OpenStreetMap Nominatim (no key) for search; debounced typeahead added.

Risks:
- Nominatim’s usage policy forbids heavy/production traffic without self‑hosting or paid provider.
- SW caching can serve stale assets if not versioned/hashed (recently improved to network‑first for HTML/JS/CSS).
- Firestore rules must strictly enforce per‑user security and quotas; large lists need indexes/pagination.

## 3) Target Requirements
- Support 10k+ MAU; p95 UI actions < 200ms for cached data, < 600ms for cold fetches.
- 99.9% availability for core features.
- Cost within modest monthly budget; scalable up/down.
- GDPR/CCPA‑ready: export/delete account data; minimal PII.

## 4) Architecture Direction

Frontend
- Host static assets on a global CDN (Vercel/Netlify/Cloudflare Pages).
- Adopt content hashing for JS/CSS filenames and a safe SW strategy (Workbox: network‑first for HTML, stale‑while‑revalidate for versioned assets). Consider removing offline if not a core requirement.

Data + Auth
- Keep Firebase Auth for simplicity (email/password, OAuth).
- Keep Firestore for per‑user places if data remains user‑scoped and modest in write volume; otherwise consider Postgres (Supabase/Neon) with row‑level security when you need complex queries, joins, or bulk ops.
- Binary assets (photos) go to Cloud Storage (GCS/S3) with signed URLs.

Backend/API
- Option A (serverless first): Move ad‑hoc endpoints to serverless (Cloud Functions, Vercel Functions). Add a lightweight API for any server‑mediated calls (e.g., geocode proxy, email).
- Option B (container): Keep Express, containerize, and deploy to Fly.io/Render; add a CDN in front.
- Rate limit all public endpoints (per‑IP and per‑user) and require API keys where applicable.

Search/Geocoding & Maps
- Replace direct Nominatim calls with one of:
  - Paid: Mapbox Places, Google Places, or MapTiler Geocoding (API keys, quotas, SLA).
  - Self‑host: Nominatim/Photon/Pelias with managed hosting or your own infra, plus HTTP cache (e.g., Cloudflare cache or Redis) and backoff.
- Add a server‑side geocoding proxy with caching (Redis/Upstash) and aggressive debounce on the client.
- Use a tile provider with a proper plan (Mapbox/MapTiler/Stadia). Configure attribution, rate limits, and map style.

Security & Privacy
- Tighten Firestore rules (see Section 8) to only allow `users/{uid}/travel` access to the signed‑in user; validate shape/limits.
- Input validation and output encoding on any server endpoints. CSRF not relevant for pure API+token flows; still set CORS precisely.
- Minimal PII; implement account data export/delete endpoints.

Observability
- Client: basic RUM (Core Web Vitals), JS error reporting (Sentry), feature flags.
- Server: structured logs, metrics (latency, rate, error), alerting.

DevEx & Ops
- Environments: dev, staging, prod with separate projects/DBs.
- CI/CD with lint, unit tests, and Playwright e2e smoke tests.
- Blue/green or canary deployments for backend and feature flags for risky UI changes.

## 5) Data Model (initial)
Firestore (per user):
- `users/{uid}/travel/{placeId}`
  - name: string (<= 140)
  - description: string (<= 2k)
  - lat: number, lon: number
  - tags: array<string> (<= 20)
  - rating: number|string
  - date: string (ISO) or timestamp
  - visited: boolean
  - createdAt, updatedAt: timestamp (serverTimestamp)

Indexes:
- Composite: visited + name; name + updatedAt; optionally tags array‑contains + name for filtered sorting.

Pagination:
- Use `limit + startAfter` by `updatedAt` or `name` for large lists; virtualize long tables client‑side.

## 6) API Design (if mediating DB/3rd‑party)
- `POST /api/places` create place
- `GET /api/places` list (query: q, tags, visited, pageToken)
- `PATCH /api/places/:id` update
- `DELETE /api/places/:id` delete
- `GET /api/search?q=` geocode proxy with caching and provider key management

AuthN/Z: Bearer Firebase ID token; validate on server; map to `uid`.

Rate limiting: 60 req/min/IP and 600 req/hr/user (tune later).

## 7) Geocoding Strategy
- Provider: start with Mapbox Places (predictable pricing, good docs). Keep a fallback provider if rate‑limited.
- Server cache: key by normalized query; TTL 1–7 days; collapse duplicate concurrent requests.
- Client: debounce 250–400ms; prevent background prefetching without user input.

## 8) Firestore Security (example rules sketch)
```
match /databases/{database}/documents {
  match /users/{userId} {
    allow read: if request.auth != null && request.auth.uid == userId;
    allow write: if request.auth != null && request.auth.uid == userId;

    match /travel/{placeId} {
      allow create: if request.resource.data.keys().hasOnly(['name','description','lat','lon','tags','rating','date','visited','createdAt','updatedAt'])
                    && request.resource.data.name is string && request.resource.data.name.size() <= 140
                    && request.resource.data.tags.size() <= 20;
      allow read, update, delete: if request.auth.uid == userId;
    }
  }
}
```

## 9) Performance Tuning
- Client: virtualize long tables; paginate by 100 items; memoize filtering/sorting; avoid re‑rendering markers unnecessarily.
- Map: cluster markers for dense areas; defer loading until panel visible; throttle map interactions.
- SW: serve HTML/JS/CSS from network‑first; use hashed assets; purge old caches on activate.

## 10) Rollout Plan (Phased)
Phase 0: Hygiene (1–2 days)
- Hash filenames for static assets; adopt Workbox or refine SW.
- Strengthen Firestore rules and add composite indexes.
- Add error reporting (Sentry) and analytics basic events.

Phase 1: Geocoding & Tiles (2–4 days)
- Introduce serverless `GET /api/search` proxy with Mapbox Places and Redis cache.
- Swap Leaflet tile layer to a provider with API key/usage plan.

Phase 2: Multi‑tenant Hardening (3–5 days)
- Add pagination/virtualization to places list.
- Add export/delete‑my‑data flows and privacy policy.
- Add rate limiting, audit logs, and 429 UX.

Phase 3: Ops & CI (2–3 days)
- Set up environments (dev/staging/prod), CI/CD, e2e smoke tests.
- Add uptime checks and on‑call alerts.

Phase 4: Cost & Scale (ongoing)
- Track provider usage; add quotas and backpressure.
- Periodically review indices and hot queries.

## 11) Cost Outline (rough)
- Mapbox (tiles + Places): free tier then ~$0.5–1 per 1k requests.
- Redis cache (Upstash): free to low tier sufficient for suggestions.
- Firebase: Auth free for common providers; Firestore pay‑as‑you‑go (reads/writes/storage); set limits/alerts.
- Hosting: Vercel/Netlify hobby → pro as needed; or Fly.io/Render small dyno.

## 12) Risks & Mitigations
- Geocoding rate limits: cache, debounce, show graceful degradation.
- SW staleness: versioned assets and network‑first for documents.
- Data growth: paginate; archive old entries; cap tags per place.
- Vendor lock‑in: abstract geocoding and storage behind thin adapters.

## 13) Success Metrics
- Time‑to‑first‑interaction < 2s on cold load (3G fast).
- p95 typeahead to suggestions < 400ms.
- Error rate < 1% for core flows.
- Support 10k MAU at <$200/month infra.

---

## Step‑By‑Step Implementation Guide

The steps below are ordered for minimal risk and maximum impact. Items marked (done) are already applied locally in this repo.

1) Stabilize client caching (done)
- What: Ensure new code is served on refresh; reduce flip‑flopping between old/new assets.
- Changes made:
  - service-worker.js switched to network‑first for HTML/JS/CSS and bumped cache name.
  - Added cache‑busting query params to CSS/JS references in HTML files.
  - Added `js/travel.js` to SW install cache.
- Files: service-worker.js, index.html, settings.html, report.html.
- Verify: Load app, refresh; should not revert after soft refresh. If a flip occurs once, do a hard refresh to activate the new service worker.

2) Tighten Firestore security rules (done)
- What: Restrict fields and sizes for `users/{uid}/travel/*` docs.
- Changes made: Added `isValidPlace` rules to validate name/lat/lon/tags/Rating/Date/visited.
- File: firestore.rules
- Next: In Firebase console, publish the updated rules to your project.

3) Set up environments (dev/staging/prod)
- Create three Firebase projects and matching Firestore DBs.
- Create three hosting/CDN targets (e.g., Vercel projects or Netlify sites) and point them at your repo branches.
- Store environment‑specific config (API keys, project IDs) in env vars or `serviceAccountKey.json` on the server.

4) Production map tiles and geocoding
- Choose providers:
  - Tiles: Mapbox/MapTiler/Stadia. Create an API key.
  - Geocoding: Mapbox Places or Google Places; obtain key.
- Implement server proxy for geocoding:
  - Add `GET /api/search?q=` endpoint on backend or serverless function.
  - Cache responses in Redis (Upstash) with a 1–7 day TTL.
  - Enforce rate limiting per IP and user.
- Client updates:
  - Replace Nominatim URLs with your `/api/search` endpoint in `js/travel.js`.
  - Replace `L.tileLayer('https://{s}.tile.openstreetmap.org/...')` with your provider URL and key.

5) Pagination and virtualization
- Add server‑side pagination to Firestore queries (limit + startAfter by `updatedAt` or `name`).
- Client: render max ~100 rows at once; add pager controls (present), or implement table virtualization.
- Add composite indexes in Firestore for your planned filters (visited + name, name + updatedAt, tags array‑contains + name as needed).

6) Observability
- Add Sentry (browser SDK) for JS errors and performance traces.
- Add uptime checks for your API endpoints (Healthchecks, UptimeRobot, or provider‑native monitors).
- Add minimal metrics on backend (latency, rate, errors).

7) Privacy and data control
- Add endpoints/UI to export and delete a user’s places.
- Update privacy policy and TOS.

8) CI/CD and deployment
- Create a GitHub Actions workflow: lint, unit tests, Playwright smoke test, deploy to staging on merge to `main`, to prod on tagged release.
- Adopt feature flags for risky UI changes.

9) Cost controls and quotas
- Configure provider alerts (Mapbox/Google), Firestore budget alerts, Redis limits.
- Add adaptive throttling and disable non‑essential features under high load.

## Local Changes Applied Now
- Service worker: network‑first strategy for HTML/JS/CSS and cache name bump.
- Cache‑busting query params added to CSS/JS in HTML files.
- Firestore rules tightened for Places docs validation.

## Next Actions (owner’s checklist)
- [ ] Publish updated Firestore rules from `firestore.rules` to the Firebase project.
- [ ] Decide on tile and geocoding providers; create API keys.
- [ ] Implement `/api/search` server proxy with caching and rate limiting.
- [ ] Swap client to use new providers and proxy.
- [ ] Add pagination or virtualization to the places list for very large datasets.
- [ ] Set up environments and CI/CD.

Appendix A: Implementation Checklist
- [ ] Replace Nominatim with provider + server cache
- [ ] Leaflet tile provider + API key
- [ ] Firestore rules tightened + indexes
- [ ] Paginate/virtualize places table
- [ ] SW: hashed assets + Workbox or tuned strategy
- [ ] Rate limiting + CORS on backend
- [ ] Sentry + uptime + metrics
- [ ] CI/CD + e2e smoke tests
- [ ] Data export/delete endpoints
