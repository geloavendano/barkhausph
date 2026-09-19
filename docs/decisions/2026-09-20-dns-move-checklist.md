# DNS move checklist: dotPH → Cloudflare (barkhaus.ph)

Companion to `2026-09-20-hosting-and-previews.md`. The domain stays registered at dotPH; only the
"address book" (nameservers) moves. Everything below is public DNS data. No secrets.

## Before the move: the record inventory

Found by querying dotPH's nameservers on 2026-09-20. DNS can't be listed completely from outside, so
**also screenshot or export the full record list from the dotPH DNS panel** and add anything missing.

| # | Name | Type | Value (as at dotPH) | In Cloudflare | Proxy | ✓ |
|---|---|---|---|---|---|---|
| 1 | `barkhaus.ph` | A ×4 | 185.199.108–111.153 (GitHub Pages) | **Replaced** by the Pages custom domain (step 4) | — | |
| 2 | `www` | CNAME | geloavendano.github.io | **Replaced** by the Pages custom domain (step 4) | — | |
| 3 | `barkhaus.ph` | MX | 10 mail.barkhaus.ph | Copy exactly | DNS only | |
| 4 | `mail` | A | 192.250.235.76 | Copy exactly | **DNS only (grey cloud)** | |
| 5 | `webmail` | A | 192.250.235.76 | Copy exactly | **DNS only (grey cloud)** | |
| 6 | `barkhaus.ph` | TXT | `v=spf1 +mx +a +ip4: 192.250.235.76 +include:spf.mysecurecloudhost.com ~all` | Copy exactly (see note A) | — | |
| 7 | `barkhaus.ph` | TXT | `google-site-verification=bNpvzfrqRwu37VQnnMuWCCFgUelF8OzLBmVasxRWjCM` | Copy exactly | — | |
| 8 | `_dmarc` | TXT | `v=DMARC1; p=quarantine; rua=…; ruf=…; fo=1; adkim=r; aspf=r` | Copy exactly | — | |
| 9 | `default._domainkey` | TXT | `v=DKIM1; k=rsa; p=MIIBIjAN…` (mailbox signing key, long) | Copy exactly, **whole value** | — | |
| 10 | `resend._domainkey` | TXT | `p=MIGfMA0G…` (Resend signing key) | Copy exactly, **whole value** | — | |
| 11 | `send` | MX | 10 feedback-smtp.ap-northeast-1.amazonses.com | Copy exactly | DNS only | |
| 12 | `send` | TXT | `v=spf1 include:amazonses.com ~all` | Copy exactly | — | |

**Note A (SPF):** `+ip4: 192.250.235.76` has a space after the colon. Mail providers may treat that as
malformed. It's the current live value, so copy it unchanged during the move and fix it separately
afterwards (one change at a time). `+a` will authorize Cloudflare's addresses to send mail; tighten later.

## The move

1. [ ] Cloudflare → Add site → `barkhaus.ph` → Free plan. Let it scan existing records.
2. [ ] Compare Cloudflare's imported list against the table above, row by row. Add missing rows,
       set rows 3–5 and 11 to **DNS only**, and compare the long DKIM values (rows 9–10) end to end.
3. [ ] Confirm the Pages project already works on its `*.pages.dev` link.
4. [ ] In Pages → Custom domains, add `barkhaus.ph` and `www.barkhaus.ph` (this creates rows 1–2).
5. [ ] **Late weekday night:** dotPH panel → nameservers → replace `dns1/dns2.domains.ph` with the two
       Cloudflare nameservers. Leave dotPH's old records in place (they're the undo button).
6. [ ] Wait for Cloudflare to show the site as **Active** (minutes to hours).

## After the move: checks

- [ ] https://barkhaus.ph and https://www.barkhaus.ph load, padlock OK, booking page loads
- [ ] Send an email **to** hello@barkhaus.ph from Gmail → arrives
- [ ] Send an email **from** the mailbox to Gmail → Gmail "Show original" says SPF **PASS**, DKIM **PASS**, DMARC **PASS**
- [ ] Trigger one real Resend email (e.g. an admin-created booking sent to your own address) → "Show original": DKIM PASS for barkhaus.ph
- [ ] Google Search Console still shows the property as verified
- [ ] Recheck the same the next morning (some networks update later)

## Undo

dotPH panel → put `dns1.domains.ph` / `dns2.domains.ph` back. Everything returns to the old records
within hours. Keep the dotPH records untouched for at least two weeks after the move.
