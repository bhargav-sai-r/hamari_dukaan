// =====================================================================
// SUPABASE CONFIG — this is the ONLY file you need to edit to connect
// the app to your own database. Paste your project's values here
// (Supabase dashboard → Settings → API), then save.
//
// Leaving these as the placeholder text below runs the app in DEMO
// MODE: everything works, but data only lives in this browser tab/
// device and disappears if you clear your browser data.
// =====================================================================
window.HD_CONFIG = (function () {
  "use strict";

  var SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL_HERE";
  var SUPABASE_ANON_KEY = "PASTE_YOUR_SUPABASE_ANON_KEY_HERE";

  // Treat anything that isn't a real-looking "https://...supabase.co"-style
  // URL as "not configured yet" and fall back to demo mode, rather than
  // trying to connect and crashing the whole app. This covers the
  // untouched placeholder text AND any other typo/half-finished paste
  // (a stray word, a URL missing "https://", an empty string, etc.) —
  // so a mistake here degrades to "you're in demo mode" instead of a
  // blank white screen with no explanation.
  var looksLikeRealUrl = /^https?:\/\/.+\..+/.test(SUPABASE_URL);
  var DEMO_MODE = !looksLikeRealUrl || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.indexOf('PASTE_YOUR') === 0 || !window.supabase;
  var sb = null;
  if (!DEMO_MODE) {
    try {
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) {
      // A malformed URL/key got past the check above (or Supabase's own
      // client rejected it for some other reason) — fall back to demo
      // mode instead of leaving the whole app unable to load.
      console.error('Hamari Dukaan: could not connect to Supabase with the values in assets/config.js — falling back to demo mode. ' +
        'Double-check SUPABASE_URL and SUPABASE_ANON_KEY against Supabase → Settings → API. Original error:', e);
      DEMO_MODE = true;
      sb = null;
    }
  }

  return { DEMO_MODE: DEMO_MODE, sb: sb };
})();
