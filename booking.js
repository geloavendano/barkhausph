/* ═══════════════════════════════════════════════════════════
   Barkhaus — booking.js
   Booking flow: config, state, UI, collect, submit
   Depends on: pricing.js, validation.js
   ═══════════════════════════════════════════════════════════ */


// ── CONFIG ──
var SUPABASE_URL        = 'https://dxttnbtfhpanyiyduevn.supabase.co';
var CREATE_PAYMENT_URL  = SUPABASE_URL + '/functions/v1/create-payment';
var GET_UPLOAD_URL      = SUPABASE_URL + '/functions/v1/get-upload-url';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s';
var EDGE_FN_URL       = SUPABASE_URL + '/functions/v1/submit-booking';

// ── PRICING TABLES ──
// GROOM_PRICES, FACE_TRIM_PRICES, ADDONS, HOTEL_RATES, DAYCARE_RATES,
// DAYCARE_EXTRA_RATES, HOTEL_LATE_RATE, MEMBER_DISCOUNT, CONVENIENCE_FEE
// are declared and zeroed in pricing.js (loaded above). loadPricingData()
// populates them from Supabase at runtime.

var GROOM_SERVICES = [
  { key:'bath_dry',  name:'Bath and Dry',   duration:'30 minutes', desc:'Bath, Blow Dry and Brush Out' },
  { key:'basic',     name:'Basic Groom',     duration:'1 hour',     desc:'Shampoo, Blow Dry, Brush Out, Teeth Brushing, Sanitary Clean, Paw Pad Trim, Nail Trim and Filing, Ear Cleaning, Anal Gland Expression' },
  { key:'premium',   name:'Premium Groom',   duration:'2 hours',    desc:'Customized Haircut, Face Trim, Shampoo, Blow Dry, Brush Out, Teeth Brushing, Sanitary Clean, Paw Pad Trim, Nail Trim and Filing, Ear Cleaning, Anal Gland Expression' },
  { key:'ala_carte', name:'Ala Carte',       duration:'varies',     desc:'Choose individual services below' }
];
// Add-ons enabled per service (null = all enabled)
var ADDON_ENABLED = {
  bath_dry:  null,
  basic:     ['face_trim','antitick','whitening','demat','deshed'],
  premium:   ['face_trim','antitick','whitening','demat','deshed'],
  ala_carte: null
};
// Rate key is determined by the cage selected, not the pet's own size category
var CAGE_RATE_SIZE = {
  small_cage:   'small_dog',
  medium_cage:  'medium_dog',
  large_cage:   'large_dog',
  single_cabin: 'cat_single_cabin',
  villa:        'cat_villa'
};
var PET_SIZE_LABELS = {
  small_dog:'Small Dog', medium_dog:'Medium Dog', large_dog:'Large Dog',
  giant_dog:'Giant Dog', cat:'Cat'
};
// VALID_MEMBER_IDS removed — membership validated via Supabase
var IS_WALKIN = (new URLSearchParams(window.location.search)).get('walkin') === '1';
var WALKIN_TOKEN = (new URLSearchParams(window.location.search)).get('token') || '';
var _walkinGatePromise = null; // resolves to true (allowed) or false (blocked)

if (IS_WALKIN) {
  CONVENIENCE_FEE = 0;
  // Auth gate: validate one-time Supabase token — cannot be forged or replayed
  _walkinGatePromise = (async function() {
    if (!WALKIN_TOKEN) return false;
    try {
      var rows = await sbFetchPublic('walkin_tokens',
        'id=eq.' + encodeURIComponent(WALKIN_TOKEN) + '&select=id,created_at&limit=1');
      if (!rows || !rows.length) return false;
      var age = Date.now() - new Date(rows[0].created_at).getTime();
      if (age > 60 * 60 * 1000) return false; // expired (> 1 hour)
      // Consume the token immediately — DELETE so it cannot be reused
      await fetch(SUPABASE_URL + '/rest/v1/walkin_tokens?id=eq.' + encodeURIComponent(WALKIN_TOKEN), {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
      });
      return true;
    } catch(e) {
      console.warn('Walk-in token validation failed:', e);
      return false;
    }
  })();
}

// ── STATE ──
// Live data from DB (populated on init)
var liveRooms    = [];   // rooms[] from Supabase for current branch
var liveGroomers = [];   // groomers[] from Supabase for current branch
var liveGroomerBlocks = []; // groomer_blocks[] for current branch groomers
var liveStudios      = [];   // studios[] from Supabase for current branch
var liveStudioBlocks = [];   // studio_blocks[] for current branch studios

var booking = {
  location:null, service:null,
  // Grooming
  petSize:null, groomService:null, groomServicePrice:0, selectedAddons:{},
  groomDate:null, groomSlot:null, preferredStylist:null, preferredStylistId:null, groomNotes:'',
  // Hotel
  hotelCheckin:null, hotelCheckout:null, hotelRoomType:null, hotelRoomId:null, hotelRoomName:null,
  hotelBaseTotal:0, hotelLateTotal:0,
  hotelDropoffTime:'', hotelPickupTime:'', hotelPickupHour:14,
  hotelFeeding:'', hotelMeds:'', playparkConsent:null,
  vetClinic:'', vetContact:'', vetAddress:'',
  emergencyName:'', emergencyPhone:'',
  // Daycare
  daycareDate:null, daycareBaseRate:0, daycareTotal:0, daycareOpenTime:false,
  daycareDropoffHour:0, daycarePickupHour:0, daycareDropoffText:'', daycarePickupText:'',
  daycareNotes:'',
  // Studio
  studioDate:null, studioSlot:null,
  // Pet
  petName:null, petAnimal:null, petGender:null, petBreed:null,
  petAge:null, petAgeUnit:null, petMedical:null, petTemperament:null, vaccines:{},
  // Owner
  ownerFirst:'', ownerLast:'', ownerEmail:'', ownerPhone:'', ownerSource:'',
  // Membership
  isMember:null, membershipId:null, memberValid:false,
};
var currentStep = 1;
var saveDetails = false;
var uploadedVaccineFiles = [];
var secondCatVisible = false;

var SERVICE_CONFIG = {
  grooming: {
    step3: { sectionId:'groomSpecsSection',     title:'Grooming specs',      subtitle:'Choose your service and any add-ons.' },
    step4: { sectionId:'groomSchedSection',     title:'Pick a schedule',     subtitle:'Choose your preferred date and time.' },
    waiverSectionId: 'groomingWaivers',
    generalWaiverId: 'waiverGeneralGrooming',
  },
  hotel: {
    step3: { sectionId:'hotelDatesSection',     title:'Stay details',        subtitle:'When will your pet be staying with us?' },
    step4: { sectionId:'hotelDetailsSection',   title:'Room & care details', subtitle:'Help our team prepare for your pet.' },
    waiverSectionId: 'hotelWaivers',
    generalWaiverId: 'waiverGeneralHotel',
  },
  daycare: {
    step3: { sectionId:'daycareScheduleSection',title:'Daycare details',     subtitle:'Choose a date and time for your pet.' },
    step4: { sectionId:'daycareDetailsSection', title:'Service notes',       subtitle:'Help our staff give your pet the best day.' },
    waiverSectionId: 'daycareWaivers',
    generalWaiverId: 'waiverGeneralDaycare',
  },
  studio: {
    step3: { sectionId:'studioSlotSection',     title:'Pick a slot',         subtitle:'Choose your date and time at Barkhaus Studio.' },
    step4: null,
    waiverSectionId: 'studioWaiver',
    generalWaiverId: null,
  },
};

var FLOWS = {
  grooming: { steps:['Location','Service','Specs','Schedule','Pet','You','Waiver'] },
  hotel:    { steps:['Location','Service','Dates','Details','Pet','You','Waiver'] },
  daycare:  { steps:['Location','Service','Schedule','Details','Pet','You','Waiver'] },
  studio:   { steps:['Location','Service','Slot','Pet','You','Waiver'] },
  events:   { steps:[] }
};

// ── LOCAL DATE HELPER (avoids UTC-offset causing wrong day) ──
function localDateStr(d) {
  var dt = d || new Date();
  return dt.getFullYear() + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0');
}

// ── INIT ──
(async function init() {
  // Walk-in gate — must pass before any rendering
  if (IS_WALKIN && _walkinGatePromise) {
    var _walkinAllowed = await _walkinGatePromise;
    if (!_walkinAllowed) {
      document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;background:#1a1a1a;color:#fff;text-align:center;padding:24px">'
        + '<div style="font-size:48px;margin-bottom:16px">🔒</div>'
        + '<h2 style="margin:0 0 8px">Access Restricted</h2>'
        + '<p style="color:#aaa;margin:0 0 24px">Walk-in bookings must be started from the admin panel.</p>'
        + '<a href="index.html" style="background:#FFCE58;color:#1a1a1a;padding:10px 24px;border-radius:20px;text-decoration:none;font-weight:700">Go to Home</a>'
        + '</div>';
      return;
    }
  }
  var today = localDateStr();
  ['groomDate','hotelCheckin','hotelCheckout','daycareDate','studioDate'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.min = today;
  });
  try {
    var saved = localStorage.getItem('barkhaus_owner');
    if (saved) {
      var d = JSON.parse(saved);
      if (d.first) document.getElementById('ownerFirst').value = d.first;
      if (d.last)  document.getElementById('ownerLast').value  = d.last;
      if (d.email) document.getElementById('ownerEmail').value = d.email;
      if (d.phone) document.getElementById('ownerPhone').value = d.phone;
      saveDetails = true;
      document.getElementById('saveToggle').classList.add('on');
    }
  } catch(e) {}
  await loadPricing();
  buildPickupTimeOptions();
  renderProgress();
  if (IS_WALKIN) {
    var banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(107,203,119,0.15);border-bottom:0.5px solid rgba(107,203,119,0.3);padding:8px 16px;font-size:12px;color:#6BCB77;font-weight:600;text-align:center;';
    banner.textContent = '🚶 Walk-in booking — payment collected at counter';
    document.body.insertBefore(banner, document.body.firstChild);
  }
  // Warn before unload once the user has made meaningful progress
  window.addEventListener('beforeunload', function(e) {
    if (_redirectingToPayment) return; // intentional redirect — no warning
    var ss = document.getElementById('successScreen');
    if (ss && ss.classList.contains('active')) return; // booking already done
    if (currentStep > 1 || onSummaryScreen) {
      e.preventDefault();
      e.returnValue = ''; // required for Chrome
    }
  });
})();

async function loadPricing() {
  try {
    var rows = await sbFetchPublic('pricing', 'select=category,service_key,size_key,day_type,price');
    loadPricingData(rows);
    // Walk-in mode never charges a convenience fee regardless of DB value
    if (IS_WALKIN) CONVENIENCE_FEE = 0;
  } catch(e) {
    console.warn('Pricing fetch failed:', e);
    // Show a persistent banner — pricing failure is not a recoverable state without a refresh
    var bar = document.createElement('div');
    bar.id = 'pricingErrorBar';
    bar.style.cssText = 'position:sticky;top:0;z-index:999;background:#FF6B6B;color:#fff;font-family:"Nunito",sans-serif;font-size:13px;font-weight:700;text-align:center;padding:10px 16px;line-height:1.4';
    bar.innerHTML = '⚠️ Pricing unavailable — please <a href="" style="color:#fff;text-decoration:underline">refresh the page</a> before booking. If this persists, call us to book.';
    document.body.insertBefore(bar, document.body.firstChild);
  }
}

// ── PROGRESS ──
// Studio skips HTML step4 (Details), so HTML steps 5-7 map to logical steps 4-6.
// This helper converts the HTML panel index to a logical step number for the progress bar.
function htmlToLogicalStep(htmlStep) {
  if (booking.service === 'studio' && htmlStep >= 5) return htmlStep - 1;
  return htmlStep;
}
// For navigation: studio uses HTML panels 1,2,3,5,6,7 — last panel is 7, not 6.
function navMaxStep() {
  if (booking.service === 'studio') return 7;
  var flow = booking.service ? FLOWS[booking.service] : null;
  return flow ? flow.steps.length : 7;
}
function renderProgress() {
  var svc      = booking.service;
  var flow     = (svc && FLOWS[svc]) ? FLOWS[svc] : FLOWS.grooming;
  var steps    = flow.steps;
  var total    = steps.length;
  var logStep  = htmlToLogicalStep(currentStep);
  var pct      = total ? Math.round((logStep / total) * 100) : 14;
  document.getElementById('progressFill').style.width = pct + '%';
  var html = '';
  for (var i = 0; i < steps.length; i++) {
    var cls = i + 1 === logStep ? 'active' : (i + 1 < logStep ? 'done' : '');
    html += '<span class="progress-step ' + cls + '">' + steps[i] + '</span>';
  }
  document.getElementById('progressSteps').innerHTML = html;
}

var _redirectingToPayment = false; // set true before payment redirect to suppress beforeunload warning

// ── NAVIGATION ──
function nextStep() {
  if (!validateStep(currentStep)) return;
  collectStep(currentStep);
  var maxStep = navMaxStep();
  if (currentStep >= maxStep) {
    showSummary();
    return;
  }
  var next = currentStep + 1;
  if (next === 4 && booking.service === 'studio') next = 5;
  goToStep(next);
}
var onSummaryScreen = false;

