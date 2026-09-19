# Decision: hosting, previews and a private repo for barkhaus.ph

Status: **Approved: option B (Cloudflare)** by Gelo · 2026-09-20. Open: questions 2 and 3 in section 7.
DNS runbook: `2026-09-20-dns-move-checklist.md`.

## 1. The request

Host production and previews **in one place**, give every branch a preview link that talks to the
**staging** database, and make the GitHub repo **private**. This is the foundation for the payment/email
simulation (separate decision) and for the scheduled Linear routine that opens draft pull requests.

**Out of scope:** rebuilding the site (the Next.js prototype was an experiment; the static site stays),
moving the Supabase edge functions, changing email hosting, the payment simulation itself.

Inputs: Barkhaus is a business, so Vercel's free plan is not allowed (non-commercial only). The site changes
rarely (3 live deploys in 30 days). Quietest switch time: late weekday nights. GitHub Pages cannot serve a
private repo on GitHub's free plan, so **making the repo private and staying on Pages are incompatible**
without paying GitHub, and Pages has no previews anyway.

## 2. Recommended architecture

**Option B: Cloudflare Pages for production and previews; Cloudflare becomes the DNS host.**
The domain stays registered (and renewed) at dotPH.

```
git branch (private repo) ──► Cloudflare Pages
   main          → barkhaus.ph                     (production → production Supabase)
   any branch    → <branch>.barkhaus.pages.dev     (preview    → staging Supabase)

build step writes env.js from Cloudflare's settings (Production vs Preview)
browser double-checks by hostname: barkhaus.ph / www.barkhaus.ph → production; anything else → staging

DNS: dotPH nameservers → Cloudflare. Website records point to Pages; email records copied unchanged.
```

| Choice | Why |
|---|---|
| Cloudflare Pages | Free, commercial use allowed, private repos, preview per branch, separate Production/Preview settings, no traffic limit |
| Cloudflare as DNS host | Required for barkhaus.ph (not only www) on Pages. Free. The domain stays at dotPH. |
| One `env.js` replaces the hard-coded Supabase address | Today `booking.js` and `index.js` point at production, so every copy of the site uses real data |
| Environment decided by hostname as well as settings | Production is always barkhaus.ph, so a wrong setting can't make production behave like staging |

## 3. Alternatives considered

| Option | Cost | One place? | Private repo? | Why not |
|---|---|---|---|---|
| **A. Vercel Pro** | $20/month ($240/yr) | Yes | Yes | Strong option: **DNS stays at dotPH** (only 2 records change, email untouched) and paid support. Rejected on cost for a site that deploys a few times a month. **Pick this instead if avoiding the DNS move matters more than $240/yr.** |
| C. Netlify free | Free | Yes | Yes | Site **goes offline** when monthly credits run out |
| D. GitHub Pages + Cloudflare previews | Free | No | No (Pages needs a public repo on the free plan) | Fails both new requirements |
| GitHub Pro + Pages | $4/month | No previews | Yes | Doesn't give previews |

## 4. Long-term risks

- **DNS move (one-time)**: email records must be copied exactly. Mitigation: record-by-record checklist,
  mail records set to "DNS only", switch on a late weekday night, reversible by restoring dotPH nameservers.
- **Free-plan terms can change** / no support on free. Mitigation: the site is plain files, so leaving takes
  hours (see section 5). Trigger to revisit: any Cloudflare pricing change affecting Pages.
- **Cloudflare is steering new projects to Workers.** Pages has no end date; a later move is small for a static site.
- **One account now controls website + DNS.** Mitigation: two-factor login from day one, and no shared passwords.
- **GitHub Actions minutes**: private repos get 2,000 free minutes/month, and usage is **blocked** when they
  run out (public repos are unlimited). `payment-health` is scheduled every 20 minutes, up to ~2,160
  runs/month. Mitigation: move that check to Supabase's scheduler or Cloudflare, or run it less often,
  **before** going private. Otherwise the payment alarm could stop silently.
- **Staging address changes on every `staging.sh up`**: the script updates Cloudflare's preview settings.
  If that fails, previews show errors (never production data: `env.js` never falls back to production).

## 5. Cost of leaving Cloudflare later

| Item | Effort |
|---|---|
| Site files | None: plain HTML, works on any host |
| `_headers` / `_redirects` rules | Rewrite in the new host's format (~1 hour) |
| Build step that writes `env.js` | Re-create the settings on the new host (~1 hour) |
| `staging.sh` → Cloudflare API update | Swap for the new host's API (~1–2 hours) |
| DNS | Move records again (the same email-care checklist), or keep Cloudflare as DNS only and just repoint the website |
| Preview logins (if Cloudflare Access is used) | Re-create on the new host |

Roughly **one afternoon plus one careful DNS evening**. No data lives on Cloudflare; bookings stay in Supabase.

## 6. Lessons applied

- **Hard-coded production addresses** (found in this review): one source of truth for environment settings,
  the same lesson as Barkhaus's pricing drifting across three copies.
- **Decide environment by identity, not only by a flag**: also used in the payment simulation.
- **Going private doesn't un-publish history**: anything ever committed while public may already be copied.
  A secrets scan of all repos (2026-09) found none committed, so nothing needs rotating because of this.
- **Order matters**: move hosting first, make the repo private last; otherwise barkhaus.ph goes down.

## 7. Open questions for Gelo

1. ~~Cloudflare or Vercel Pro?~~ **Decided: Cloudflare (B).**
2. Should previews require a login (Cloudflare Access, free up to 50 users)?
3. `docs/` is served publicly today. Keep publishing it, or stop once the repo is private?

## 8. Migration order (each step reversible)

1. [x] Claude: `env.js` replaces every hard-coded address (public site, `/staging/` pages, admin); allowlist
       build to `dist/`; `_headers`; `404.html`; `payment-health` backup canary hourly (branch `hosting/env-config`)
2. [x] Gelo: Cloudflare account (two-factor on), Pages project `barkhausph` connected; previews verified on staging
3. [x] Claude: `staging.sh up`/`previews` updates Cloudflare's Preview variables automatically
4. [ ] Gelo: merge `hosting/env-config` to `main` → test the production build at `barkhausph.pages.dev`
5. [ ] Gelo + Claude: add barkhaus.ph to Cloudflare DNS; compare every imported record (DNS checklist)
6. [ ] Gelo, late weekday night: switch dotPH nameservers to Cloudflare; check website, email in/out, Search Console
7. [ ] After 48 quiet hours: turn off GitHub Pages, then make the repo private
