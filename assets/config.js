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

  var DEMO_MODE = (SUPABASE_URL.indexOf('PASTE_YOUR') === 0) || !window.supabase;
  var sb = DEMO_MODE ? null : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  return { DEMO_MODE: DEMO_MODE, sb: sb };
})();