function prevStep() {
  if (onSummaryScreen) {
    onSummaryScreen = false;
    document.getElementById('stepSummary').classList.remove('active');
    document.getElementById('progressWrap').style.display = '';
    currentStep = navMaxStep(); // last HTML panel (7 for studio, flow.steps.length for others)
    var el = document.getElementById('step' + currentStep);
    if (el) el.classList.add('active');
    renderProgress();
    updateBottomNav();
    window.scrollTo(0,0);
    return;
  }
  if (currentStep > 1) {
    var prev = currentStep - 1;
    if (prev === 4 && booking.service === 'studio') prev = 3;
    goToStep(prev);
  }
}
function goToStep(n) {
  var cur = document.getElementById('step' + currentStep);
  if (cur) cur.classList.remove('active');
  currentStep = n;
  var next = document.getElementById('step' + currentStep);
  if (next) next.classList.add('active');
  renderProgress();
  updateNavTotal();
  document.getElementById('btnBack').style.display = currentStep > 1 ? '' : 'none';
  var btnN = document.getElementById('btnNext');
  btnN.textContent = 'Continue'; btnN.className = 'btn-next';
  btnN.onclick = function() { nextStep(); };
  window.scrollTo(0,0);
  if (currentStep === 3) showStep3Panel();
  if (currentStep === 4) showStep4Panel();
  if (currentStep === 5) showPetPanel();
  if (currentStep === 6) showOwnerPanel();
  if (currentStep === 7) showWaiverPanel();
  // Validate after panel setup so restored values are counted
  refreshContinueBtn();
}
function showSummary() {
  var flow    = booking.service ? FLOWS[booking.service] : null;
  var maxStep = flow ? flow.steps.length : 7;
  var cur = document.getElementById('step' + maxStep);
  if (cur) cur.classList.remove('active');
  document.getElementById('progressWrap').style.display = 'none';
  onSummaryScreen = true;
  buildSummary();
  document.getElementById('stepSummary').classList.add('active');
  updateBottomNavForSummary();
  window.scrollTo(0,0);
}
function updateBottomNavForSummary() {
  var back = document.getElementById('btnBack');
  var next = document.getElementById('btnNext');
  back.style.display = '';
  next.textContent = 'Confirm Booking';
  next.className = 'btn-submit';
  next.disabled = false;
  next.onclick = function() { submitBooking(); };
}
function updateBottomNav() {
  var back = document.getElementById('btnBack');
  var next = document.getElementById('btnNext');
  back.style.display = currentStep > 1 ? '' : 'none';
  next.textContent = 'Continue';
  next.className = 'btn-next';
  next.onclick = function() { nextStep(); };
  updateNavTotal();
  refreshContinueBtn();
}
function silentValidateStep(step) {
  var svc = booking.service;
  var g = function(id) { var el=document.getElementById(id); return el ? el.value : ''; };
  if (step === 1) return !!booking.location;
  if (step === 2) return !!svc;
  if (step === 3) {
    if (svc === 'grooming') {
      if (!booking.petSize || !booking.groomService) return false;
      if (booking.groomService === 'ala_carte' && Object.keys(booking.selectedAddons).length === 0) return false;
    }
    if (svc === 'hotel') {
      if (!booking.petSize) return false;
      if (!g('hotelCheckin') || !g('hotelCheckout')) return false;
      if (!booking.hotelRoomType) return false;
    }
    if (svc === 'daycare') {
      if (!booking.petSize) return false;
      if (!g('daycareDate') || !g('daycareDropoff') || !g('daycarePickup')) return false;
    }
    if (svc === 'studio') {
      if (!g('studioDate') || !booking.studioSlot) return false;
    }
    return true;
  }
  if (step === 4) {
    if (svc === 'grooming') {
      if (!g('groomDate') || !booking.groomSlot) return false;
    }
    if (svc === 'hotel') {
      if (!g('hotelDropoffTime') || !g('hotelPickupTime')) return false;
    }
    return true;
  }
  if (step === 5) {
    if (!g('petName').trim() || !booking.petAnimal || !booking.petGender) return false;
    if (!g('petBreed').trim() || !g('petAgeNum').trim()) return false;
    if (!booking.petTemperament) return false;
    var _nf = !uploadedVaccineFiles || uploadedVaccineFiles.length === 0;
    var _bv = document.getElementById('bringVaccines');
    if (_nf && (!_bv || !_bv.classList.contains('checked'))) return false;
    var vw = document.getElementById('vaccineWaiver');
    if (!vw || !vw.classList.contains('checked')) return false;
    var sr = document.getElementById('seniorWaiverRow');
    if (sr && sr.style.display !== 'none') {
      var sa = document.getElementById('seniorWaiverAck');
      if (!sa || !sa.classList.contains('checked')) return false;
    }
    if (booking.isMember === true && !booking.memberValid) return false;
    return true;
  }
  if (step === 6) {
    var email = g('ownerEmail').trim();
    if (!g('ownerFirst').trim() || !g('ownerLast').trim()) return false;
    if (!email || !email.includes('@')) return false;
    if (!g('ownerPhone').trim()) return false;
    return true;
  }
  if (step === 7) {
    var cfg = SERVICE_CONFIG[svc];
    if (cfg && cfg.generalWaiverId) {
      var we = document.getElementById(cfg.generalWaiverId);
      if (!we || !we.classList.contains('checked')) return false;
    }
    var wv = document.getElementById('waiverVaccineDecl');
    if (!wv || !wv.classList.contains('checked')) return false;
    if (svc === 'studio') {
      var ws = document.getElementById('waiverStudio');
      if (!ws || !ws.classList.contains('checked')) return false;
    }
    var ageV = parseInt(g('petAgeNum')) || 0;
    var unitV = g('petAgeUnit') || 'months';
    var medV  = g('petMedical').trim();
    if ((ageV >= 6 && unitV === 'years') || medV.length > 0) {
      var sw = document.getElementById('seniorWaiver');
      if (!sw || !sw.classList.contains('checked')) return false;
    }
    return true;
  }
  return true;
}
function refreshContinueBtn() {
  var btn = document.getElementById('btnNext');
  if (!btn || onSummaryScreen) return;
  var valid = silentValidateStep(currentStep);
  if (valid) {
    btn.classList.remove('btn-incomplete');
  } else {
    btn.classList.add('btn-incomplete');
  }
}
function updateBottomNavForSummary() {
  document.getElementById('btnBack').style.display = '';
  var next = document.getElementById('btnNext');
  next.textContent = 'Confirm Booking';
  next.className = 'btn-submit';
  next.onclick = function() { submitBooking(); };
  var total = getRunningTotal();
  var navEl = document.getElementById('navTotal');
  if (total > 0) {
    document.getElementById('navTotalVal').textContent = '₱' + (total + CONVENIENCE_FEE).toLocaleString();
    navEl.style.display = 'flex';
  }
}
function updateNavTotal() {
  var total = getRunningTotal();
  var el = document.getElementById('navTotal');
  if (total > 0) {
    document.getElementById('navTotalVal').textContent = '\u20b1' + total.toLocaleString();
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}
function getRunningTotal() {
  var svc = booking.service;
  var raw = 0;
  if (svc === 'grooming') {
    raw = (booking.groomServicePrice || 0) +
      Object.keys(booking.selectedAddons).reduce(function(a,k) {
        return a + (ADDONS.find(function(x){return x.key===k;}) ? booking.selectedAddons[k] : 0);
      }, 0);
  } else if (svc === 'hotel') {
    raw = (booking.hotelBaseTotal || 0) + (booking.hotelLateTotal || 0);
  } else if (svc === 'daycare') {
    raw = booking.daycareTotal || 0;
  }
  if (raw > 0 && booking.memberValid) {
    raw = Math.round(raw * (1 - (MEMBER_DISCOUNT[svc] || 0)));
  }
  return raw;
}

// ── LOCATION ──
function selectLocation(el, val) {
  document.querySelectorAll('#step1 .option-card').forEach(function(c) { c.classList.remove('selected'); });
  el.classList.add('selected');
  booking.location = val;
  // Reset live data for new branch
  liveRooms = []; liveGroomers = []; liveGroomerBlocks = []; liveStudios = []; liveStudioBlocks = [];
  window._branchIds = null;
  loadLiveRoomsAndGroomers();
  if (booking.service === 'studio') { booking.service = null; document.querySelectorAll('#serviceGrid .option-card').forEach(function(c){c.classList.remove('selected');}); }
  // Cat availability for hotel / daycare
  var hotelCat = document.getElementById('hotelCatBtn');
  var daycareCat = document.getElementById('daycareCatBtn');
  var studioCard  = document.getElementById('studioCard');
  var studioBadge = document.getElementById('studioBadge');
  if (val === 'estancia') {
    if (hotelCat)   { hotelCat.classList.add('disabled-opt');    document.getElementById('hotelCatNote').textContent   = 'Eastwood only'; }
    if (daycareCat) { daycareCat.classList.add('disabled-opt');  document.getElementById('daycareCatNote').textContent = 'Eastwood only'; }
    if (studioCard) { studioCard.classList.add('disabled');    if (studioBadge) studioBadge.textContent = 'Eastwood only'; }
  } else {
    if (hotelCat)   { hotelCat.classList.remove('disabled-opt'); document.getElementById('hotelCatNote').textContent   = 'any size'; }
    if (daycareCat) { daycareCat.classList.remove('disabled-opt'); document.getElementById('daycareCatNote').textContent = '\u20b1500 base'; }
    if (studioCard) { studioCard.classList.remove('disabled'); if (studioBadge) studioBadge.textContent = 'Contact to book'; }
  }
  nextStep();
}

// ── SERVICE ──
function selectService(el, val) {
  if (el.classList.contains('disabled')) return;
  document.querySelectorAll('#serviceGrid .option-card').forEach(function(c) { c.classList.remove('selected'); });
  el.classList.add('selected');
  booking.service = val;
  if (val === 'events') {
    // Events uses the contact modal (showContactModal), not a booking flow.
    // The eventsCard onclick calls showContactModal directly; this branch
    // is kept as a safety fallback only.
    showContactModal('events');
    return;
  }
  nextStep();
  renderProgress();
}

// ── BACK FROM EVENTS ──
function backFromEvents() {
  document.getElementById('stepEvents').classList.remove('active');
  document.getElementById('step2').classList.add('active');
  document.getElementById('bottomNav').style.display = '';
  document.getElementById('progressWrap').style.display = '';
}

// ── Auto-scroll helper ──
// Smoothly scrolls to `id` after `delay` ms (default 80ms, so display:block has
// time to take effect). Only scrolls FORWARD — never jumps back up the page —
// to avoid confusing the user when they edit an earlier choice.
function autoScroll(id, delay) {
  setTimeout(function() {
    var el = document.getElementById(id);
    if (!el || el.offsetParent === null) return;       // hidden or missing — skip
    var hdr = document.querySelector('.booking-header');
    var topOffset = (hdr ? hdr.offsetHeight : 0) + 16; // 16px breathing room
    var targetY = el.getBoundingClientRect().top + window.pageYOffset - topOffset;
    if (targetY > window.pageYOffset + 20) {           // only scroll if meaningfully forward
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    }
  }, delay || 80);
}

// ── STEP 3 PANEL ──
function showStep3Panel() {
  ['groomSpecsSection','hotelDatesSection','daycareScheduleSection','studioSlotSection'].forEach(function(id) {
    document.getElementById(id).style.display = 'none';
  });
  var cfg = SERVICE_CONFIG[booking.service];
  if (!cfg || !cfg.step3) return;
  document.getElementById('s3title').textContent    = cfg.step3.title;
  document.getElementById('s3subtitle').textContent = cfg.step3.subtitle;
  document.getElementById(cfg.step3.sectionId).style.display = '';
  // If returning to hotel step 3 with dates already set (e.g. after cancelled payment edit),
  // reload room availability so the grid reflects current bookings.
  if (booking.service === 'hotel') {
    var _cin  = document.getElementById('hotelCheckin');
    var _cout = document.getElementById('hotelCheckout');
    if (_cin && _cout && _cin.value && _cout.value) loadRoomAvailability();
  }
}

// ── STEP 4 PANEL ──
function showStep4Panel() {
  ['groomSchedSection','hotelDetailsSection','daycareDetailsSection'].forEach(function(id) {
    document.getElementById(id).style.display = 'none';
  });
  var cfg = SERVICE_CONFIG[booking.service];
  if (!cfg || !cfg.step4) return;
  document.getElementById('s4title').textContent    = cfg.step4.title;
  document.getElementById('s4subtitle').textContent = cfg.step4.subtitle;
  document.getElementById(cfg.step4.sectionId).style.display = '';
  if (booking.service === 'hotel') {
    populateHotelDropoffTimes();
    var _ppGroup = document.getElementById('playparkYes') ? document.getElementById('playparkYes').closest('.form-group') : null;
    if (_ppGroup) _ppGroup.style.display = booking.petSize === 'cat' ? 'none' : '';
    if (booking.petSize === 'cat') {
      booking.playparkConsent = null;
    } else {
      // Re-highlight playpark buttons from restored booking state
      var _ppY = document.getElementById('playparkYes');
      var _ppN = document.getElementById('playparkNo');
      if (_ppY) _ppY.classList.toggle('selected', booking.playparkConsent === 'yes');
      if (_ppN) _ppN.classList.toggle('selected', booking.playparkConsent === 'no');
    }
  }
}

// ── STEP 5 PET PANEL ──
function showPetPanel() {
  var svc      = booking.service;
  var isHotel  = svc === 'hotel';
  var hasPetSize = !!booking.petSize; // true for grooming, hotel, daycare

  document.getElementById('emergencySection').style.display = isHotel ? '' : 'none';
  document.getElementById('secondCatSection').style.display = (isHotel && (booking.hotelRoomType === 'villa' || booking.hotelRoomId && liveRooms.find(function(r){return r.id===booking.hotelRoomId && r.room_type==='villa';}))) ? '' : 'none';
  if (svc !== 'grooming') document.getElementById('seniorWaiverRow').style.display = 'none';

  // ── Animal type: prepopulate and lock whenever petSize is known ──
  var dogBtn = document.getElementById('petTypeDog');
  var catBtn = document.getElementById('petTypeCat');
  if (hasPetSize) {
    var animal = booking.petSize === 'cat' ? 'cat' : 'dog';
    booking.petAnimal = animal;
    dogBtn.classList.toggle('selected', animal === 'dog');
    catBtn.classList.toggle('selected', animal === 'cat');
    dogBtn.classList.add('locked-opt');
    catBtn.classList.add('locked-opt');
  } else {
    dogBtn.classList.remove('locked-opt');
    catBtn.classList.remove('locked-opt');
  }

  // ── Size: always show readonly display when petSize is already known ──
  var sizeGroup  = document.getElementById('petSizeGroupPet');
  var selectGroup = document.getElementById('petSizeSelectGroup');
  if (hasPetSize) {
    sizeGroup.style.display   = '';
    selectGroup.style.display = 'none';
    document.getElementById('petSizeDisplay').value = PET_SIZE_LABELS[booking.petSize] || '';
  } else {
    // Studio: no size collected at all
    sizeGroup.style.display   = 'none';
    selectGroup.style.display = 'none';
  }

  renderVaccines();
  checkSeniorWaiver();
}

// ── STEP 6 OWNER PANEL ──
function showOwnerPanel() {
  var svc = booking.service;
  var flow = FLOWS[svc] || FLOWS.grooming;
  var eyebrow = 'Step ' + flow.steps.indexOf('You') + 1;
  var el = document.getElementById('s6eyebrow');
  if (el) el.textContent = eyebrow;
}

// ── STEP 7 WAIVER PANEL ──
function showWaiverPanel() {
  var svc = booking.service;
  ['groomingWaivers','daycareWaivers','hotelWaivers','studioWaiver'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  var cfg = SERVICE_CONFIG[svc];
  if (cfg && cfg.waiverSectionId) document.getElementById(cfg.waiverSectionId).style.display = '';
  var _ageVal  = parseInt((document.getElementById('petAgeNum')||{}).value) || 0;
  var _ageUnit = (document.getElementById('petAgeUnit')||{}).value || 'months';
  var _medical = ((document.getElementById('petMedical')||{}).value || '').trim();
  var _needsSenior = (_ageUnit === 'years' && _ageVal >= 6) || _medical.length > 0;
  document.getElementById('seniorWaiverSection').style.display = _needsSenior ? '' : 'none';
  var _showPlaypark = svc === 'hotel' && booking.playparkConsent === 'yes' && booking.petSize !== 'cat';
  document.getElementById('playparkWaiverSection').style.display = _showPlaypark ? '' : 'none';
}

// ── GROOMING SIZE ──
function selectGroomSize(el, val) {
  if (el.classList.contains('disabled-opt')) return;
  document.querySelectorAll('#groomSizeGrid .pet-type-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.petSize = val;
  booking.groomService = null;
  booking.groomServicePrice = 0;
  booking.selectedAddons = {};
  renderGroomServices();
  document.getElementById('groomServiceSection').style.display = 'block';
  document.getElementById('addonSection').style.display = 'none';
  document.getElementById('groomSpecialSection').style.display = 'none';
  updateGroomTotal();
  updateNavTotal();
  refreshContinueBtn();
  autoScroll('groomServiceSection');
}

function renderGroomServices() {
  var size = booking.petSize;
  var grid = document.getElementById('groomSvcGrid');
  grid.innerHTML = GROOM_SERVICES.map(function(s) {
    // Ala carte has no base price — cost comes entirely from selected add-ons
    var price = (s.key === 'ala_carte') ? 0 : (GROOM_PRICES[s.key][size] || 0);
    var priceLabel = s.key === 'ala_carte' ? 'Choose services below' : ('₱' + price.toLocaleString());
    return '<div class="svc-card" onclick="selectGroomService(this,\'' + s.key + '\',' + price + ')">' +
      '<div class="svc-card-radio"></div>' +
      '<div class="svc-card-info">' +
        '<div class="svc-card-name">' + s.name + '</div>' +
        '<div class="svc-card-duration">' + s.duration + '</div>' +
        '<div class="svc-card-desc" style="font-size:11px;color:var(--mid);margin-top:3px;line-height:1.4">' + s.desc + '</div>' +
      '</div>' +
      '<div class="svc-card-price">' + priceLabel + '</div>' +
    '</div>';
  }).join('');
}

function selectGroomService(el, key, price) {
  document.querySelectorAll('#groomSvcGrid .svc-card').forEach(function(c){c.classList.remove('selected');});
  el.classList.add('selected');
  booking.groomService = key;
  booking.groomServicePrice = price;
  booking.selectedAddons = {};
  renderAddons();
  document.getElementById('addonSection').style.display = 'block';
  document.getElementById('groomSpecialSection').style.display = 'block';
  updateGroomTotal();
  updateNavTotal();
  refreshContinueBtn();
  autoScroll('addonSection');
}

function renderAddons() {
  var svcKey  = booking.groomService;
  var enabled = ADDON_ENABLED[svcKey];
  var size    = booking.petSize;
  var grid    = document.getElementById('addonGrid');
  grid.innerHTML = ADDONS.map(function(a) {
    var isEnabled = !enabled || enabled.indexOf(a.key) !== -1;
    var priceLabel = '';
    if (a.assessment) {
      priceLabel = 'assessment';
    } else if (a.sizeDependent) {
      var p = FACE_TRIM_PRICES[size] || 0;
      priceLabel = '\u20b1' + p.toLocaleString();
    } else {
      priceLabel = '+\u20b1' + a.price.toLocaleString();
    }
    var disabledClass = isEnabled ? '' : ' addon-disabled';
    return '<div class="addon-row' + disabledClass + '" id="addon_' + a.key + '" onclick="toggleAddon(this,\'' + a.key + '\',' + (a.assessment ? 0 : (a.sizeDependent ? (FACE_TRIM_PRICES[size]||0) : a.price)) + ',' + a.assessment + ')">' +
      '<div class="addon-check"></div>' +
      '<span class="addon-name">' + a.name + '</span>' +
      '<span class="addon-price">' + priceLabel + '</span>' +
      '</div>';
  }).join('');
  if (booking.groomService === 'premium') {
    var ftEl = document.getElementById('addon_face_trim');
    if (ftEl) {
      ftEl.classList.add('addon-disabled');
      ftEl.classList.remove('selected');
      delete booking.selectedAddons['face_trim'];
      ftEl.querySelector('.addon-price').textContent = 'included';
    }
  }
}

function toggleAddon(el, key, price, isAssessment) {
  if (el.classList.contains('addon-disabled')) return;
  el.classList.toggle('selected');
  if (el.classList.contains('selected')) {
    booking.selectedAddons[key] = isAssessment ? 0 : price;
  } else {
    delete booking.selectedAddons[key];
  }
  // Show assessment note
  var hasAssess = ['deshed','demat'].some(function(k){ return booking.selectedAddons[k] !== undefined; });
  document.getElementById('assessNote').style.display = hasAssess ? 'block' : 'none';
  // Ala carte note
  var isAlaCarte = booking.groomService === 'ala_carte';
  var hasAddon   = Object.keys(booking.selectedAddons).length > 0;
  document.getElementById('alacartNote').style.display = (isAlaCarte && !hasAddon) ? 'block' : 'none';
  updateGroomTotal();
  updateNavTotal();
  refreshContinueBtn();
}

function updateGroomTotal() {
  var base    = booking.groomServicePrice || 0;
  var addons  = Object.keys(booking.selectedAddons).reduce(function(a,k){return a+(booking.selectedAddons[k]||0);},0);
  var subtotal = base + addons;
  var discount = booking.memberValid ? Math.round(subtotal * MEMBER_DISCOUNT.grooming) : 0;
  var total    = subtotal - discount;
  var el = document.getElementById('groomPriceTotal');
  if (subtotal > 0) {
    var html = '\u20b1' + total.toLocaleString();
    if (discount > 0) html = '<span style="text-decoration:line-through;opacity:0.5;font-size:14px">\u20b1' + subtotal.toLocaleString() + '</span> \u20b1' + total.toLocaleString();
    document.getElementById('groomTotalVal').innerHTML = html;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

// ── GROOMING SCHEDULE ──
function selectStylist(el, val, groomerId) {
  document.querySelectorAll('#stylistGrid .stylist-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.preferredStylist   = val;
  booking.preferredStylistId = groomerId || null;
  booking.groomSlot = null;
  document.getElementById('groomSlotsSection').style.display = 'block';
  renderGroomSlots();
  autoScroll('groomSlotsSection');
}

// Duration in minutes per service key
var GROOM_SLOT_MINS = { bath_dry:30, basic:60, premium:120, ala_carte:60 };

// Parse a slot string like "9:00 AM" into minutes since midnight
function slotToMins(slot) {
  var m = slot.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  var h = parseInt(m[1]), min = parseInt(m[2]), ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

// Return all slot strings that a booking occupies based on its start slot + duration
function occupiedSlots(startSlot, durationMins, allSlots) {
  var startMins = slotToMins(startSlot);
  if (startMins < 0) return [startSlot];
  var endMins = startMins + durationMins;
  return allSlots.filter(function(s) {
    var sm = slotToMins(s);
    return sm >= startMins && sm < endMins;
  });
}

// Check whether selecting a given slot would overlap with any booked slot-range
// Takes into account the CURRENT service duration the customer is booking
function slotOverlapsBooked(candidateSlot, currentDurationMins, blockedRanges) {
  var candStart = slotToMins(candidateSlot);
  var candEnd   = candStart + currentDurationMins;
  return blockedRanges.some(function(range) {
    return candStart < range.end && candEnd > range.start;
  });
}

async function renderGroomSlots() {
  var grid = document.getElementById('groomSlots');
  if (!grid) return;

  var groomerId  = booking.preferredStylistId;   // null = "any available"
  var isAny      = !groomerId;
  var dateVal    = booking.groomDate;
  var serviceKey = booking.groomService || 'basic';
  var myDuration = GROOM_SLOT_MINS[serviceKey] || 60;
  var dow        = dateVal ? new Date(dateVal + 'T00:00:00').getDay() : -1;
  var ALL_SLOTS  = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'];

  // Which groomers to consider
  var groomerPool = isAny
    ? liveGroomers
    : liveGroomers.filter(function(g){ return g.id === groomerId; });

  grid.innerHTML = '<p style="font-size:12px;color:var(--mid);padding:8px 0">Checking availability...</p>';

  // Helper: parse "HH:MM" or "HH:MM:SS" → minutes since midnight
  function parseTMins(t) {
    var p = (t||'').split(':');
    return parseInt(p[0]||0)*60 + parseInt(p[1]||0);
  }

  // Helper: does [candStart, candEnd) overlap any range in the list?
  function overlaps(ranges, candStart, candEnd) {
    return ranges.some(function(r){ return candStart < r.end && candEnd > r.start; });
  }

  // All booking rows and blocked_schedule rows fetched once for the whole pool
  var bookingRows = [];
  var blockRows   = [];

  try {
    var branchId = await getSelectedBranchId();
    if (!branchId || !dateVal || !groomerPool.length) throw new Error('missing_context');

    // 1. ALL grooming bookings for this date/branch (no groomer filter) so that
    //    unassigned bookings (groomer_id=null) are visible for any-groomer overflow math.
    //    rangesFor() does client-side groomer filtering, so this is still correct.
    var bkQuery = 'select=timeslot,groom_service_key,groomer_id,bookings!inner(status,branch_id)' +
      '&service_date=eq.'        + dateVal +
      '&bookings.branch_id=eq.'  + branchId +
      '&bookings.status=not.in.(cancelled,rejected)';
    bookingRows = (await sbFetchPublic('grooming_details', bkQuery)) || [];

    // 2. ALL one-off blocked_schedules for groomers on this date (no resource filter).
    //    rangesFor() does client-side resource filtering.
    var bsQuery = 'select=resource_id,start_time,end_time' +
      '&resource_type=eq.groomer&active=eq.true' +
      '&dates=cs.{' + dateVal + '}';
    try { blockRows = (await sbFetchPublic('blocked_schedules', bsQuery)) || []; }
    catch(e) { blockRows = []; } // table may not exist yet — degrade gracefully

  } catch(e) {
    console.warn('Slot availability check failed, showing all slots:', e);
    // Degrade gracefully: show all slots
    grid.innerHTML = ALL_SLOTS.map(function(s){
      return '<div class="timeslot" onclick="selectSlot(this)">'+s+'</div>';
    }).join('');
    return;
  }

  // Build the full blocked-ranges list for a given groomer
  function rangesFor(gId) {
    var ranges = [];
    // Active bookings
    bookingRows.filter(function(r){ return r.groomer_id === gId && r.timeslot; }).forEach(function(r) {
      var dur = GROOM_SLOT_MINS[r.groom_service_key || 'basic'] || 60;
      var st  = slotToMins(r.timeslot);
      if (st >= 0) ranges.push({ start: st, end: st + dur });
    });
    // Recurring groomer breaks (groomer_blocks)
    if (dow >= 0) {
      getGroomerBlocksForDay(gId, dow).forEach(function(bl) {
        ranges.push({ start: parseTMins(bl.start_time), end: parseTMins(bl.end_time) });
      });
    }
    // One-off blocked schedules
    blockRows.filter(function(b){ return b.resource_id === gId; }).forEach(function(b) {
      ranges.push({ start: parseTMins(b.start_time), end: parseTMins(b.end_time) });
    });
    return ranges;
  }

  var availableSlots = ALL_SLOTS.filter(function(slot) {
    var candStart = slotToMins(slot);
    var candEnd   = candStart + myDuration;
    if (isAny) {
      // Count how many groomers in the pool are actually free at this slot
      var freeCount = groomerPool.filter(function(g) {
        return !overlaps(rangesFor(g.id), candStart, candEnd);
      }).length;
      // Also count unassigned (groomer_id = null) bookings that overlap this slot —
      // each one consumes one of the free groomers, so it must be deducted.
      var unassignedCount = bookingRows.filter(function(r) {
        if (r.groomer_id != null) return false;
        if (!r.timeslot) return false;
        var dur = GROOM_SLOT_MINS[r.groom_service_key || 'basic'] || 60;
        var st  = slotToMins(r.timeslot);
        return st >= 0 && candStart < st + dur && candEnd > st;
      }).length;
      // Available only if more free groomers remain after accounting for unassigned bookings
      return freeCount > unassignedCount;
    } else {
      // Is this specific groomer directly blocked/booked?
      if (overlaps(rangesFor(groomerId), candStart, candEnd)) return false;
      // Would unassigned bookings overflow into this groomer?
      // Count other groomers (not this one) who are free at this slot.
      var otherFreeCount = liveGroomers.filter(function(g) {
        return g.id !== groomerId && !overlaps(rangesFor(g.id), candStart, candEnd);
      }).length;
      var unassignedAtSlot = bookingRows.filter(function(r) {
        if (r.groomer_id != null) return false;
        if (!r.timeslot) return false;
        var dur = GROOM_SLOT_MINS[r.groom_service_key || 'basic'] || 60;
        var st  = slotToMins(r.timeslot);
        return st >= 0 && candStart < st + dur && candEnd > st;
      }).length;
      // If unassigned bookings exceed other free groomers, they'd spill into this groomer
      return unassignedAtSlot <= otherFreeCount;
    }
  });

  if (!availableSlots.length) {
    var msg = isAny
      ? 'No available slots — all groomers are fully booked for this date. Please try a different date.'
      : 'No available slots for this groomer on this date. Try a different date or choose "Any available".';
    grid.innerHTML = '<p style="font-size:12px;color:var(--error);padding:8px 0">'+msg+'</p>';
    return;
  }

  grid.innerHTML = availableSlots.map(function(slot) {
    return '<div class="timeslot" onclick="selectSlot(this)">'+slot+'</div>';
  }).join('');
  // Re-highlight the previously selected slot (e.g. after returning from cancelled payment)
  if (booking.groomSlot || booking.studioSlot) {
    var _prevSlot = booking.groomSlot || booking.studioSlot;
    grid.querySelectorAll('.timeslot').forEach(function(t) {
      if (t.textContent.trim() === _prevSlot) t.classList.add('selected');
    });
  }
}
function onGroomDateChange() {
  var val = document.getElementById('groomDate').value;
  if (!val) return;
  if (val < localDateStr()) {
    alert('Grooming date cannot be in the past. Please select today or a future date.');
    document.getElementById('groomDate').value = '';
    refreshContinueBtn();
    return;
  }
  booking.groomDate = val;
  booking.groomSlot = null;
  booking.preferredStylist = 'any';
  booking.preferredStylistId = null;
  document.getElementById('stylistSection').style.display = 'block';
  document.getElementById('groomSlotsSection').style.display = 'none';
  renderStylistGrid();
  refreshContinueBtn();
  autoScroll('stylistSection');
}

function renderStylistGrid() {
  var grid = document.getElementById('stylistGrid');
  if (!grid) return;
  booking.preferredStylist = null;
  var html = '';
  var anyOnclick = "selectStylist(this,'any',null)";
  html += '<div class="stylist-btn" onclick="' + anyOnclick + '">' +
    '<span class="stylist-name">Any available</span>' +
    '<span class="stylist-tag">Best availability</span></div>';
  if (liveGroomers.length) {
    html += liveGroomers.map(function(g) {
      var colorDot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (g.color||'#6AAEC8') + ';margin-right:4px;flex-shrink:0;vertical-align:middle"></span>';
      var onclk = "selectStylist(this,'" + g.name + "','" + g.id + "')";
      return '<div class="stylist-btn" onclick="' + onclk + '">' +
        '<span class="stylist-name">' + colorDot + g.name + '</span>' +
        '<span class="stylist-tag">Groomer</span></div>';
    }).join('');
  } else {
    var fallback = ['Alex','Jamie','Sam','Paolo'];
    html += fallback.map(function(name) {
      var onclk = "selectStylist(this,'" + name + "',null)";
      return '<div class="stylist-btn" onclick="' + onclk + '">' +
        '<span class="stylist-name">' + name + '</span><span class="stylist-tag">Groomer</span></div>';
    }).join('');
  }
  grid.innerHTML = html;
}
function selectSlot(el) {
  if (el.classList.contains('unavailable')) return;
  el.closest('.timeslot-grid').querySelectorAll('.timeslot').forEach(function(t){t.classList.remove('selected');});
  el.classList.add('selected');
  if (booking.service === 'studio') booking.studioSlot = el.textContent.trim();
  else booking.groomSlot = el.textContent.trim();
  refreshContinueBtn();
}

// ── HOTEL SIZE + RATES ──
// Room capacity per type (how many concurrent bookings allowed)
var ROOM_CAPACITY = {
  small_cage:    3,
  medium_cage:   3,
  large_cage:    2,
  single_cabin:  4,
  villa:         2
};
// Which room keys are available per pet size
var ROOMS_FOR_SIZE = {
  small_dog:  ['small_cage','medium_cage','large_cage'],
  medium_dog: ['medium_cage','large_cage'],
  large_dog:  ['large_cage'],
  giant_dog:  ['large_cage'],
  cat:        ['single_cabin','villa']
};
var ROOM_LABELS = {
  small_cage:   'Small Dog Cage',
  medium_cage:  'Medium Dog Cage',
  large_cage:   'Large Dog Cage',
  single_cabin: 'Single Cabin',
  villa:        'Villa (up to 2 cats)'
};

function selectHotelSize(el, val) {
  if (el.classList.contains('disabled-opt')) return;
  document.querySelectorAll('#hotelSizeGrid .pet-type-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.petSize = val;
  booking.hotelRoomType = null;
  document.getElementById('hotelDatesBody').style.display = 'block';
  document.getElementById('roomAvailSection').style.display = 'none';
  document.getElementById('roomAvailGrid').innerHTML = '';
  document.getElementById('hotelCheckin').value  = '';
  document.getElementById('hotelCheckout').value = '';
  document.getElementById('nightsDisplay').style.display = 'none';
  refreshContinueBtn();
  autoScroll('hotelDatesBody');
}

// Returns {start, end} hour range for hotel based on branch location and date's day-of-week
function getHotelHours(dateStr, location) {
  var dow = dateStr ? new Date(dateStr + 'T00:00:00').getDay() : -1;
  if ((location || '').indexOf('estancia') !== -1) {
    var isWd = dow >= 1 && dow <= 4;
    return { start: (dow < 0 ? 10 : (isWd ? 11 : 10)), end: (dow < 0 ? 22 : (isWd ? 21 : 22)) };
  }
  return { start: 10, end: 22 }; // Eastwood and default
}

function hotelTimeLabel(h) {
  return h < 12 ? h + ':00 AM' : (h === 12 ? '12:00 PM' : (h - 12) + ':00 PM');
}

function populateHotelDropoffTimes() {
  var checkin = document.getElementById('hotelCheckin').value;
  var sel     = document.getElementById('hotelDropoffTime');
  if (!checkin) { sel.innerHTML = '<option value="">Select date first</option>'; return; }
  var hours = getHotelHours(checkin, booking.location);
  var html = '<option value="">Select time</option>';
  for (var h = hours.start; h <= hours.end; h++) {
    html += '<option value="' + h + '">' + hotelTimeLabel(h) + '</option>';
  }
  sel.innerHTML = html;
  if (booking.hotelDropoffTime) sel.value = booking.hotelDropoffTime;
}

function onHotelCheckinChange() {
  var cin = document.getElementById('hotelCheckin').value;
  if (!cin) return;
  // Reject past dates — some mobile browsers don't enforce the min attribute visually
  if (cin < localDateStr()) {
    alert('Check-in date cannot be in the past. Please select today or a future date.');
    document.getElementById('hotelCheckin').value = '';
    refreshContinueBtn();
    return;
  }
  var next = new Date(cin + 'T12:00:00'); next.setDate(next.getDate() + 1);
  document.getElementById('hotelCheckout').min = localDateStr(next);
  document.getElementById('hotelCheckout').value = '';
  document.getElementById('nightsDisplay').style.display = 'none';
  document.getElementById('roomAvailSection').style.display = 'none';
  refreshContinueBtn();
}

function onHotelCheckoutChange() {
  var cin  = document.getElementById('hotelCheckin').value;
  var cout = document.getElementById('hotelCheckout').value;
  if (!cin || !cout) return;
  if (cout < localDateStr()) {
    alert('Check-out date cannot be in the past. Please select a valid date.');
    document.getElementById('hotelCheckout').value = '';
    refreshContinueBtn();
    return;
  }
  var nights = Math.round((new Date(cout+' 00:00:00') - new Date(cin+' 00:00:00')) / 86400000);
  if (nights <= 0) return;
  document.getElementById('nightsCount').innerHTML =
    '<strong>' + nights + ' night' + (nights>1?'s':'') + '</strong> selected';
  document.getElementById('nightsDisplay').style.display = '';
  booking.hotelCheckin  = cin;
  booking.hotelCheckout = cout;
  buildPickupTimeOptions(); // Rebuild pickup options for the checkout date's branch hours
  loadRoomAvailability();
  autoScroll('roomAvailSection', 150);
  refreshContinueBtn();
}

async function loadRoomAvailability() {
  var cin  = document.getElementById('hotelCheckin').value;
  var cout = document.getElementById('hotelCheckout').value;
  var size = booking.petSize;
  if (!cin || !cout || !size) return;

  var section = document.getElementById('roomAvailSection');
  var loading = document.getElementById('roomAvailLoading');
  var grid    = document.getElementById('roomAvailGrid');
  var noteEl  = document.getElementById('roomAvailNote');

  section.style.display = '';
  loading.style.display = 'flex';
  grid.innerHTML        = '';
  noteEl.style.display  = 'none';
  booking.hotelRoomType = null;
  booking.hotelRoomId   = null;

  var eligibleRooms = liveRooms.filter(function(r) {
    if (r.is_locked) return false;
    if (!r.allowed_sizes || !r.allowed_sizes.length) return false;
    return r.allowed_sizes.indexOf(size) !== -1;
  });

    var bookedRoomIds = {};
  try {
    var branch = await getSelectedBranchId();
    if (branch) {
      // Step 1: get all confirmed hotel booking IDs for this branch
      var bookingRows = await sbFetchPublic('bookings',
        'select=id&branch_id=eq.' + branch +
        '&service=eq.hotel&status=not.in.(cancelled,rejected)');
      if (bookingRows && bookingRows.length) {
        var bookingIds = bookingRows.map(function(b){ return b.id; }).join(',');
        // Step 2: get hotel_details overlapping our date range
        var detailRows = await sbFetchPublic('hotel_details',
          'select=room_id,room_type,checkin_date,checkout_date' +
          '&booking_id=in.(' + bookingIds + ')' +
          '&checkin_date=lte.' + cout +
          '&checkout_date=gte.' + cin);
        (detailRows || []).forEach(function(r) {
          var key = r.room_id || r.room_type;
          if (key) bookedRoomIds[key] = (bookedRoomIds[key] || 0) + 1;
        });
      }
    }
  } catch(e) { console.error('Hotel availability check failed:', e); }

  loading.style.display = 'none';

  if (!eligibleRooms.length) {
    var roomKeys = ROOMS_FOR_SIZE[size] || [];
    grid.innerHTML = roomKeys.map(function(key) {
      var label = ROOM_LABELS[key] || key;
      var fbOnclick = "selectRoomFromAvail(this,'" + key + "',null)";
      return '<div class="svc-card" onclick="' + fbOnclick + '">' +
        '<div class="svc-card-radio"></div>' +
        '<div class="svc-card-info"><div class="svc-card-name">' + label + '</div>' +
        '<div class="svc-card-duration"><span style="font-size:10px;color:var(--mid)">Loading room data...</span></div></div></div>';
    }).join('');
    calcNights();
    return;
  }

  var anyAvailable = false;
  grid.innerHTML = eligibleRooms.map(function(room) {
    var booked  = (bookedRoomIds[room.id] || 0) + (bookedRoomIds[room.room_type] || 0);
    var isAvail = booked === 0;
    if (isAvail) anyAvailable = true;
    var availLabel = isAvail
      ? '<span style="font-size:10px;color:var(--success);font-weight:700">Available</span>'
      : '<span style="font-size:10px;color:var(--error);font-weight:700">Fully booked</span>';
    var colorDot = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (room.color||'#6AAEC8') + ';margin-right:6px;flex-shrink:0"></span>';
    var cls = 'svc-card' + (isAvail ? '' : ' svc-card-disabled');
    return '<div class="' + cls + '" id="room-opt-' + room.id + '"' +
      (isAvail ? ' onclick="' + "selectRoomFromAvail(this,'" + room.room_type + "','" + room.id + "')" + '"' : '') + '>' +
      '<div class="svc-card-radio"></div>' +
      '<div class="svc-card-info">' +
        '<div class="svc-card-name" style="display:flex;align-items:center">' + colorDot + room.name + '</div>' +
        '<div class="svc-card-duration">' + availLabel + '</div>' +
      '</div></div>';
  }).join('');

  if (!anyAvailable) noteEl.style.display = '';
  calcNights();
}

function selectRoomFromAvail(el, key, roomId) {
  document.querySelectorAll('#roomAvailGrid .svc-card').forEach(function(c){c.classList.remove('selected');});
  el.classList.add('selected');
  booking.hotelRoomType = key;
  booking.hotelRoomId   = roomId || null;
  // Save the display name (e.g. "Large Cage 1") for use in summary
  var roomObj = roomId ? liveRooms.find(function(r){return r.id === roomId;}) : null;
  booking.hotelRoomName = roomObj ? roomObj.name : (ROOM_LABELS[key] || key.replace(/_/g,' '));
  var secondCat = document.getElementById('secondCatSection');
  if (secondCat) secondCat.style.display = (key === 'villa') ? '' : 'none';
  calcHotelTotal();
  updateNavTotal();
  refreshContinueBtn();
  autoScroll('hotelStep3Breakdown', 150);
}

async function getSelectedBranchId() {
  if (!window._branchIds) {
    try {
      var rows = await sbFetchPublic('branches', 'select=id,name&order=created_at');
      window._branchIds = rows || [];
    } catch(e) { return null; }
  }
  var loc = booking.location;
  var match = (window._branchIds).find(function(b) {
    return (loc === 'estancia' && b.name.toLowerCase().includes('estancia')) ||
           (loc === 'eastwood'  && b.name.toLowerCase().includes('eastwood'));
  });
  return match ? match.id : null;
}

async function loadLiveRoomsAndGroomers() {
  var branchId = await getSelectedBranchId();
  if (!branchId) return;
  try {
    liveRooms = await sbFetchPublic('rooms',
      'select=id,name,color,room_type,pet_type,allowed_sizes,is_locked,schedule_restrictions' +
      '&branch_id=eq.' + branchId +
      '&active=eq.true&order=sort_order');
  } catch(e) { liveRooms = []; }
  try {
    liveGroomers = await sbFetchPublic('groomers',
      'select=id,name,color,schedule_restrictions,is_unavailable' +
      '&branch_id=eq.' + branchId +
      '&active=eq.true&is_unavailable=eq.false&order=sort_order');
  } catch(e) { liveGroomers = []; }
  if (liveGroomers.length) {
    var gids = liveGroomers.map(function(g){return g.id;}).join(',');
    try {
      liveGroomerBlocks = await sbFetchPublic('groomer_blocks',
        'select=groomer_id,label,start_time,end_time,days_of_week' +
        '&groomer_id=in.(' + gids + ')&active=eq.true');
    } catch(e) { liveGroomerBlocks = []; }
  } else {
    liveGroomerBlocks = [];
  }
  try {
    liveStudios = await sbFetchPublic('studios',
      'select=id,name,color,schedule_restrictions,is_unavailable' +
      '&branch_id=eq.' + branchId +
      '&active=eq.true&order=sort_order');
  } catch(e) { liveStudios = []; }
  if (liveStudios.length) {
    var sids = liveStudios.map(function(s){return s.id;}).join(',');
    try {
      liveStudioBlocks = await sbFetchPublic('studio_blocks',
        'select=studio_id,label,start_time,end_time,days_of_week' +
        '&studio_id=in.(' + sids + ')&active=eq.true');
    } catch(e) { liveStudioBlocks = []; }
  } else {
    liveStudioBlocks = [];
  }
}

function getGroomerBlocksForDay(groomerId, dow) {
  return liveGroomerBlocks.filter(function(bl) {
    return bl.groomer_id === groomerId &&
      (bl.days_of_week.length === 0 || bl.days_of_week.indexOf(dow) !== -1);
  });
}

function getStudioBlocksForDay(studioId, dow) {
  return liveStudioBlocks.filter(function(bl) {
    return bl.studio_id === studioId &&
      (bl.days_of_week.length === 0 || bl.days_of_week.indexOf(dow) !== -1);
  });
}

function isSlotBlocked(slotTime, groomerId, dow) {
  var blocks = getGroomerBlocksForDay(groomerId, dow);
  if (!blocks.length) return false;
  // Parse slot to minutes
  var sm = slotTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!sm) return false;
  var h = parseInt(sm[1]), min = parseInt(sm[2]), ap = sm[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  var slotMins = h * 60 + min;
  return blocks.some(function(bl) {
    var startParts = bl.start_time.split(':');
    var endParts   = bl.end_time.split(':');
    var blStart = parseInt(startParts[0])*60 + parseInt(startParts[1]);
    var blEnd   = parseInt(endParts[0])*60   + parseInt(endParts[1]);
    return slotMins >= blStart && slotMins < blEnd;
  });
}

async function sbFetchPublic(path, params) {
  var url = SUPABASE_URL + '/rest/v1/' + path + (params ? '?' + params : '');
  var res = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type':  'application/json',
    }
  });
  if (!res.ok) throw new Error('Supabase ' + res.status);
  return res.json();
}

async function sbRpcPublic(fn, params) {
  var res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method:  'POST',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(params || {})
  });
  if (!res.ok) throw new Error('Supabase RPC ' + res.status + ': ' + await res.text());
  return res.json();
}

function calcNights() {
  var cin  = document.getElementById('hotelCheckin').value;
  var cout = document.getElementById('hotelCheckout').value;
  if (!cin || !cout) return;
  var nights = Math.round((new Date(cout+' 00:00:00') - new Date(cin+' 00:00:00')) / 86400000);
  if (nights > 0) {
    document.getElementById('nightsCount').innerHTML = '<strong>' + nights + ' night' + (nights>1?'s':'') + '</strong> selected';
    document.getElementById('nightsDisplay').style.display = '';
  }
}

function buildPickupTimeOptions() {
  var sel   = document.getElementById('hotelPickupTime');
  var feeEl = document.getElementById('hotelLateRateFee');
  if (!sel) return;
  var cout  = document.getElementById('hotelCheckout') ? document.getElementById('hotelCheckout').value : '';
  var hours = getHotelHours(cout, booking.location);
  sel.innerHTML = '<option value="">Select pick-up time</option>';
  for (var h = hours.start; h <= hours.end; h++) {
    var opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = hotelTimeLabel(h);
    sel.appendChild(opt);
  }
  // Restore saved value after rebuild
  if (booking.hotelPickupTime) sel.value = booking.hotelPickupTime;
  if (feeEl) feeEl.textContent = '+₱' + HOTEL_LATE_RATE.toLocaleString() + '/hour after 2:00 PM';
}

function calcHotelTotal() {
  var cin  = document.getElementById('hotelCheckin').value;
  var cout = document.getElementById('hotelCheckout').value;
  var size = booking.petSize;
  var room = booking.hotelRoomType;
  var step3el = document.getElementById('hotelStep3Breakdown');
  var step4el = document.getElementById('hotelDetailsPriceTotal');
  if (!cin || !cout || !size || !room) {
    if (step3el) step3el.style.display = 'none';
    if (step4el) step4el.style.display = 'none';
    return;
  }
  var nights = Math.round((new Date(cout+' 00:00:00') - new Date(cin+' 00:00:00')) / 86400000);
  if (nights <= 0) return;

  // Rate is determined by the cage type selected, not the pet's size category
  var rateSize = CAGE_RATE_SIZE[room] || size;
  var roomLabel = booking.hotelRoomName || ROOM_LABELS[room] || room.replace(/_/g,' ');

  var wdCount = 0, weCount = 0, wdTotal = 0, weTotal = 0;
  for (var i = 0; i < nights; i++) {
    var d   = new Date(cin + ' 00:00:00'); d.setDate(d.getDate() + i);
    var dow = d.getDay();
    var isWe = (dow === 0 || dow === 5 || dow === 6);
    if (isWe) { weCount++; weTotal += HOTEL_RATES.weekend[rateSize]||0; }
    else       { wdCount++; wdTotal += HOTEL_RATES.weekday[rateSize]||0; }
  }
  var baseTotal = wdTotal + weTotal;
  booking.hotelBaseTotal = baseTotal;

  // Save drop-off time so it survives navigating back to this step
  var dropoffEl = document.getElementById('hotelDropoffTime');
  if (dropoffEl && dropoffEl.value) booking.hotelDropoffTime = dropoffEl.value;

  var pickupEl   = document.getElementById('hotelPickupTime');
  var pickupHour = pickupEl ? (parseInt(pickupEl.value) || 14) : 14;
  booking.hotelPickupHour = pickupHour;
  var lateHours  = Math.max(0, pickupHour - 14);
  booking.hotelLateTotal = lateHours * HOTEL_LATE_RATE;

  // Show / hide the late pick-up fee note below the selector
  var lateNoteEl = document.getElementById('hotelLatePickupNote');
  if (lateNoteEl) {
    if (booking.hotelLateTotal > 0) {
      lateNoteEl.innerHTML = '<strong>Late pick-up fee:</strong> +&#8369;' + booking.hotelLateTotal.toLocaleString() +
        ' (' + lateHours + ' hr' + (lateHours !== 1 ? 's' : '') + ' &times; &#8369;' + HOTEL_LATE_RATE.toLocaleString() + '/hr)';
      lateNoteEl.style.display = '';
    } else {
      lateNoteEl.style.display = 'none';
    }
  }

  var subtotal = baseTotal + booking.hotelLateTotal;
  var discount = booking.memberValid ? Math.round(subtotal * MEMBER_DISCOUNT.hotel) : 0;
  var total    = subtotal - discount;

  // \u2500\u2500 Step 3 estimate breakdown (no late fee yet) \u2500\u2500
  if (step3el) {
    var s3html = '<div class="price-breakdown">';
    if (wdCount > 0) {
      var wdRate = HOTEL_RATES.weekday[rateSize]||0;
      s3html += '<div class="price-line component"><span class="price-line-label">'+wdCount+' weekday night'+(wdCount!==1?'s':'')+' &times; &#8369;'+wdRate.toLocaleString()+' ('+roomLabel+')</span><span class="price-line-val">&#8369;'+wdTotal.toLocaleString()+'</span></div>';
    }
    if (weCount > 0) {
      var weRate = HOTEL_RATES.weekend[rateSize]||0;
      s3html += '<div class="price-line component"><span class="price-line-label">'+weCount+' weekend/holiday night'+(weCount!==1?'s':'')+' &times; &#8369;'+weRate.toLocaleString()+' ('+roomLabel+')</span><span class="price-line-val">&#8369;'+weTotal.toLocaleString()+'</span></div>';
    }
    s3html += '<div class="price-line subtotal-line"><span class="price-line-label">Est. total (excl. late pickup)</span><span class="price-line-val">&#8369;'+baseTotal.toLocaleString()+'</span></div>';
    s3html += '</div>';
    step3el.innerHTML = s3html;
    step3el.style.display = '';
  }

  // \u2500\u2500 Step 4 full breakdown (includes late pickup fee) \u2500\u2500
  if (step4el) {
    var s4html = '<div class="price-breakdown">';
    if (wdCount > 0) {
      var wdRate2 = HOTEL_RATES.weekday[rateSize]||0;
      s4html += '<div class="price-line component"><span class="price-line-label">'+wdCount+' weekday night'+(wdCount!==1?'s':'')+' &times; &#8369;'+wdRate2.toLocaleString()+' ('+roomLabel+')</span><span class="price-line-val">&#8369;'+wdTotal.toLocaleString()+'</span></div>';
    }
    if (weCount > 0) {
      var weRate2 = HOTEL_RATES.weekend[rateSize]||0;
      s4html += '<div class="price-line component"><span class="price-line-label">'+weCount+' weekend/holiday night'+(weCount!==1?'s':'')+' &times; &#8369;'+weRate2.toLocaleString()+' ('+roomLabel+')</span><span class="price-line-val">&#8369;'+weTotal.toLocaleString()+'</span></div>';
    }
    if (booking.hotelLateTotal > 0) {
      s4html += '<div class="price-line component"><span class="price-line-label">Late pick-up fee ('+lateHours+' hr'+(lateHours!==1?'s':'')+')</span><span class="price-line-val">&#8369;'+booking.hotelLateTotal.toLocaleString()+'</span></div>';
    }
    s4html += '<div class="price-line subtotal-line"><span class="price-line-label">Subtotal</span><span class="price-line-val">&#8369;'+subtotal.toLocaleString()+'</span></div>';
    if (discount > 0) {
      var discPct = Math.round(MEMBER_DISCOUNT.hotel * 100);
      s4html += '<div class="price-line"><span class="price-line-label">Member discount ('+discPct+'%)</span><span class="price-line-val discount">-&#8369;'+discount.toLocaleString()+'</span></div>';
    }
    s4html += '<div class="price-line total-line"><span class="price-line-label">Estimated total</span><span class="price-line-val">&#8369;'+total.toLocaleString()+'</span></div>';
    s4html += '</div>';
    step4el.innerHTML = s4html;
    step4el.style.display = '';
  }

  updateNavTotal();
}

// ── HOTEL ROOM OPTIONS (kept for compatibility but no longer used in step 4) ──
function renderHotelRoomOptions() {
  populateHotelDropoffTimes();
}

function onHotelRoomChange() {
  var val = document.getElementById('hotelRoomType') ? document.getElementById('hotelRoomType').value : '';
  booking.hotelRoomType = val || null;
  var secondCat = document.getElementById('secondCatSection');
  if (secondCat) secondCat.style.display = (booking.hotelRoomType === 'villa') ? '' : 'none';
  calcHotelTotal();
}

function onHotelMedsChange() {
  var val = document.getElementById('hotelMeds').value.trim();
  document.getElementById('hotelMedsNote').style.display = val ? 'block' : 'none';
}

// ── SECOND CAT ──
function toggleSecondCat() {
  secondCatVisible = !secondCatVisible;
  document.getElementById('secondCatForm').style.display = secondCatVisible ? 'block' : 'none';
  document.getElementById('addSecondCatBtn').textContent = secondCatVisible ? 'Remove second cat' : '+ Add second cat details (Villa)';
}

// ── DAYCARE ──
function selectDaycareSize(el, val) {
  if (el.classList.contains('disabled-opt')) return;
  document.querySelectorAll('#daycareSizeGrid .pet-type-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.petSize = val;
  booking.daycareBaseRate = DAYCARE_RATES[val] || 500;
  document.getElementById('daycareDateSection').style.display = 'block';
  calcDaycareTotal();
  refreshContinueBtn();
  autoScroll('daycareDateSection');
}
function onDaycareDateChange() {
  var d = document.getElementById('daycareDate').value;
  if (!d) return;
  if (d < localDateStr()) {
    alert('Daycare date cannot be in the past. Please select today or a future date.');
    document.getElementById('daycareDate').value = '';
    refreshContinueBtn();
    return;
  }
  var dow  = new Date(d + 'T00:00:00').getDay();
  var loc  = booking.location;
  var startH, endH;
  if (loc === 'estancia') {
    var isWd = dow >= 1 && dow <= 4;
    startH = isWd ? 11 : 10; endH = isWd ? 21 : 22;
  } else { startH = 10; endH = 22; }
  var opts = '<option value="">Select time</option>';
  for (var h = startH; h <= endH; h++) {
    var lbl = h < 12 ? h+':00 AM' : (h===12?'12:00 PM':(h-12)+':00 PM');
    opts += '<option value="' + h + '">' + lbl + '</option>';
  }
  document.getElementById('daycareDropoff').innerHTML = opts;
  // Pickup includes Open Time
  var pOpts = '<option value="">Select time</option><option value="open">Open time (base rate only)</option>';
  for (var h2 = startH; h2 <= endH; h2++) {
    var lbl2 = h2 < 12 ? h2+':00 AM' : (h2===12?'12:00 PM':(h2-12)+':00 PM');
    pOpts += '<option value="' + h2 + '">' + lbl2 + '</option>';
  }
  document.getElementById('daycarePickup').innerHTML = pOpts;
  document.getElementById('daycareTimesSection').style.display = 'block';
  calcDaycareTotal();
  refreshContinueBtn();
  autoScroll('daycareTimesSection');
}
// ── STUDIO DATE + SLOT AVAILABILITY ──
function onStudioDateChange() {
  var val = document.getElementById('studioDate').value;
  if (!val) { refreshContinueBtn(); return; }
  if (val < localDateStr()) {
    alert('Studio date cannot be in the past. Please select today or a future date.');
    document.getElementById('studioDate').value = '';
    booking.studioSlot = null;
    refreshContinueBtn();
    return;
  }
  // Clear previously selected slot and reload availability
  booking.studioSlot = null;
  document.querySelectorAll('#studioSlots .timeslot').forEach(function(t) {
    t.classList.remove('selected', 'unavailable');
    t.style.opacity = ''; t.style.cursor = '';
  });
  loadStudioSlots();
  refreshContinueBtn();
}

async function loadStudioSlots() {
  var dateVal = document.getElementById('studioDate').value;
  if (!dateVal) return;
  var grid = document.getElementById('studioSlots');
  if (!grid) return;

  var STUDIO_DURATION = 60; // 1-hour session
  var ALL_SLOTS = ['10:00 AM','10:30 AM','11:00 AM','11:30 AM','12:00 PM','12:30 PM',
    '1:00 PM','1:30 PM','2:00 PM','2:30 PM','3:00 PM','3:30 PM',
    '4:00 PM','4:30 PM','5:00 PM','5:30 PM','6:00 PM','6:30 PM',
    '7:00 PM','7:30 PM','8:00 PM','8:30 PM','9:00 PM'];
  var dow = new Date(dateVal + 'T00:00:00').getDay();

  // Show loading state
  grid.innerHTML = '<p style="font-size:12px;color:var(--mid);padding:8px 0">Checking availability…</p>';

  var studioPool = liveStudios.filter(function(s) { return !s.is_unavailable; });

  var bookingRows = [];
  var blockRows   = [];

  try {
    var branchId = await getSelectedBranchId();
    if (!branchId || !studioPool.length) throw new Error('missing_context');

    // 1. All studio bookings on this date at this branch
    var bkRows = await sbFetchPublic('bookings',
      'select=id&branch_id=eq.' + branchId +
      '&service=eq.studio&booking_date=eq.' + dateVal +
      '&status=not.in.(cancelled,rejected)');

    if (bkRows && bkRows.length) {
      var ids = bkRows.map(function(r){ return r.id; }).join(',');
      // 2. Get studio_details for those bookings (studio_id + timeslot)
      bookingRows = await sbFetchPublic('studio_details',
        'select=studio_id,timeslot&booking_id=in.(' + ids + ')') || [];
    }

    // 3. One-off blocked_schedules for studio resources on this date
    var sids = studioPool.map(function(s){ return s.id; }).join(',');
    try {
      blockRows = await sbFetchPublic('blocked_schedules',
        'select=resource_id,start_time,end_time' +
        '&resource_type=eq.studio&active=eq.true' +
        '&dates=cs.{' + dateVal + '}' +
        '&resource_id=in.(' + sids + ')') || [];
    } catch(e) { blockRows = []; }

  } catch(e) {
    console.warn('Studio slot availability check failed, showing all slots:', e);
    grid.innerHTML = ALL_SLOTS.map(function(s) {
      return '<div class="timeslot" onclick="selectSlot(this)">' + s + '</div>';
    }).join('');
    return;
  }

  function parseTM(t) {
    var m = (t||'').match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (!m) return -1;
    var h = parseInt(m[1]), min = parseInt(m[2]), ap = m[3] ? m[3].toUpperCase() : null;
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  }

  function overlaps(ranges, s, e) {
    return ranges.some(function(r){ return s < r.end && e > r.start; });
  }

  function rangesFor(studioId) {
    var ranges = [];
    // Confirmed bookings
    bookingRows.filter(function(r){ return r.studio_id === studioId && r.timeslot; }).forEach(function(r) {
      var st = parseTM(r.timeslot);
      if (st >= 0) ranges.push({ start: st, end: st + STUDIO_DURATION });
    });
    // Recurring studio blocks
    getStudioBlocksForDay(studioId, dow).forEach(function(bl) {
      var st = parseTM(bl.start_time), en = parseTM(bl.end_time);
      if (st >= 0 && en > st) ranges.push({ start: st, end: en });
    });
    // One-off blocked_schedules
    blockRows.filter(function(b){ return b.resource_id === studioId; }).forEach(function(b) {
      var st = parseTM(b.start_time), en = parseTM(b.end_time);
      if (st >= 0 && en > st) ranges.push({ start: st, end: en });
    });
    return ranges;
  }

  grid.innerHTML = ALL_SLOTS.map(function(slot) {
    var candStart = parseTM(slot);
    var candEnd   = candStart + STUDIO_DURATION;
    var available = studioPool.some(function(s) {
      return !overlaps(rangesFor(s.id), candStart, candEnd);
    });
    if (available) {
      return '<div class="timeslot" onclick="selectSlot(this)">' + slot + '</div>';
    } else {
      return '<div class="timeslot unavailable" style="cursor:not-allowed">' + slot + '</div>';
    }
  }).join('');

  // Re-highlight previously selected slot if still available
  if (booking.studioSlot) {
    grid.querySelectorAll('.timeslot:not(.unavailable)').forEach(function(t) {
      if (t.textContent.trim() === booking.studioSlot) t.classList.add('selected');
    });
  }
}

function calcDaycareTotal() {
  var dropVal = document.getElementById('daycareDropoff').value;
  var pickVal = document.getElementById('daycarePickup').value;
  var base    = booking.daycareBaseRate || 0;
  var el      = document.getElementById('daycarePriceTotal');
  if (!dropVal || !pickVal || !base) { el.style.display = 'none'; return; }
  if (pickVal === 'open') {
    booking.daycareOpenTime = true;
    booking.daycareTotal = base;
    document.getElementById('daycareTotalVal').textContent = '\u20b1' + base.toLocaleString();
    el.style.display = 'flex';
    updateNavTotal();
    return;
  }
  booking.daycareOpenTime = false;
  var dropH = parseInt(dropVal);
  var pickH = parseInt(pickVal);
  if (pickH <= dropH) { el.style.display = 'none'; return; }
  var hours   = pickH - dropH;
  var extra   = Math.max(0, hours - 3);
  var subtotal = base + extra * (DAYCARE_EXTRA_RATES[booking.petSize] || 100);
  booking.daycareDropoffHour = dropH;
  booking.daycarePickupHour  = pickH;
  booking.daycareTotal = subtotal;
  var discount = booking.memberValid ? Math.round(subtotal * MEMBER_DISCOUNT.daycare) : 0;
  var total    = subtotal - discount;
  var html = '\u20b1' + total.toLocaleString();
  if (discount > 0) html = '<span style="text-decoration:line-through;opacity:0.5;font-size:14px">\u20b1' + subtotal.toLocaleString() + '</span> \u20b1' + total.toLocaleString();
  html += '<span style="font-size:11px;display:block;color:var(--mid);margin-top:2px">' + hours + ' hour' + (hours!==1?'s':'') + (extra>0?' (base + '+extra+' extra hr'+(extra>1?'s':'')+')'  :'') + '</span>';
  document.getElementById('daycareTotalVal').innerHTML = html;
  el.style.display = 'flex';
  updateNavTotal();
}

// ── PET DETAILS ──
function selectAnimalType(el, val) {
  document.querySelectorAll('#petTypeGroup .gender-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.petAnimal = val;
  renderVaccines();
  refreshContinueBtn();
  autoScroll('petGenderGrid');
}
function selectGender(el, val) {
  document.querySelectorAll('#petGenderGrid .gender-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.petGender = val;
  refreshContinueBtn();
  autoScroll('petBreed');
}
function selectTemperament(el, val) {
  document.querySelectorAll('.temp-btn').forEach(function(b){b.classList.remove('selected');});
  el.classList.add('selected');
  booking.petTemperament = val;
  refreshContinueBtn();
  autoScroll('vaccineSection');
}
function checkSeniorWaiver() {
  var ageVal  = parseInt(document.getElementById('petAgeNum').value) || 0;
  var ageUnit = document.getElementById('petAgeUnit').value;
  var medical = document.getElementById('petMedical').value.trim();
  var isSenior = (ageUnit === 'years' && ageVal >= 6);
  var show = isSenior || medical.length > 0;
  document.getElementById('seniorWaiverRow').style.display = show ? 'flex' : 'none';
}
function renderVaccines() {
  var animal = booking.petAnimal || 'dog';
  var dogV = ['Anti-rabies','5/6/8-in-1 shot','Kennel Cough / Bordetella','Tick and Flea treatment'];
  var catV = ['Anti-rabies','All-in-1 shot','Anti-parasitic'];
  var list = animal === 'cat' ? catV : dogV;
  document.getElementById('vaccineGrid').innerHTML = list.map(function(v) {
    var key = v.replace(/[^a-z0-9]/gi,'_');
    var isChecked = booking.vaccines[key] ? ' checked' : '';
    return '<div class="vacc-row' + isChecked + '" onclick="toggleVaccine(this,\'' + key + '\')">' +
      '<div class="vacc-box"></div>' +
      '<span class="vacc-label">' + v + '</span>' +
      '</div>';
  }).join('');
}
function toggleVaccine(el, key) {
  el.classList.toggle('checked');
  booking.vaccines[key] = el.classList.contains('checked');
}
function handleVaccineFiles(input) {
  var list = document.getElementById('vaccineFileList');
  for (var i = 0; i < input.files.length; i++) {
    (function(file) {
      uploadedVaccineFiles.push(file);
      var item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = '&#128206; ' + file.name + '<span class="file-remove" onclick="removeVaccineFile(this,\'' + file.name + '\')">x</span>';
      list.appendChild(item);
    })(input.files[i]);
  }
}
function removeVaccineFile(el, name) {
  uploadedVaccineFiles = uploadedVaccineFiles.filter(function(f){return f.name!==name;});
  el.closest('.file-item').remove();
}

// ── MEMBERSHIP ──
function onSourceChange() {
  var val = document.getElementById('ownerSource').value;
  var el = document.getElementById('ownerSourceOther');
  if (!el) return;
  el.style.display = val === 'Other' ? '' : 'none';
  if (val !== 'Other') el.value = '';
}

function setMembership(val) {
  booking.isMember = val;
  document.getElementById('memberYes').classList.toggle('selected', val);
  document.getElementById('memberNo').classList.toggle('selected', !val);
  document.getElementById('memberIdSection').style.display = val ? 'block' : 'none';
  if (!val) {
    booking.memberValid = false;
    booking.membershipId = null;
    document.getElementById('membershipId').value = '';
    document.getElementById('memberValidMsg').style.display = 'none';
    refreshAllTotals();
  }
  refreshContinueBtn();
}
var _petNameDebounce   = null;
var _memberIdDebounce  = null;

// Called on every keystroke in the Membership ID field.
// Immediately invalidates any prior successful check, then re-validates after 600 ms.
function onMembershipIdInput() {
  refreshContinueBtn();
  var idInput = (document.getElementById('membershipId') || {}).value || '';
  if (idInput.trim().length < 4) {
    // Too short to be a valid ID — just clear any stale validation state
    booking.memberValid = false;
    var msg = document.getElementById('memberValidMsg');
    if (msg) msg.style.display = 'none';
    refreshAllTotals();
    return;
  }
  // Invalidate immediately so the discount can't persist while retyping
  if (booking.memberValid) {
    booking.memberValid = false;
    var msg = document.getElementById('memberValidMsg');
    if (msg) {
      msg.style.display = 'block';
      msg.textContent = 'Re-checking membership…';
      msg.style.color = 'var(--mid)';
    }
    refreshAllTotals();
    refreshContinueBtn();
  }
  clearTimeout(_memberIdDebounce);
  _memberIdDebounce = setTimeout(function() { validateMemberId(); }, 600);
}

function onPetNameInput() {
  refreshContinueBtn();
  var idInput = (document.getElementById('membershipId') || {}).value || '';
  if (idInput.trim().length < 4) return; // no membership ID entered — nothing to do
  // Invalidate immediately so the user can't slip through while retyping
  if (booking.memberValid) {
    booking.memberValid = false;
    var msg = document.getElementById('memberValidMsg');
    if (msg) {
      msg.style.display = 'block';
      msg.textContent = 'Re-checking membership…';
      msg.style.color = 'var(--mid)';
    }
    refreshAllTotals();
    refreshContinueBtn();
  }
  // Debounce: re-run validation 600 ms after the user stops typing
  clearTimeout(_petNameDebounce);
  _petNameDebounce = setTimeout(function() { validateMemberId(); }, 600);
}

async function validateMemberId() {
  var idInput  = document.getElementById('membershipId').value.trim().toUpperCase();
  var petInput = (document.getElementById('petName') ? document.getElementById('petName').value : '').trim().replace(/\s+/g,' ').toLowerCase();
  var msg = document.getElementById('memberValidMsg');
  if (idInput.length < 4) { msg.style.display = 'none'; booking.memberValid = false; refreshAllTotals(); return; }
  // Require pet name to be filled before validating \u2014 the check is pet-name-bound
  if (!petInput) {
    msg.style.display = 'block';
    msg.textContent = 'Please enter your pet\u2019s name above first, then verify.';
    msg.style.color = 'var(--error)';
    booking.memberValid = false;
    refreshAllTotals();
    return;
  }
  msg.style.display = 'block'; msg.textContent = 'Validating\u2026'; msg.style.color = 'var(--mid)';
  try {
    // Validate via RPC \u2014 members/owners/pets tables are not directly readable by anon
    var member = await sbRpcPublic('validate_member', { p_code: idInput });
    if (!member || !member.member_code) {
      msg.textContent = 'Member ID not found.'; msg.style.color = 'var(--error)';
      booking.memberValid = false;
    } else {
      // Build petList from pet_name (singular \u2014 current members table schema).
      // Falls back to pet_names array in case the RPC is ever updated to return multiple pets.
      var petList = [];
      if (Array.isArray(member.pet_names) && member.pet_names.length > 0) {
        petList = member.pet_names.map(function(n) { return (n||'').trim().replace(/\s+/g,' ').toLowerCase(); });
      } else if (member.pet_name) {
        petList = [(member.pet_name||'').trim().replace(/\s+/g,' ').toLowerCase()];
      }
      if (petList.length === 0 || petList.indexOf(petInput) === -1) {
        msg.textContent = 'Pet name doesn\u2019t match this membership. Please check the name or ID.';
        msg.style.color = 'var(--error)';
        booking.memberValid = false;
      } else {
        booking.memberValid = true; booking.membershipId = idInput;
        var disc = Math.round((MEMBER_DISCOUNT[booking.service]||0)*100);
        msg.textContent = 'Member verified' + (disc ? ' \u2014 ' + disc + '% discount applied' : '') + ' \u2713';
        msg.style.color = 'var(--success)';
      }
    }
  } catch(e) {
    msg.textContent = 'Could not verify membership. Please try again.'; msg.style.color = 'var(--error)';
    booking.memberValid = false;
  }
  refreshAllTotals();
  refreshContinueBtn();
}
function refreshAllTotals() {
  var svc = booking.service;
  if (svc === 'grooming') updateGroomTotal();
  if (svc === 'hotel') calcHotelTotal();
  else if (svc === 'daycare') calcDaycareTotal();
  updateNavTotal();
}

// ── MISC ──
function selectLocation_noop() {}
function selectPlaypark(el, val) {
  document.getElementById('playparkYes').classList.remove('selected');
  document.getElementById('playparkNo').classList.remove('selected');
  el.classList.add('selected');
  booking.playparkConsent = val;
}
function toggleCheck(id) { document.getElementById(id).classList.toggle('checked'); refreshContinueBtn(); }
function toggleSave() { saveDetails = !saveDetails; document.getElementById('saveToggle').classList.toggle('on', saveDetails); }

// ── COLLECT ──
function collectStep(step) {
  if (step === 3) {
    booking.groomDate   = document.getElementById('groomDate').value;
    booking.hotelCheckin = document.getElementById('hotelCheckin').value;
    booking.hotelCheckout = document.getElementById('hotelCheckout').value;
    booking.daycareDate = document.getElementById('daycareDate').value;
    booking.studioDate  = document.getElementById('studioDate').value;
  }
  if (step === 5) {
    booking.petName   = document.getElementById('petName').value;
    booking.petBreed  = document.getElementById('petBreed').value;
    booking.petAge    = document.getElementById('petAgeNum').value;
    booking.petAgeUnit = document.getElementById('petAgeUnit').value;
    booking.petMedical = document.getElementById('petMedical').value;
    // petSize already set from step 3 for grooming/hotel/daycare; only read select for studio
    if (!booking.petSize) {
      var sel = document.getElementById('petSizeSelect');
      if (sel && sel.value) booking.petSize = sel.value;
    }
  }
  if (step === 6) {
    booking.ownerFirst = document.getElementById('ownerFirst').value;
    booking.ownerLast  = document.getElementById('ownerLast').value;
    booking.ownerEmail = document.getElementById('ownerEmail').value;
    booking.ownerPhone = document.getElementById('ownerPhone').value;
    if (saveDetails) {
      try { localStorage.setItem('barkhaus_owner', JSON.stringify({ first:booking.ownerFirst, last:booking.ownerLast, email:booking.ownerEmail, phone:booking.ownerPhone })); } catch(e) {}
    } else {
      try { localStorage.removeItem('barkhaus_owner'); } catch(e) {}
    }
  }
}

// ── VALIDATE ──
// ── VALIDATION (per-step) ──

// ── COLLECT ALL STATE ──
function collectAllState() {
  var g    = function(id) { var el=document.getElementById(id); return el ? el.value : ''; };
  var gOpt = function(id) { var el=document.getElementById(id); return (el&&el.options[el.selectedIndex]) ? el.options[el.selectedIndex].text : ''; };
  booking.groomDate      = g('groomDate')      || null;
  booking.hotelCheckin   = g('hotelCheckin')   || null;
  booking.hotelCheckout  = g('hotelCheckout')  || null;
  booking.daycareDate    = g('daycareDate')    || null;
  booking.studioDate     = g('studioDate')     || null;
  booking.hotelDropoffTime   = g('hotelDropoffTime');
  booking.hotelPickupTime    = gOpt('hotelPickupTime');
  booking.hotelFeeding       = g('hotelFeeding');
  booking.hotelMeds          = g('hotelMeds');
  booking.vetClinic          = g('vetClinic');
  booking.vetContact         = g('vetContact');
  booking.vetAddress         = g('vetAddress');
  booking.emergencyName      = g('emergencyName');
  booking.emergencyPhone     = g('emergencyPhone');
  booking.daycareDropoffText = gOpt('daycareDropoff');
  booking.daycarePickupText  = gOpt('daycarePickup');
  booking.daycareNotes       = g('daycareNotes');
  booking.groomNotes         = g('groomNotes');
  booking.petName    = g('petName')    || null;
  booking.petBreed   = g('petBreed')   || null;
  booking.petAge     = g('petAgeNum')  || null;
  booking.petAgeUnit = g('petAgeUnit') || null;
  booking.petMedical = g('petMedical');
  booking.ownerFirst  = g('ownerFirst');
  booking.ownerLast   = g('ownerLast');
  booking.ownerEmail  = g('ownerEmail');
  booking.ownerPhone  = g('ownerPhone');
  var rawSource = g('ownerSource');
  booking.ownerSource = rawSource === 'Other' ? ('Other: ' + (g('ownerSourceOther').trim() || 'Other')) : rawSource;
}

// ── SUMMARY ──
function buildWaiverTexts() {
  var svc = booking.service;
  var texts = {};
  var WAIVER_TEXT = {
    grooming: 'I, the undersigned, hereby acknowledge that I am the legal owner or authorized agent of the pet listed and authorize Barkhaus to perform grooming services as requested. I understand that Barkhaus will use all reasonable precautions to ensure my pet\'s safety and comfort during the grooming process. I confirm that my pet is current on all required vaccinations, including anti-rabies. I understand that while my dog is fully vaccinated, vaccines are not 100% foolproof and there is still a minimal risk that my dog may contract a contagious virus/disease. I agree that this may occur. I have disclosed all known medical conditions, allergies, sensitivities, and/or behavioral issues that may affect the grooming process. I understand that grooming may expose hidden medical conditions, such as skin irritations, parasites, or lumps, and Barkhaus is not liable for any pre-existing or discovered health conditions. I acknowledge that young, senior, or pets with pre-existing conditions may be at higher risk during grooming. I waive any claims against Barkhaus should a health issue arise or worsen during or after the session. I certify that my pet has not shown aggression toward people or other animals unless otherwise disclosed. I understand that if my pet becomes aggressive or unmanageable, Barkhaus may stop or modify services at their discretion. I acknowledge the risk of skin irritation, nicks, or cuts due to matting and agree not to hold Barkhaus responsible for resulting issues. I understand that Barkhaus will attempt to notify me before significant shaving but may proceed if necessary. While Barkhaus takes every precaution, grooming involves sharp tools and moving animals and accidents can happen. I agree that Barkhaus shall not be held liable for any injury or condition arising during or after grooming, provided reasonable care was taken. In case of emergency, Barkhaus will attempt to contact me. If unreachable and my pet needs urgent care, I authorize Barkhaus to seek veterinary services at their discretion and I accept full responsibility for all veterinary charges. I hereby release and hold harmless Barkhaus, its owners, staff, and affiliates from any and all claims arising from grooming services provided. I certify that I have read, understood, and voluntarily agree to these terms. This waiver shall remain in effect for all future grooming appointments unless revoked in writing.',
    daycare: 'I confirm that I am the owner of the pet or have been authorized by the owner to take responsibility for the pet. In the event that I am unable to pick up my dog as scheduled, I acknowledge Barkhaus\' prerogative to extend my dog\'s stay for additional hours or days, subject to corresponding charges. I certify that my dog is in good health. In the event of a medical emergency and I am unreachable, I authorize Barkhaus staff to contact my veterinarian or any available veterinarian and seek necessary medical attention. Should I refuse Barkhaus\' recommendation to seek immediate care, I release Barkhaus from any liability arising from such decision. I confirm that my pet has complete and updated vaccinations and is free from fleas and any communicable diseases. I understand that vaccines are not 100% effective and that there remains a minimal risk of contracting illness, which I fully accept. I understand that dogs in heat are not allowed to interact with other dogs. By signing this waiver, I acknowledge that my dog may interact with other dogs, and I accept full responsibility if my dog is found to be in heat during its stay, including any consequences such as accidental breeding. I release Barkhaus and its staff from any related liability. I acknowledge that participation in Barkhaus play park activities is at my own risk. I understand that risks such as injury to my dog, other dogs, or individuals may still occur despite proper supervision. I agree that if my dog causes injury to another dog or person, I will assume full responsibility and release Barkhaus from any related liability. I hereby voluntarily release, discharge, and agree to indemnify and hold harmless Barkhaus from any and all claims arising from my participation or my dog\'s participation in any Barkhaus activities. I certify that I have read, understood, and agree to abide by all Barkhaus rules and regulations. I confirm all information provided is true and accurate, and that I am at least eighteen (18) years of age. I understand that while Barkhaus screens all dogs, not all dogs may be suitable for daycare. Barkhaus reserves the right to remove any dog at its discretion. In such cases, daycare packages are non-refundable but may be transferred. I grant Barkhaus permission to use any photos or videos of me and my pet taken within the facility for promotional, marketing, and social media purposes. By signing this agreement, I acknowledge and accept all house rules set by Barkhaus. I understand and agree that if my dog remains at Barkhaus for three (3) days or more with an unsettled bill and without any communication from me, my dog will be considered abandoned. In such cases, I relinquish ownership rights, and Barkhaus reserves the right to place the dog for adoption or appropriate care.',
    hotel: 'I confirm that I am the legal owner of the pet or have been authorized by the owner to take responsibility for the pet. In the event that I am unable to pick up my pet as scheduled, I acknowledge Barkhaus\' prerogative to extend my pet\'s stay for additional hours or days, subject to corresponding charges. I acknowledge that while my pet may be healthy upon check-in, illness may still occur during their stay. In the event of an emergency where I am unreachable, I authorize Barkhaus to bring my pet to a veterinary clinic for immediate care. All major medical decisions will require my consent when possible, and all related expenses shall be my responsibility. I release Barkhaus from any liability, recognizing that illness may occur, particularly in enclosed air-conditioned environments, especially for pets not accustomed to such conditions. I confirm that my pet has complete and updated vaccinations and is free from fleas and any communicable diseases. I understand that vaccines are not 100% foolproof and that there remains a minimal risk of contracting illness, which I fully accept. I understand that dogs in heat are not permitted to interact with other dogs. By signing this waiver, I acknowledge that my dog may interact with other dogs and accept full responsibility if my dog is found to be in heat during her stay, including any consequences such as accidental breeding. I release Barkhaus and its staff from all related liability. By signing below, I acknowledge and agree to all house rules set by Barkhaus. I understand that if my dog remains at Barkhaus for fifteen (15) days or more with an unsettled bill and without communication, my dog will be considered abandoned, and Barkhaus reserves the right to place the dog for adoption or appropriate care.',
    playpark: 'I acknowledge that by allowing my dog to use the Barkhaus play park, there are inherent risks involved. Despite proper supervision, I understand that injuries to my dog, other dogs, or individuals may still occur, and I accept these risks. I agree that if my dog causes any injury to other dogs or individuals, I will assume full responsibility and release Barkhaus from any related liability. I hereby voluntarily release, forever discharge, and agree to indemnify and hold harmless Barkhaus from any and all claims arising from my dog\'s participation in any activities, including the use of Barkhaus facilities and equipment, even in cases alleging negligence. Barkhaus reserves the right to refuse or permanently remove any dog from daycare if deemed unsuitable. In such cases, daycare packages are non-refundable but may be transferred. I certify that I have read, understood, and agree to abide by all terms and policies. I confirm all information provided is true and accurate, and that I am at least eighteen (18) years of age.',
    vaccine: 'I acknowledge and agree that my dog may acquire illnesses or diseases due to outdated or incomplete vaccinations, and that even with complete and updated vaccinations, there remains a minimal risk of contracting illness. I will not hold Barkhaus liable for any such occurrences.',
    senior: 'I, the undersigned, acknowledge that I am leaving my dog, who is a senior dog and/or has pre-existing medical conditions, in the care of Barkhaus. I am aware that senior dogs and dogs with existing medical conditions may be at increased risk for health complications, including sudden illness or death, especially in a boarding environment. In the event of a medical emergency, Barkhaus will make every reasonable effort to contact me. If I cannot be reached, I authorize Barkhaus to seek immediate veterinary care at their discretion, and I agree to be responsible for all costs incurred. I have disclosed all known medical conditions, medications, and special care instructions for my dog. I agree that Barkhaus may charge Special Handling Fees due to my dog\'s age and/or pre-existing condition(s). I understand that Barkhaus reserves the right to limit my dog\'s access to the play park and/or exposure to other dogs in the interest of my dog\'s well-being. I release Barkhaus from any liability related to the worsening of any existing conditions or the occurrence of age-related complications during or after the stay. I hereby voluntarily release, forever discharge, and agree to indemnify and hold harmless Barkhaus, its staff, owners, and affiliates, from any and all claims arising out of or connected with the services provided, including those involving negligent acts or omissions.',
    media: 'I consent to Barkhaus taking photographs or videos of my pet during grooming for promotional use, including social media and marketing materials.',
  };
  texts.general  = WAIVER_TEXT[svc] || '';
  texts.vaccine  = WAIVER_TEXT.vaccine;
  texts.media    = WAIVER_TEXT.media;
  if (booking.playparkConsent) texts.playpark = WAIVER_TEXT.playpark;
  var seniorSec = document.getElementById('seniorWaiverSection');
  if (seniorSec && seniorSec.style.display !== 'none') texts.senior = WAIVER_TEXT.senior;
  return texts;
}
function buildSummary() {
  collectAllState();
  var svc = booking.service;
  var locLabels = { estancia:'Estancia (Pasig)', eastwood:'Eastwood (QC)' };
  var svcLabels = { grooming:'Grooming', hotel:'Pet Hotel', daycare:'Daycare', studio:'Self-Shoot Studio' };
  var tempLabels = { friendly_all:'Friendly with all', friendly_shy:'Friendly but shy', selective:'Selective', reactive:'Reactive', first_time:'First time' };
  var schedStr = '';
  if (svc === 'grooming') schedStr = (booking.groomDate||'-') + ' at ' + (booking.groomSlot||'-');
  else if (svc === 'hotel') schedStr = 'Check-in: ' + (booking.hotelCheckin||'-') + ' / Check-out: ' + (booking.hotelCheckout||'-');
  else if (svc === 'daycare') schedStr = booking.daycareDate || '-';
  else if (svc === 'studio') schedStr = (booking.studioDate||'-') + ' at ' + (booking.studioSlot||'-');
  // \u2500\u2500 Build grouped summary \u2500\u2500
  var groups = [];
  function grp(title) { var g={title:title,rows:[]}; groups.push(g); return g; }
  function row(g,k,v) { g.rows.push([k,v]); }

  // Group 1: Booking
  var gBook = grp('Booking');
  row(gBook,'Branch', locLabels[booking.location]||'-');
  row(gBook,'Service', svcLabels[svc]||'-');

  // Group 2: Schedule
  var gSched = grp('Schedule');
  row(gSched,'Schedule', schedStr||'-');
  if (svc === 'hotel') {
    if (booking.hotelRoomName) row(gSched,'Room', booking.hotelRoomName);
    else if (booking.hotelRoomType) row(gSched,'Room', ROOM_LABELS[booking.hotelRoomType] || booking.hotelRoomType.replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();}));
    if (booking.hotelDropoffTime) {
      var dH = parseInt(booking.hotelDropoffTime);
      var dLabel = dH < 12 ? dH+':00 AM' : (dH===12?'12:00 PM':(dH-12)+':00 PM');
      row(gSched,'Drop-off time', dLabel);
    }
    if (booking.hotelPickupTime) row(gSched,'Pick-up time', booking.hotelPickupTime);
    if (booking.petSize !== 'cat') row(gSched,'Play park', booking.playparkConsent === 'yes' ? 'Yes' : 'No');
  }
  if (svc === 'grooming' && booking.groomService) {
    var svcSpec = GROOM_SERVICES.find(function(s){return s.key===booking.groomService;});
    if (svcSpec) row(gSched,'Grooming service', svcSpec.name);
    var addonNames = Object.keys(booking.selectedAddons).map(function(k) {
      var a = ADDONS.find(function(x){return x.key===k;}); return a ? a.name : k;
    });
    if (addonNames.length) row(gSched,'Add-ons', addonNames.join(', '));
    if (booking.preferredStylist && booking.preferredStylist !== 'any') row(gSched,'Groomer', booking.preferredStylist);
    if (booking.groomNotes) row(gSched,'Grooming notes', booking.groomNotes);
  }
  if (svc === 'daycare') {
    if (booking.daycareOpenTime) {
      row(gSched,'Drop-off', 'Open time'); row(gSched,'Pick-up', 'Open time');
    } else if (booking.daycareDropoffText || booking.daycareDropoffHour) {
      row(gSched,'Drop-off', booking.daycareDropoffText || (booking.daycareDropoffHour+':00'));
      row(gSched,'Pick-up',  booking.daycarePickupText  || (booking.daycarePickupHour+':00'));
    }
    if (booking.daycareNotes) row(gSched,'Daycare notes', booking.daycareNotes);
  }

  // Group 3: Pet details
  var gPet = grp('Pet Details');
  row(gPet,'Name',        booking.petName||'-');
  row(gPet,'Animal',      booking.petAnimal ? (booking.petAnimal.charAt(0).toUpperCase()+booking.petAnimal.slice(1)) : '-');
  row(gPet,'Sex',         booking.petGender ? (booking.petGender.charAt(0).toUpperCase()+booking.petGender.slice(1)) : '-');
  row(gPet,'Breed',       booking.petBreed||'-');
  row(gPet,'Age',         booking.petAge ? (booking.petAge + ' ' + (booking.petAgeUnit||'')) : '-');
  row(gPet,'Size',        booking.petSize ? PET_SIZE_LABELS[booking.petSize] : '-');
  row(gPet,'Temperament', booking.petTemperament ? (tempLabels[booking.petTemperament]||booking.petTemperament) : '-');
  row(gPet,'Medical notes', booking.petMedical && booking.petMedical.trim() ? booking.petMedical.trim() : 'None');
  if (booking.memberValid && booking.membershipId) {
    row(gPet,'Membership', booking.membershipId + ' \u2713');
  } else {
    row(gPet,'Membership', 'None');
  }

  // Group 4: Health & Care
  var gHealth = grp('Health & Care');
  var vaccineFileCount = uploadedVaccineFiles ? uploadedVaccineFiles.length : 0;
  var bringVacc = document.getElementById('bringVaccines');
  var vaccStatus = vaccineFileCount > 0
    ? (vaccineFileCount + ' file' + (vaccineFileCount>1?'s':'') + ' uploaded')
    : (bringVacc && bringVacc.classList.contains('checked') ? 'Will bring to venue' : 'Not provided');
  row(gHealth,'Vaccine records', vaccStatus);
  if (svc === 'hotel') {
    if (booking.vetClinic || booking.vetContact) {
      row(gHealth,'Vet clinic',  booking.vetClinic||'-');
      row(gHealth,'Vet contact', booking.vetContact||'-');
      if (booking.vetAddress) row(gHealth,'Vet address', booking.vetAddress);
    }
    if (booking.emergencyName || booking.emergencyPhone) {
      row(gHealth,'Emergency contact', booking.emergencyName||'-');
      row(gHealth,'Emergency phone',   booking.emergencyPhone||'-');
    }
    if (booking.hotelFeeding) row(gHealth,'Feeding instructions', booking.hotelFeeding);
    if (booking.hotelMeds)    row(gHealth,'Medications', booking.hotelMeds);
  }

  // Group 5: Owner details
  var gOwner = grp('Owner Details');
  row(gOwner,'Name',   ((booking.ownerFirst||'')+' '+(booking.ownerLast||'')).trim()||'-');
  row(gOwner,'Email',  booking.ownerEmail||'-');
  row(gOwner,'Mobile', booking.ownerPhone||'-');

  function renderRow(r) {
    return '<div class="summary-row"><span class="summary-key">'+r[0]+'</span><span class="summary-val">'+r[1]+'</span></div>';
  }
  document.getElementById('bookingDetailsSummary').innerHTML = groups.map(function(g) {
    if (!g.rows.length) return '';
    return '<div class="summary-group"><div class="summary-group-title">'+g.title+'</div>' +
      g.rows.map(renderRow).join('') + '</div>';
  }).join('');
  // \u2500\u2500 Price breakdown \u2500\u2500
  var lines = [];
  var subtotal = 0;
  if (svc === 'grooming') {
    if (booking.groomService) {
      var svcObj = GROOM_SERVICES.find(function(s){return s.key===booking.groomService;});
      if (svcObj && booking.groomServicePrice > 0) {
        lines.push({ label:svcObj.name, val:'\u20b1'+booking.groomServicePrice.toLocaleString(), amount:booking.groomServicePrice });
        subtotal += booking.groomServicePrice;
      } else if (svcObj && booking.groomService === 'ala_carte') {
        lines.push({ label:'Ala Carte', val:'\u20b10', amount:0 });
      }
    }
    Object.keys(booking.selectedAddons).forEach(function(k) {
      var addon = ADDONS.find(function(a){return a.key===k;});
      if (!addon) return;
      if (addon.assessment) {
        lines.push({ label:addon.name, val:'for assessment', amount:0, assess:true });
      } else {
        var p = booking.selectedAddons[k];
        lines.push({ label:'Add-on \u2014 '+addon.name, val:'\u20b1'+p.toLocaleString(), amount:p });
        subtotal += p;
      }
    });
  } else if (svc === 'hotel') {
    var cin  = booking.hotelCheckin;
    var cout = booking.hotelCheckout;
    if (cin && cout) {
      var room = booking.hotelRoomType || 'small_cage';
      var rateSize = CAGE_RATE_SIZE[room] || booking.petSize || 'small_dog';
      var roomLabel = booking.hotelRoomName || ROOM_LABELS[room] || room.replace(/_/g,' ');
      var totalNights = Math.round((new Date(cout+' 00:00:00') - new Date(cin+' 00:00:00')) / 86400000);
      var wdCount = 0, weCount = 0, wdTotal = 0, weTotal = 0;
      for (var i = 0; i < totalNights; i++) {
        var d = new Date(cin + ' 00:00:00'); d.setDate(d.getDate() + i);
        var dow = d.getDay();
        var isWe = (dow === 0 || dow === 5 || dow === 6);
        if (isWe) { weCount++; weTotal += HOTEL_RATES.weekend[rateSize]||0; }
        else       { wdCount++; wdTotal += HOTEL_RATES.weekday[rateSize]||0; }
      }
      if (wdCount > 0) {
        var wdRate = HOTEL_RATES.weekday[rateSize]||0;
        lines.push({ label: wdCount+' weekday night'+(wdCount!==1?'s':'')+' \u00d7 \u20b1'+wdRate.toLocaleString()+' ('+roomLabel+')', val:'\u20b1'+wdTotal.toLocaleString(), amount:wdTotal });
        subtotal += wdTotal;
      }
      if (weCount > 0) {
        var weRate = HOTEL_RATES.weekend[rateSize]||0;
        lines.push({ label: weCount+' weekend/holiday night'+(weCount!==1?'s':'')+' \u00d7 \u20b1'+weRate.toLocaleString()+' ('+roomLabel+')', val:'\u20b1'+weTotal.toLocaleString(), amount:weTotal });
        subtotal += weTotal;
      }
    }
    if (booking.hotelLateTotal > 0) {
      lines.push({ label:'Late pickup fee', val:'\u20b1'+booking.hotelLateTotal.toLocaleString(), amount:booking.hotelLateTotal });
      subtotal += booking.hotelLateTotal;
    }
  } else if (svc === 'daycare') {
    var dH = booking.daycareDropoffHour;
    var pH = booking.daycarePickupHour;
    var hrs = booking.daycareOpenTime ? 'Open time' : (pH - dH) + ' hour' + ((pH-dH)!==1?'s':'');
    lines.push({ label:'Daycare ('+hrs+')', val:'\u20b1'+booking.daycareTotal.toLocaleString(), amount:booking.daycareTotal });
    subtotal += booking.daycareTotal;
  }
  var html = lines.map(function(l) {
    return '<div class="price-line component">' +
      '<span class="price-line-label">'+l.label+'</span>' +
      '<span class="price-line-val'+(l.assess?' assess':'')+'">'+l.val+'</span>' +
      '</div>';
  }).join('');
  if (subtotal > 0) {
    var discRate = booking.memberValid ? (MEMBER_DISCOUNT[svc]||0) : 0;
    var discAmt  = Math.round(subtotal * discRate);
    var total    = subtotal - discAmt + CONVENIENCE_FEE;
    // Always show subtotal when there are components so the hierarchy is clear
    html += '<div class="price-line subtotal-line"><span class="price-line-label">Subtotal</span><span class="price-line-val">\u20b1'+subtotal.toLocaleString()+'</span></div>';
    if (discAmt > 0) {
      var discPct = Math.round(discRate * 100);
      html += '<div class="price-line"><span class="price-line-label">Member discount ('+discPct+'%)</span><span class="price-line-val discount">-\u20b1'+discAmt.toLocaleString()+'</span></div>';
    }
    html += '<div class="price-line"><span class="price-line-label">Convenience fee</span><span class="price-line-val">\u20b1'+CONVENIENCE_FEE.toLocaleString()+'</span></div>';
    html += '<div class="price-line total-line"><span class="price-line-label">Total</span><span class="price-line-val">\u20b1'+total.toLocaleString()+'</span></div>';
  }
  document.getElementById('priceBreakdown').innerHTML = html || '<div class="price-line"><span class="price-line-label">No price estimate available</span><span class="price-line-val">-</span></div>';
}

// ── SHOW TOAST ──
function showToast(msg, duration) {
  var t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, duration || 3000);
}

// ── RENDER SUCCESS / PAY-RETURN DETAIL CARDS ──────────────────────────────────
// Mirrors buildSummary() but reads from the bk_snapshot saved before the
// PayMongo redirect. Renders all grouped sections + fully itemised pricing
// so the customer has a complete record of every detail they submitted.
function renderSuccessDetails(snap, detailsId, priceId) {
  if (!snap) return;
  var bk  = snap.bookingState || {};
  var svc = bk.service || '';

  // Store meta for printBooking() to use as the PDF filename
  window._printMeta = { branch: snap.location || '', service: snap.service || '' };

  var tempLabels = { friendly_all:'Friendly with all', friendly_shy:'Friendly but shy', selective:'Selective', reactive:'Reactive', first_time:'First time' };

  // ── grouped rows ──
  var groups = [];
  function grp(title) { var g = {title:title, rows:[]}; groups.push(g); return g; }
  function row(g, k, v) { if (v != null && v !== '' && v !== '-') g.rows.push([k, String(v)]); }

  var gBook = grp('Booking');
  row(gBook, 'Branch',  snap.location || '-');
  row(gBook, 'Service', snap.service  || '-');

  var gSched = grp('Schedule');
  row(gSched, 'Schedule', snap.schedule || '-');

  if (svc === 'hotel') {
    if (bk.hotelRoomName) row(gSched, 'Room', bk.hotelRoomName);
    else if (bk.hotelRoomType) row(gSched, 'Room', (ROOM_LABELS && ROOM_LABELS[bk.hotelRoomType]) || bk.hotelRoomType.replace(/_/g,' ').replace(/\b\w/g, function(c){return c.toUpperCase();}));
    if (bk.hotelDropoffTime) {
      var dH = parseInt(bk.hotelDropoffTime);
      row(gSched, 'Drop-off time', dH < 12 ? dH+':00 AM' : (dH===12?'12:00 PM':(dH-12)+':00 PM'));
    }
    if (bk.hotelPickupTime) row(gSched, 'Pick-up time', bk.hotelPickupTime);
    if (bk.petSize !== 'cat') row(gSched, 'Play park', bk.playparkConsent === 'yes' ? 'Yes, with consent' : 'No');
  }
  if (svc === 'grooming') {
    var groomSvcSpec = (GROOM_SERVICES||[]).find(function(s){return s.key===bk.groomService;});
    if (groomSvcSpec) row(gSched, 'Grooming service', groomSvcSpec.name);
    var addonList = snap.addons || [];
    if (addonList.length) row(gSched, 'Add-ons', addonList.join(', '));
    if (bk.preferredStylist && bk.preferredStylist !== 'any') row(gSched, 'Groomer', bk.preferredStylist);
    if (bk.groomNotes) row(gSched, 'Grooming notes', bk.groomNotes);
  }
  if (svc === 'daycare') {
    if (bk.daycareOpenTime) {
      row(gSched, 'Drop-off', 'Open time'); row(gSched, 'Pick-up', 'Open time');
    } else {
      if (bk.daycareDropoffText) row(gSched, 'Drop-off', bk.daycareDropoffText);
      if (bk.daycarePickupText)  row(gSched, 'Pick-up',  bk.daycarePickupText);
    }
    if (bk.daycareNotes) row(gSched, 'Daycare notes', bk.daycareNotes);
  }
  if (svc === 'studio') {
    if (bk.studioNotes) row(gSched, 'Notes', bk.studioNotes);
  }

  // Pet fields prefer the full bookingState, but fall back to the top-level
  // snapshot display fields (snap.petName/petBreed/petSize) so the screen still
  // renders if bookingState is missing (older/partial snapshots).
  var gPet = grp('Pet Details');
  row(gPet, 'Name',         bk.petName || snap.petName);
  if (bk.petAnimal) row(gPet, 'Animal', bk.petAnimal.charAt(0).toUpperCase()+bk.petAnimal.slice(1));
  if (bk.petGender) row(gPet, 'Sex',    bk.petGender.charAt(0).toUpperCase()+bk.petGender.slice(1));
  row(gPet, 'Breed', bk.petBreed || snap.petBreed);
  if (bk.petAge)  row(gPet, 'Age',  bk.petAge + ' ' + (bk.petAgeUnit||''));
  var petSizeVal = bk.petSize ? ((PET_SIZE_LABELS && PET_SIZE_LABELS[bk.petSize]) || bk.petSize) : snap.petSize;
  if (petSizeVal) row(gPet, 'Size', petSizeVal);
  if (bk.petTemperament) row(gPet, 'Temperament', tempLabels[bk.petTemperament]||bk.petTemperament);
  if (bk.petMedical && bk.petMedical.trim()) row(gPet, 'Medical notes', bk.petMedical.trim());
  if (bk.memberValid && bk.membershipId) row(gPet, 'Membership', bk.membershipId + ' ✓');

  var gHealth = grp('Health & Care');
  row(gHealth, 'Vaccine records', snap.vaccineStatus || 'Not provided');
  if (svc === 'hotel') {
    if (bk.vetClinic || bk.vetContact) {
      row(gHealth, 'Vet clinic',   bk.vetClinic);
      row(gHealth, 'Vet contact',  bk.vetContact);
      row(gHealth, 'Vet address',  bk.vetAddress);
    }
    if (bk.emergencyName || bk.emergencyPhone) {
      row(gHealth, 'Emergency contact', bk.emergencyName);
      row(gHealth, 'Emergency phone',   bk.emergencyPhone);
    }
    if (bk.hotelFeeding) row(gHealth, 'Feeding instructions', bk.hotelFeeding);
    if (bk.hotelMeds)    row(gHealth, 'Medications',          bk.hotelMeds);
  }

  var gOwner = grp('Owner Details');
  row(gOwner, 'Name',   (snap.ownerName || '').trim() || '-');
  row(gOwner, 'Email',  bk.ownerEmail  || '-');
  row(gOwner, 'Mobile', snap.mobile || bk.ownerPhone || '-');

  function renderRow(r) {
    return '<div class="summary-row"><span class="summary-key">'+r[0]+'</span><span class="summary-val">'+r[1]+'</span></div>';
  }
  var detailsEl = document.getElementById(detailsId || 'successDetails');
  if (detailsEl) {
    detailsEl.innerHTML = groups.map(function(g) {
      if (!g.rows.length) return '';
      return '<div class="summary-group"><div class="summary-group-title">'+g.title+'</div>' +
        g.rows.map(renderRow).join('') + '</div>';
    }).join('');
  }

  // ── itemised price breakdown ──
  var plines = [];
  var calcSub = 0;

  if (svc === 'grooming') {
    if (bk.groomServicePrice > 0) {
      var groomSpec = (GROOM_SERVICES||[]).find(function(s){return s.key===bk.groomService;});
      plines.push({ label: groomSpec ? groomSpec.name : 'Grooming service', amount: bk.groomServicePrice });
      calcSub += bk.groomServicePrice;
    }
    Object.keys(bk.selectedAddons || {}).forEach(function(k) {
      var addon = (ADDONS||[]).find(function(a){return a.key===k;});
      var p = (bk.selectedAddons||{})[k] || 0;
      if (p > 0) { plines.push({ label: 'Add-on — '+(addon?addon.name:k), amount: p }); calcSub += p; }
    });
  } else if (svc === 'hotel') {
    var cin  = bk.hotelCheckin;
    var cout = bk.hotelCheckout;
    if (cin && cout) {
      var room     = bk.hotelRoomType || 'small_cage';
      var rateSize = (CAGE_RATE_SIZE||{})[room] || bk.petSize || 'small_dog';
      var roomLbl  = bk.hotelRoomName || (ROOM_LABELS||{})[room] || room.replace(/_/g,' ');
      var nights   = Math.round((new Date(cout+' 00:00:00') - new Date(cin+' 00:00:00')) / 86400000);
      var wdCnt=0, weCnt=0, wdTot=0, weTot=0;
      for (var ni=0; ni<nights; ni++) {
        var nd = new Date(cin+' 00:00:00'); nd.setDate(nd.getDate()+ni);
        var dow = nd.getDay(); var isWe = (dow===0||dow===5||dow===6);
        if (isWe) { weCnt++; weTot += (HOTEL_RATES&&HOTEL_RATES.weekend&&HOTEL_RATES.weekend[rateSize])||0; }
        else      { wdCnt++; wdTot += (HOTEL_RATES&&HOTEL_RATES.weekday&&HOTEL_RATES.weekday[rateSize])||0; }
      }
      if (wdCnt > 0) {
        var wdRate = (HOTEL_RATES&&HOTEL_RATES.weekday&&HOTEL_RATES.weekday[rateSize])||0;
        plines.push({ label: wdCnt+' weekday night'+(wdCnt!==1?'s':'')+' × ₱'+wdRate.toLocaleString()+' ('+roomLbl+')', amount: wdTot });
        calcSub += wdTot;
      }
      if (weCnt > 0) {
        var weRate = (HOTEL_RATES&&HOTEL_RATES.weekend&&HOTEL_RATES.weekend[rateSize])||0;
        plines.push({ label: weCnt+' weekend/holiday night'+(weCnt!==1?'s':'')+' × ₱'+weRate.toLocaleString()+' ('+roomLbl+')', amount: weTot });
        calcSub += weTot;
      }
    }
    if (bk.hotelLateTotal > 0) {
      var lateHrs = bk.hotelLateTotal / (HOTEL_LATE_RATE||100);
      plines.push({ label: 'Late pick-up fee ('+lateHrs+' hr'+(lateHrs!==1?'s':'')+' × ₱'+(HOTEL_LATE_RATE||100).toLocaleString()+'/hr)', amount: bk.hotelLateTotal });
      calcSub += bk.hotelLateTotal;
    }
  } else if (svc === 'daycare') {
    var dcHrs = bk.daycareOpenTime ? 'Open time' : ((bk.daycarePickupHour||0) - (bk.daycareDropoffHour||0)) + ' hr';
    plines.push({ label: 'Daycare ('+dcHrs+')', amount: bk.daycareTotal || snap.subtotal || 0 });
    calcSub += bk.daycareTotal || snap.subtotal || 0;
  } else if (svc === 'studio') {
    plines.push({ label: 'Self-Shoot Studio session', amount: snap.subtotal || 0 });
    calcSub += snap.subtotal || 0;
  }

  var baseSubtotal = snap.subtotal || calcSub;
  var ph = plines.map(function(l){
    return '<div class="price-line component"><span class="price-line-label">'+l.label+'</span><span class="price-line-val">₱'+l.amount.toLocaleString()+'</span></div>';
  }).join('');

  if (plines.length > 0) {
    ph += '<div class="price-line subtotal-line"><span class="price-line-label">Subtotal</span><span class="price-line-val">₱'+baseSubtotal.toLocaleString()+'</span></div>';
  }
  if ((snap.discountAmount||0) > 0) {
    var discPct = baseSubtotal > 0 ? Math.round(snap.discountAmount/baseSubtotal*100) : 0;
    ph += '<div class="price-line"><span class="price-line-label">Member discount'+(discPct?(' ('+discPct+'%)'):'')+' </span><span class="price-line-val discount">−₱'+snap.discountAmount.toLocaleString()+'</span></div>';
  }
  if ((snap.convenienceFee||0) > 0) {
    ph += '<div class="price-line"><span class="price-line-label">Convenience fee</span><span class="price-line-val">₱'+snap.convenienceFee.toLocaleString()+'</span></div>';
  }
  ph += '<div class="price-line total-line"><span class="price-line-label">Total Paid</span><span class="price-line-val">₱'+snap.total.toLocaleString()+'</span></div>';

  var priceEl = document.getElementById(priceId || 'successPriceBreakdown');
  if (priceEl) priceEl.innerHTML = ph;
}

// ── PDF / Print ──
// Sets the browser document title (which becomes the default PDF filename)
// to <Branch>_<Service>_<RefNumber> before triggering the print dialog.
function printBooking() {
  var ref  = ((document.getElementById('refNum') || {}).textContent || '').trim();
  var meta = window._printMeta || {};
  var parts = [
    (meta.branch  || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, ''),
    (meta.service || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, ''),
    ref
  ].filter(Boolean);
  var newTitle = parts.join('_') || document.title;
  var orig = document.title;
  document.title = newTitle;
  window.print();
  // Restore after dialog closes (slight delay to let browser pick up the title)
  setTimeout(function() { document.title = orig; }, 2000);
}

// ── HANDLE RETURN FROM PAYMONGO ──
(function checkPaymentReturn() {
  var params = new URLSearchParams(window.location.search);
  var status = params.get('payment');
  var ref    = params.get('ref');
  if (!status) return;
  // Clean URL
  window.history.replaceState({}, '', window.location.pathname);
  if (status === 'success' && ref) {
    // Hide ALL steps and the step UI, show only success screen
    document.querySelectorAll('.step-panel, #successScreen').forEach(function(el) {
      el.classList.remove('active');
    });
    var pw = document.getElementById('progressWrap');
    var bn = document.getElementById('bottomNav');
    var ss = document.getElementById('successScreen');
    var hd = document.querySelector('header.booking-header, .booking-header');
    if (pw) pw.style.display = 'none';
    if (bn) bn.style.display = 'none';
    if (hd) hd.style.display = 'none';
    if (ss) {
      ss.style.display = '';
      ss.classList.add('active');
    }
    setSuccessTimestamp(ref);
    try {
      var snap = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null');
      if (snap) {
        renderSuccessDetails(snap, 'successDetails', 'successPriceBreakdown');
        sessionStorage.removeItem('bk_snapshot');
      }
    } catch(e) {}
    try { sessionStorage.removeItem('bk_pending_ref'); } catch(e) {}
  } else if (status === 'cancelled' || status === 'failed') {
    var _retSnap = null;
    try { _retSnap = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null'); } catch(e) {}
    if (_retSnap) {
      showPayReturnScreen(_retSnap, ref || _retSnap.refNumber);
    } else {
      setTimeout(function() {
        showToast('Payment was not completed. Please try again.', 5000);
      }, 800);
    }
  }
})();

// ── POLL FOR PAYMENT if ref is in sessionStorage (QR fallback) ──
// When customer is redirected to PayMongo, store ref so we can
// detect a successful payment even if PayMongo redirect doesn't fire
setTimeout(checkStoredPaymentRef, 500);

// ── SUCCESS SCREEN TIMESTAMP ──
// Call this every time the success screen ref number is set.
function setSuccessTimestamp(ref) {
  var now = new Date();
  var opts = { year:'numeric', month:'long', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true };
  var ts = now.toLocaleString('en-PH', opts); // e.g. "May 22, 2026, 3:05 PM"
  // Top ref block
  var rn = document.getElementById('refNum');
  if (rn) rn.textContent = ref || rn.textContent;
  var tEl = document.getElementById('bookingTimestamp');
  if (tEl) tEl.textContent = ts;
  // Bottom footer strip
  var fr = document.getElementById('footerRefNum');
  if (fr) fr.textContent = ref || fr.textContent;
  var ft = document.getElementById('footerTimestamp');
  if (ft) ft.textContent = ts;
}

function storePaymentRef(ref) {
  try { sessionStorage.setItem('bk_pending_ref', ref); } catch(e) {}
}
function checkStoredPaymentRef() {
  try {
    var ref = sessionStorage.getItem('bk_pending_ref');
    if (!ref) return;
    // Already on success screen - clear and stop
    if (document.getElementById('successScreen') && document.getElementById('successScreen').classList.contains('active')) {
      sessionStorage.removeItem('bk_pending_ref');
      return;
    }
    // Show a "Did you pay?" recovery banner
    var banner = document.getElementById('payReturnBanner');
    if (banner) { banner.style.display = ''; banner.querySelector('.bk-ref').textContent = ref; }
  } catch(e) {}
}
function confirmPaymentReturn(ref) {
  try { sessionStorage.removeItem('bk_pending_ref'); } catch(e) {}
  document.querySelectorAll('.step-panel, #successScreen').forEach(function(el) {
    el.classList.remove('active');
  });
  var pw = document.getElementById('progressWrap');
  var bn = document.getElementById('bottomNav');
  var ss = document.getElementById('successScreen');
  var hd = document.querySelector('.booking-header');
  var rb = document.getElementById('payReturnBanner');
  if (pw) pw.style.display = 'none';
  if (bn) bn.style.display = 'none';
  if (hd) hd.style.display = 'none';
  if (rb) rb.style.display = 'none';
  if (ss) { ss.style.display = ''; ss.classList.add('active'); }
  setSuccessTimestamp(ref);
}

// ── PAYMENT RETURN SCREEN (CANCELLED / FAILED) ──

function showPayReturnScreen(snap, ref) {
  // Hide all step panels, progress, and bottom nav
  document.querySelectorAll('.step-panel, #successScreen').forEach(function(el) { el.classList.remove('active'); });
  var pw = document.getElementById('progressWrap');
  var bn = document.getElementById('bottomNav');
  var hd = document.querySelector('.booking-header');
  var pr = document.getElementById('payReturnScreen');
  if (pw) pw.style.display = 'none';
  if (bn) bn.style.display = 'none';
  if (hd) hd.style.display = '';        // keep header visible
  if (pr) { pr.style.display = ''; pr.classList.add('active'); }

  // Store snap in memory for retry/edit actions
  window._payReturnSnap = snap;

  // Set booking reference
  var refEl = document.getElementById('payReturnRef');
  if (refEl) refEl.textContent = ref || snap.refNumber || 'BH-000000';

  // Render full details (same as success screen)
  renderSuccessDetails(snap, 'payReturnDetails', 'payReturnPriceBreakdown');
}

// Re-submit payment for the same booking details
async function retryPayment() {
  var snap = window._payReturnSnap;
  if (!snap || !snap.rawPayload) {
    showToast('Booking data not found. Please start a new booking.', 5000);
    return;
  }
  var btn      = document.getElementById('btnRetryPayment');
  var editBtn  = document.getElementById('btnEditBooking');
  var statusEl = document.getElementById('payReturnStatus');
  if (btn)     { btn.disabled = true; btn.textContent = 'Processing...'; }
  if (editBtn) { editBtn.disabled = true; }
  if (statusEl) statusEl.textContent = 'Connecting to payment gateway…';
  try {
    var retryPayload = Object.assign({}, snap.rawPayload, {
      existing_booking_id: snap.bookingId || null,
      retry: true
    });
    var res  = await fetch(CREATE_PAYMENT_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'apikey':        SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(retryPayload),
    });
    var data = await res.json();
    if (data.conflict) {
      if (btn)     { btn.disabled = false; btn.textContent = 'Retry Payment'; }
      if (editBtn) { editBtn.disabled = false; }
      if (statusEl) statusEl.textContent = '';
      showToast('⚠️ This slot is no longer available. Please edit your booking to choose another.', 7000);
      return;
    }
    if (data.error || !data.checkout_url) {
      if (btn)     { btn.disabled = false; btn.textContent = 'Retry Payment'; }
      if (editBtn) { editBtn.disabled = false; }
      if (statusEl) statusEl.textContent = data.error || 'No checkout URL returned. Please try again.';
      return;
    }
    // Update snapshot ref if a new booking was created
    if (data.ref_number) {
      snap.refNumber  = data.ref_number;
      snap.bookingId  = data.booking_id || snap.bookingId;
      var refEl = document.getElementById('payReturnRef');
      if (refEl) refEl.textContent = data.ref_number;
      try { sessionStorage.setItem('bk_snapshot', JSON.stringify(snap)); } catch(e) {}
    }
    storePaymentRef(data.ref_number || snap.refNumber);
    _redirectingToPayment = true;
    window.location.href = data.checkout_url;
  } catch(err) {
    if (btn)     { btn.disabled = false; btn.textContent = 'Retry Payment'; }
    if (editBtn) { editBtn.disabled = false; }
    if (statusEl) statusEl.textContent = 'Connection error — please check your internet and try again.';
  }
}

// Cancel a pending booking via Edge Function (service role) so the slot is freed immediately.
// bookingId comes from data.booking_id returned by the create-payment edge function.
async function cancelPendingBooking(bookingId) {
  if (!bookingId) return false;
  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/cancel-pending-booking', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ booking_id: bookingId }),
    });
    if (!res.ok) return false;
    var data = await res.json();
    return data.cancelled === true;
  } catch(e) {
    return false;
  }
}

