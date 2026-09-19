/* ═══════════════════════════════════════════════════════════
   Barkhaus — env.js
   Which Supabase this copy of the site talks to. Loaded before every page script.
   - Production settings live here (the anon key is public by design).
   - Preview/staging settings come from env-staging.js, which scripts/write-env.sh
     writes on Cloudflare preview builds. Production builds leave it empty.
   Decision record: docs/decisions/2026-09-20-hosting-and-previews.md
   ═══════════════════════════════════════════════════════════ */
(function () {
  var PRODUCTION = {
    name: 'production',
    supabaseUrl: 'https://dxttnbtfhpanyiyduevn.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s'
  };
  var PRODUCTION_HOSTS = ['barkhaus.ph', 'www.barkhaus.ph'];

  // hostname: where this page is being served from (e.g. 'barkhaus.ph', 'my-branch.barkhaus.pages.dev', 'localhost')
  // staging:  window.BH_STAGING from env-staging.js ({ supabaseUrl, supabaseAnonKey }), or undefined
  // Must return { name, supabaseUrl, supabaseAnonKey }; page scripts read these three fields.
  function decideEnvironment(hostname, staging) {
    // The real site always uses production, even if staging settings were somehow shipped with it.
    if (PRODUCTION_HOSTS.indexOf(hostname) !== -1) return PRODUCTION;

    // Anywhere else (preview links, a local copy) uses staging, never production.
    if (staging && staging.supabaseUrl && staging.supabaseAnonKey) {
      return { name: 'staging', supabaseUrl: staging.supabaseUrl, supabaseAnonKey: staging.supabaseAnonKey };
    }

    // No staging settings: stop loudly instead of quietly using real customer data.
    throw new Error('Barkhaus: this copy of the site (' + hostname + ') has no staging settings. ' +
      'Run staging.sh up, or open the Cloudflare preview link.');
  }

  window.BH_ENV = decideEnvironment(window.location.hostname, window.BH_STAGING);
})();