// Repopulate DOM form inputs from a restored booking state object
// so that collectAllState() reads correctly after restoration.
function populateDOMFromBooking(bk) {
  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el && val != null && val !== '') el.value = val;
  }
  // Date inputs
  setVal('hotelCheckin',  bk.hotelCheckin);
  setVal('hotelCheckout', bk.hotelCheckout);
  setVal('groomDate',     bk.groomDate);
  setVal('daycareDate',   bk.daycareDate);
  setVal('studioDate',    bk.studioDate);
  // Hotel times (dropoff = numeric hour value; pickup = numeric hour option value)
  setVal('hotelDropoffTime', bk.hotelDropoffTime);
  setVal('hotelPickupTime',  bk.hotelPickupHour != null ? bk.hotelPickupHour : 14);
  // Hotel care notes
  setVal('hotelFeeding',    bk.hotelFeeding);
  setVal('hotelMeds',       bk.hotelMeds);
  setVal('vetClinic',       bk.vetClinic);
  setVal('vetContact',      bk.vetContact);
  setVal('vetAddress',      bk.vetAddress);
  setVal('emergencyName',   bk.emergencyName);
  setVal('emergencyPhone',  bk.emergencyPhone);
  // Daycare times (option values are numeric hours)
  setVal('daycareDropoff', bk.daycareDropoffHour != null ? bk.daycareDropoffHour : '');
  setVal('daycarePickup',  bk.daycarePickupHour  != null ? bk.daycarePickupHour  : '');
  setVal('daycareNotes',   bk.daycareNotes);
  // Grooming
  setVal('groomNotes', bk.groomNotes);
  // Pet details
  setVal('petName',    bk.petName);
  setVal('petBreed',   bk.petBreed);
  setVal('petAgeNum',  bk.petAge);
  setVal('petAgeUnit', bk.petAgeUnit);
  setVal('petMedical', bk.petMedical);
  // Owner details
  setVal('ownerFirst', bk.ownerFirst);
  setVal('ownerLast',  bk.ownerLast);
  setVal('ownerEmail', bk.ownerEmail);
  setVal('ownerPhone', bk.ownerPhone);
  // ownerSource — handle "Other: ..." format stored by collectAllState
  var rawSrc = bk.ownerSource || '';
  if (rawSrc.startsWith('Other: ')) {
    setVal('ownerSource', 'Other');
    setVal('ownerSourceOther', rawSrc.slice(7));
    var otherFld = document.getElementById('ownerSourceOther');
    if (otherFld) otherFld.style.display = '';
  } else {
    setVal('ownerSource', rawSrc);
  }
}

// User chose to edit their booking after a cancelled payment
async function editAfterCancelledPayment() {
  var snap = window._payReturnSnap;
  if (!snap) {
    showToast('Booking data not found. Please start a new booking.', 5000);
    return;
  }
  var btn      = document.getElementById('btnEditBooking');
  var retryBtn = document.getElementById('btnRetryPayment');
  var statusEl = document.getElementById('payReturnStatus');
  if (btn)      { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (retryBtn) { retryBtn.disabled = true; }
  if (statusEl) statusEl.textContent = 'Cancelling previous booking to free your slot…';

  // Cancel the old pending booking in Supabase so inventory is released
  var cancelled = await cancelPendingBooking(snap.bookingId);
  if (statusEl) statusEl.textContent = cancelled
    ? ''
    : 'Note: previous booking will auto-release within 15 minutes.';

  // Clear the pending payment reference from session storage
  try { sessionStorage.removeItem('bk_pending_ref'); } catch(e) {}
  // Keep bk_snapshot in case something goes wrong — it will be overwritten on next submit

  // Restore the booking object from the saved state
  if (snap.bookingState) {
    Object.assign(booking, snap.bookingState);
  }

  // Determine and restore currentStep to the last step of the flow (before summary)
  var flow = booking.service ? FLOWS[booking.service] : null;
  currentStep = navMaxStep();

  // Repopulate DOM form fields so collectAllState() reads the right values
  populateDOMFromBooking(booking);

  // Re-fetch live rooms/groomers for this branch — liveRooms is empty on a fresh page load
  // (normally populated by selectLocation(), which never fires in the return flow).
  // Await it now so room availability is ready before the user navigates back to Step 3.
  if (statusEl) statusEl.textContent = 'Restoring your booking…';
  await loadLiveRoomsAndGroomers();
  if (statusEl) statusEl.textContent = '';

  // Restore playpark button selection in hotel step 4
  var ppY = document.getElementById('playparkYes');
  var ppN = document.getElementById('playparkNo');
  if (ppY && ppN) {
    ppY.classList.toggle('selected', booking.playparkConsent === 'yes');
    ppN.classList.toggle('selected', booking.playparkConsent === 'no');
  }

  // Restore pet gender button selection (buttons use onclick="selectGender(this,'male')" style)
  if (booking.petGender) {
    document.querySelectorAll('#petGenderGrid .gender-btn').forEach(function(b) {
      var oc = b.getAttribute('onclick') || '';
      b.classList.toggle('selected', oc.indexOf("'"+booking.petGender+"'") >= 0);
    });
  }
  // Restore temperament button selection
  if (booking.petTemperament) {
    document.querySelectorAll('.temp-btn').forEach(function(b) {
      var oc = b.getAttribute('onclick') || '';
      b.classList.toggle('selected', oc.indexOf("'"+booking.petTemperament+"'") >= 0);
    });
  }
  // Restore membership button selection
  var memYes = document.getElementById('memberYes');
  var memNo  = document.getElementById('memberNo');
  if (memYes && memNo) {
    memYes.classList.toggle('selected', booking.isMember === true);
    memNo.classList.toggle('selected',  booking.isMember === false);
  }
  // Restore waiver checkbox states from saved payload
  var _rp = snap.rawPayload || {};
  function _restoreCheck(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    if (val)  el.classList.add('checked');
    else      el.classList.remove('checked');
  }
  var _svc = booking.service;
  if (_svc === 'grooming') _restoreCheck('waiverGeneralGrooming', _rp.waiverGeneral);
  if (_svc === 'hotel')    _restoreCheck('waiverGeneralHotel',    _rp.waiverGeneral);
  if (_svc === 'daycare')  _restoreCheck('waiverGeneralDaycare',  _rp.waiverGeneral);
  if (_svc === 'studio')   _restoreCheck('waiverStudio',          _rp.waiverStudio);
  _restoreCheck('waiverVaccineDecl',  _rp.waiverVaccine);
  _restoreCheck('waiverMedia',        _rp.waiverMedia);
  _restoreCheck('waiverPlaypark',     _rp.waiverPlaypark);
  _restoreCheck('seniorWaiver',       _rp.waiverSeniorMedical);

  // Hide payReturnScreen; restore normal UI chrome
  var pr = document.getElementById('payReturnScreen');
  var pw = document.getElementById('progressWrap');
  var bn = document.getElementById('bottomNav');
  if (pr) { pr.style.display = 'none'; pr.classList.remove('active'); }
  if (pw) pw.style.display = '';
  if (bn) bn.style.display = '';

  // Navigate directly to summary so the user sees their full booking
  // and can use the Back button to edit any individual step
  onSummaryScreen = false;  // reset so showSummary() re-enters correctly
  showSummary();
}

// ── PRE-PAYMENT AVAILABILITY CHECK ──
// ----------------------------------------------------------------
// pg_cron job to auto-cancel pending/unpaid bookings after 15 min:
//   SELECT cron.schedule(
//     'cancel-pending-bookings', '*/5 * * * *',
//     $$ UPDATE bookings
//        SET status = 'cancelled', updated_at = NOW(),
//            cancellation_reason = 'Payment timeout (15 min)'
//        WHERE status = 'pending'
//          AND (payment_status IS NULL OR payment_status = 'unpaid')
//          AND created_at < NOW() - INTERVAL '15 minutes'; $$
//   );
// ----------------------------------------------------------------
async function checkAvailabilityBeforePayment() {
  var svc = booking.service;
  if (svc !== 'hotel' && svc !== 'grooming') return { available: true };
  try {
    var branchId = await getSelectedBranchId();
    if (!branchId) return { available: true };

    if (svc === 'hotel') {
      if (!booking.hotelRoomId) return { available: true }; // fallback type — edge fn will verify
      var cin = booking.hotelCheckin, cout = booking.hotelCheckout;
      var bkRows = await sbFetchPublic('bookings',
        'select=id&branch_id=eq.' + branchId +
        '&service=eq.hotel&status=not.in.(cancelled,rejected)');
      if (bkRows && bkRows.length) {
        var ids = bkRows.map(function(b){return b.id;}).join(',');
        var dtRows = await sbFetchPublic('hotel_details',
          'select=room_id&booking_id=in.(' + ids + ')' +
          '&checkin_date=lte.' + cout + '&checkout_date=gte.' + cin +
          '&room_id=eq.' + booking.hotelRoomId);
        if (dtRows && dtRows.length) return { available: false, conflict: 'room' };
      }
      return { available: true };
    }

    if (svc === 'grooming') {
      var dateVal = booking.groomDate, slot = booking.groomSlot;
      if (!dateVal || !slot) return { available: true };
      var groomerId  = booking.preferredStylistId;
      var isAny      = !groomerId;
      var serviceKey = booking.groomService || 'basic';
      var myDuration = GROOM_SLOT_MINS[serviceKey] || 60;
      var candStart  = slotToMins(slot);
      var candEnd    = candStart + myDuration;
      // Fetch ALL bookings for this date (no groomer filter) so unassigned ones are visible
      var bkQuery = 'select=timeslot,groom_service_key,groomer_id,bookings!inner(status,branch_id)' +
        '&service_date=eq.' + dateVal + '&bookings.branch_id=eq.' + branchId +
        '&bookings.status=not.in.(cancelled,rejected)';
      var bkRows = (await sbFetchPublic('grooming_details', bkQuery)) || [];
      function isGroomerFree(gId) {
        return !bkRows.filter(function(r){ return r.groomer_id === gId && r.timeslot; })
          .some(function(r) {
            var dur = GROOM_SLOT_MINS[r.groom_service_key || 'basic'] || 60;
            var st  = slotToMins(r.timeslot);
            return st >= 0 && candStart < (st + dur) && candEnd > st;
          });
      }
      var unassignedAtSlot = bkRows.filter(function(r) {
        if (r.groomer_id != null) return false;
        var dur = GROOM_SLOT_MINS[r.groom_service_key || 'basic'] || 60;
        var st = slotToMins(r.timeslot || '');
        return st >= 0 && candStart < st + dur && candEnd > st;
      }).length;
      var groomerPool = isAny ? liveGroomers : liveGroomers.filter(function(g){ return g.id === groomerId; });
      var freeGroomers = groomerPool.filter(function(g){ return isGroomerFree(g.id); });
      var still;
      if (isAny) {
        still = freeGroomers.length > unassignedAtSlot;
      } else {
        // Specific groomer: directly free AND unassigned overflow won't consume them
        var otherFreeCount = liveGroomers.filter(function(g) {
          return g.id !== groomerId && isGroomerFree(g.id);
        }).length;
        still = groomerPool.length > 0 && isGroomerFree(groomerId) && unassignedAtSlot <= otherFreeCount;
      }
      if (!still) return { available: false, conflict: 'slot' };
      return { available: true };
    }
  } catch(e) {
    console.warn('Pre-payment availability check error (fail-open):', e);
  }
  return { available: true };
}

async function handleBookingConflict(conflictType) {
  _submitting = false;
  onSummaryScreen = false;
  document.getElementById('stepSummary').classList.remove('active');
  document.getElementById('progressWrap').style.display = '';

  if (conflictType === 'room') {
    booking.hotelRoomType = null;
    booking.hotelRoomId   = null;
    booking.hotelRoomName = null;
    goToStep(3);
    loadRoomAvailability(); // force-refresh available rooms
    showToast('⚠️ That room was just booked by someone else — please choose another.', 8000);
  } else if (conflictType === 'slot') {
    booking.groomSlot = null;
    goToStep(4);
    await renderGroomSlots(); // force-refresh available slots
    showToast('⚠️ That time slot was just taken — please choose another slot.', 8000);
  }
}

// ── SUBMIT (redirects to PayMongo) ──
var _submitting = false; // global lock - prevents double-submit on fast double-tap

async function submitBooking() {
  if (_submitting) return; // already in flight
  // Guard: pricing must be loaded — a ₱0 booking would be accepted by the edge function
  if (!_pricingLoaded) {
    showToast('Pricing data is unavailable. Please refresh the page and try again.', 7000);
    return;
  }
  _submitting = true;
  var btn = document.getElementById('btnNext');
  if (btn) { btn.textContent = 'Processing...'; btn.disabled = true; }

  collectAllState();

  // ── Pre-payment availability check ──
  var avail = await checkAvailabilityBeforePayment();
  if (!avail.available) {
    _submitting = false;
    if (btn) { btn.textContent = 'Confirm Booking'; btn.disabled = false; }
    await handleBookingConflict(avail.conflict);
    return;
  }

  var svc = booking.service;
  var subtotal = 0;
  if (svc === 'grooming') {
    subtotal = (booking.groomServicePrice||0) + Object.keys(booking.selectedAddons).reduce(function(a,k){return a+(booking.selectedAddons[k]||0);},0);
  } else if (svc === 'hotel') {
    subtotal = (booking.hotelBaseTotal||0) + (booking.hotelLateTotal||0);
  } else if (svc === 'daycare') {
    subtotal = booking.daycareTotal || 0;
  }
  var discRate = booking.memberValid ? (MEMBER_DISCOUNT[svc] || 0) : 0;
  var discAmt  = Math.round(subtotal * discRate);
  var total    = subtotal - discAmt + CONVENIENCE_FEE;

  var groomServiceName = '';
  if (booking.groomService) {
    var found = GROOM_SERVICES.find(function(s){ return s.key === booking.groomService; });
    groomServiceName = found ? found.name : booking.groomService;
  }

  // ── Upload vaccine documents to Storage ──
  // Each file gets a signed upload URL from get-upload-url, is PUT directly to Storage,
  // and its path is passed to create-payment which inserts vaccine_documents rows.
  var vaccineDocuments = {};
  var vaccineFileNames = {};
  if (uploadedVaccineFiles && uploadedVaccineFiles.length > 0) {
    var uploadId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'upload-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    for (var _vi = 0; _vi < uploadedVaccineFiles.length; _vi++) {
      var _vf = uploadedVaccineFiles[_vi];
      var _vKey = 'vaccine_' + _vi;
      try {
        var _vUrlRes = await fetch(GET_UPLOAD_URL, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,   // required — without it the gateway returns 401
            'apikey':        SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ uploadId: uploadId, fileName: _vf.name, contentType: _vf.type, vaccineKey: _vKey }),
        });
        var _vUrlData = await _vUrlRes.json();
        if (_vUrlData.uploadUrl && _vUrlData.path) {
          await fetch(_vUrlData.uploadUrl, { method: 'PUT', body: _vf, headers: { 'Content-Type': _vf.type } });
          vaccineDocuments[_vKey] = _vUrlData.path;
          vaccineFileNames[_vKey] = _vf.name;
        }
      } catch (_ve) {
        console.warn('Vaccine file upload failed (non-fatal):', _vf.name, _ve);
      }
    }
  }

  // Build the FULL vaccine map for this animal (all applicable vaccines with
  // their checked state), not just the ones the user toggled — so the admin
  // drawer can show every expected vaccine with a ✓/✗ rather than only checked ones.
  var _vaccDogList = ['Anti-rabies','5/6/8-in-1 shot','Kennel Cough / Bordetella','Tick and Flea treatment'];
  var _vaccCatList = ['Anti-rabies','All-in-1 shot','Anti-parasitic'];
  var _vaccList    = (booking.petAnimal === 'cat') ? _vaccCatList : _vaccDogList;
  var _fullVaccines = {};
  _vaccList.forEach(function(v) {
    var k = v.replace(/[^a-z0-9]/gi, '_');
    _fullVaccines[k] = !!booking.vaccines[k];
  });

  var payload = {
    location:booking.location, service:booking.service,
    groomDate:booking.groomDate, groomSlot:booking.groomSlot,
    preferredStylist:booking.preferredStylist, preferredStylistId:booking.preferredStylistId||null,
    groomService:booking.groomService, groomServiceName:groomServiceName,
    groomNotes:booking.groomNotes,
    hotelCheckin:booking.hotelCheckin, hotelCheckout:booking.hotelCheckout,
    hotelDropoff:booking.hotelDropoffTime,
    hotelPickup:booking.hotelPickupTime, hotelPickupHour:booking.hotelPickupHour||14,
    hotelRoom:booking.hotelRoomType||'', hotelRoomId:booking.hotelRoomId||null,
    playparkConsent:booking.playparkConsent,
    hotelFeeding:booking.hotelFeeding, hotelMeds:booking.hotelMeds,
    vetClinic:booking.vetClinic, vetContact:booking.vetContact, vetAddress:booking.vetAddress,
    emergencyName:booking.emergencyName, emergencyPhone:booking.emergencyPhone,
    daycareDate:booking.daycareDate,
    daycareDropoff:booking.daycareDropoffText, daycareDropoffHour:booking.daycareDropoffHour,
    daycarePickup:booking.daycarePickupText,   daycarePickupHour:booking.daycarePickupHour,
    daycareOpenTime:booking.daycareOpenTime,   daycareNotes:booking.daycareNotes,
    studioDate:booking.studioDate, studioSlot:booking.studioSlot,
    petName:booking.petName, petAnimal:booking.petAnimal,
    petGender:booking.petGender, petBreed:booking.petBreed,
    petAge:booking.petAge, petAgeUnit:booking.petAgeUnit,
    petSize:booking.petSize, petMedical:booking.petMedical,
    petTemperament:booking.petTemperament,
    membershipId:booking.memberValid?booking.membershipId:null,
    vaccines:_fullVaccines, addons:booking.selectedAddons,
    ownerFirst:booking.ownerFirst, ownerLast:booking.ownerLast,
    ownerEmail:booking.ownerEmail, ownerPhone:booking.ownerPhone,
    ownerSource:booking.ownerSource,
    waiverGeneral:(function(){ var m={grooming:'waiverGeneralGrooming',daycare:'waiverGeneralDaycare',hotel:'waiverGeneralHotel'}; var el=m[booking.service]?document.getElementById(m[booking.service]):null; return el?el.classList.contains('checked'):false; })(),
    waiverVaccine:document.getElementById('waiverVaccineDecl').classList.contains('checked'),
    waiverSeniorMedical:document.getElementById('seniorWaiver')?document.getElementById('seniorWaiver').classList.contains('checked'):false,
    waiverStudio:document.getElementById('waiverStudio')?document.getElementById('waiverStudio').classList.contains('checked'):false,
    waiverMedia:document.getElementById('waiverMedia').classList.contains('checked'),
    waiverPlaypark:document.getElementById('waiverPlaypark')?document.getElementById('waiverPlaypark').classList.contains('checked'):false,
    waiverTexts: buildWaiverTexts(),
    subtotal:subtotal, discountAmount:discAmt, convenienceFee:CONVENIENCE_FEE, total:total,
    hotelLateTotal:    booking.hotelLateTotal    || 0,
    groomServicePrice: booking.groomServicePrice || 0,
    vaccineDocuments:  vaccineDocuments,
    vaccineFileNames:  vaccineFileNames,
    bringVaccines: (function(){ var el=document.getElementById('bringVaccines'); return !!(el && el.classList.contains('checked')); })(),
    // Walk-in bookings go through submit-booking (creates all child records,
    // no payment), so flag them as admin-created with a walkin source.
    adminCreated:  IS_WALKIN,
    booking_source: IS_WALKIN ? 'walkin' : 'online',
  };

  // Show loading state
  var _loadHead = IS_WALKIN ? 'Recording your booking...' : 'Preparing your payment...';
  var _loadSub  = IS_WALKIN
    ? 'Saving your booking — payment will be collected at the counter.'
    : 'Your booking will be created with <strong style="color:var(--cream)">Pending</strong> status and your spot held for <strong style="color:var(--yellow)">15 minutes</strong>. It will be automatically released if payment is not completed in time.';
  document.getElementById('stepSummary').innerHTML =
    '<div class="pay-loading">' +
    '<div class="bh-spinner"></div>' +
    '<p class="pay-loading-text">' + _loadHead + '</p>' +
    '<p style="font-size:12px;color:var(--mid);margin-top:14px;line-height:1.7;max-width:280px;margin-left:auto;margin-right:auto">' +
    _loadSub + '</p>' +
    '<p id="payDebug" style="font-size:11px;color:var(--mid);margin-top:8px"></p>' +
    '</div>';

  // 30-second timeout guard
  var payTimeout = setTimeout(function() {
    buildSummary();
    updateBottomNavForSummary();
    showToast('Request timed out. Please try again.', 5000);
    btn.textContent = 'Confirm Booking';
    btn.disabled = false;
  }, 30000);

  // Walk-in → submit-booking (creates the full booking + all child records,
  // no PayMongo). Online → create-payment (creates a pending booking + checkout).
  fetch(IS_WALKIN ? EDGE_FN_URL : CREATE_PAYMENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'apikey':        SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  })
  .then(function(res) {
    if (!res.ok) {
      // Non-2xx: throw so the .catch() path handles recovery uniformly
      return res.text().then(function(body) {
        throw new Error('Server error ' + res.status + (body ? ': ' + body.slice(0, 120) : ''));
      });
    }
    return res.json();
  })
  .then(async function(data) {
    clearTimeout(payTimeout);
    // Server-side conflict detection (edge function verified availability)
    if (data.conflict) {
      await handleBookingConflict(data.conflict);
      return;
    }
    if (data.error) {
      _submitting = false;
      buildSummary();
      updateBottomNavForSummary();
      showToast('Booking error: ' + data.error, 6000);
      return;
    }
    storePaymentRef(data.ref_number);
    try {
      var _locLbl = { estancia:'Estancia (Pasig)', eastwood:'Eastwood (QC)' };
      var _svcLbl = { grooming:'Grooming', hotel:'Pet Hotel', daycare:'Daycare', studio:'Self-Shoot Studio' };
      var _sched = '';
      if (svc === 'grooming') _sched = (booking.groomDate||'-') + ' at ' + (booking.groomSlot||'-');
      else if (svc === 'hotel') _sched = 'Check-in: ' + (booking.hotelCheckin||'-') + ' | Check-out: ' + (booking.hotelCheckout||'-');
      else if (svc === 'daycare') _sched = booking.daycareDate || '-';
      else if (svc === 'studio') _sched = (booking.studioDate||'-') + ' at ' + (booking.studioSlot||'-');
      // Capture vaccine status from DOM before we leave the page
      var _vaccFileCount = uploadedVaccineFiles ? uploadedVaccineFiles.length : 0;
      var _bringVacc = document.getElementById('bringVaccines');
      var _vaccStatus = _vaccFileCount > 0
        ? (_vaccFileCount + ' file' + (_vaccFileCount > 1 ? 's' : '') + ' uploaded')
        : (_bringVacc && _bringVacc.classList.contains('checked') ? 'Will bring to venue' : 'Not provided');
      sessionStorage.setItem('bk_snapshot', JSON.stringify({
        location: _locLbl[booking.location]||booking.location,
        service: _svcLbl[svc]||svc,
        petName: booking.petName, petBreed: booking.petBreed,
        petSize: booking.petSize ? PET_SIZE_LABELS[booking.petSize] : null,
        ownerName: (booking.ownerFirst||'') + ' ' + (booking.ownerLast||''),
        mobile: booking.ownerPhone,
        schedule: _sched,
        vaccineStatus: _vaccStatus,
        // Service specs
        groomServiceName: svc === 'grooming' && booking.groomService ? (GROOM_SERVICES.find(function(s){return s.key===booking.groomService;})||{name:null}).name : null,
        addons: svc === 'grooming' ? Object.keys(booking.selectedAddons).map(function(k){var a=ADDONS.find(function(x){return x.key===k;});return a?a.name:k;}) : [],
        preferredStylist: svc === 'grooming' ? booking.preferredStylist : null,
        hotelRoomType: svc === 'hotel' ? booking.hotelRoomType : null,
        hotelRoomName: svc === 'hotel' ? booking.hotelRoomName : null,
        hotelDropoffTime: svc === 'hotel' ? booking.hotelDropoffTime : null,
        playparkConsent: svc === 'hotel' ? booking.playparkConsent : null,
        hotelPickupTime: svc === 'hotel' ? booking.hotelPickupTime : null,
        petSizeRaw: booking.petSize,
        daycareOpenTime: svc === 'daycare' ? booking.daycareOpenTime : null,
        daycareDropoffText: svc === 'daycare' ? booking.daycareDropoffText : null,
        daycarePickupText: svc === 'daycare' ? booking.daycarePickupText : null,
        subtotal: subtotal, discountAmount: discAmt,
        convenienceFee: CONVENIENCE_FEE, total: total,
        bookingId: data.booking_id || null,
        pendingId: data.pending_id || null,
        refNumber: data.ref_number || null,
        bookingState: JSON.parse(JSON.stringify(booking)),
        rawPayload: payload
      }));
    } catch(e) {}
    if (IS_WALKIN) {
      // Skip payment gateway — show success screen directly
      var refNum = data.ref_number || data.booking_id || 'BK-' + Date.now();
      document.querySelectorAll('.step-panel').forEach(function(el){ el.classList.remove('active'); });
      var pw = document.getElementById('progressWrap');
      var bn = document.getElementById('bottomNav');
      if (pw) pw.style.display = 'none';
      if (bn) bn.style.display = 'none';
      var ss = document.getElementById('successScreen');
      if (ss) { ss.style.display = ''; ss.classList.add('active'); }
      setSuccessTimestamp(refNum);
      var msgEl = ss ? ss.querySelector('.success-msg') : null;
      if (msgEl) msgEl.textContent = 'Your booking has been recorded. Please proceed to the counter to complete your payment.';
      // Populate booking detail cards from bk_snapshot
      try {
        var snap = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null');
        if (snap) {
          renderSuccessDetails(snap, 'successDetails', 'successPriceBreakdown');
          sessionStorage.removeItem('bk_snapshot');
        }
      } catch(e) {}
      return;
    }
    // Online path: a checkout URL is required to proceed to PayMongo.
    if (!data.checkout_url) {
      _submitting = false;
      buildSummary();
      updateBottomNavForSummary();
      showToast('No checkout URL returned. Please try again or contact the branch.', 6000);
      return;
    }
    _redirectingToPayment = true;
    window.location.href = data.checkout_url;
  })
  .catch(function(err) {
    _submitting = false;
    clearTimeout(payTimeout);
    console.error('Payment error:', err);
    buildSummary();
    updateBottomNavForSummary();
    showToast('Connection error: ' + err.message, 6000);
    if (btn) { btn.textContent = 'Confirm Booking'; btn.disabled = false; }
  });
}

var _BRANCH_CONTACT = {
  estancia: { tel: 'tel:+639276073681', label: 'Call Estancia — +63 927 607 3681' },
  eastwood: { tel: 'tel:+639567819641', label: 'Call Eastwood — +63 956 781 9641' }
};
function showContactModal(type) {
  var loc  = booking.location || 'eastwood';
  var c    = _BRANCH_CONTACT[loc] || _BRANCH_CONTACT.eastwood;
  var bs   = 'display:block;border-radius:12px;padding:13px;font-family:\'Nunito\',sans-serif;font-weight:700;font-size:14px;text-decoration:none;margin-bottom:10px;';
  function primaryA(href, label) { return '<a href="' + href + '" style="' + bs + 'background:var(--blue);color:var(--cream)">' + label + '</a>'; }
  function secondaryA(href, label) { return '<a href="' + href + '" target="_blank" rel="noopener" style="' + bs + 'background:var(--raised);color:var(--cream)">' + label + '</a>'; }
  function contactActions(branchKey) {
    var bc = _BRANCH_CONTACT[branchKey] || c;
    return primaryA(bc.tel, bc.label) +
           secondaryA('https://instagram.com/barkhausph', 'Instagram @barkhausph') +
           secondaryA('https://facebook.com/barkhausph', 'Facebook @barkhausph');
  }
  var icon, title, body, actions;
  if (type === 'studio') {
    icon = '📷'; title = 'BarkStudio';
    if (loc === 'estancia') {
      body    = 'BarkStudio is only available at our Eastwood branch — 4th Floor, Eastwood Mall, Libis, Quezon City.';
      actions = '';
    } else {
      body    = 'Studio bookings are currently available via direct visit or message. Get in touch and we’ll set it up for you.';
      actions = contactActions('eastwood');
    }
  } else { // events
    icon    = '🎉'; title = 'Events';
    body    = 'Event bookings are currently available via direct visit or message. Get in touch with us to plan your pet’s special day!';
    actions = contactActions(loc);
  }
  document.getElementById('cModalIcon').textContent   = icon;
  document.getElementById('cModalTitle').textContent  = title;
  document.getElementById('cModalBody').textContent   = body;
  document.getElementById('cModalActions').innerHTML  = actions;
  document.getElementById('contactModalOverlay').style.display = 'flex';
}
function closeContactModal() {
  document.getElementById('contactModalOverlay').style.display = 'none';
}
function showStudioContactModal() { showContactModal('studio'); }
function closeStudioContactModal() { closeContactModal(); }
