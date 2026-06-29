/* ═══════════════════════════════════════════════════════════
   Barkhaus — booking.js
   Booking flow: config, state, UI, collect, submit
   Depends on: pricing.js, validation.js
   ═══════════════════════════════════════════════════════════ */


// ── CONFIG ──
var SUPABASE_URL        = 'https://dxttnbtfhpanyiyduevn.supabase.co';
var CREATE_PAYMENT_URL  = SUPABASE_URL + '/functions/v1/create-payment';
var CREATE_MAYA_CHECKOUT_URL = SUPABASE_URL + '/functions/v1/create-maya-checkout';
var PAYMENT_STATUS_URL  = SUPABASE_URL + '/functions/v1/get-payment-status';
var GET_UPLOAD_URL      = SUPABASE_URL + '/functions/v1/get-upload-url';
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s';
var EDGE_FN_URL       = SUPABASE_URL + '/functions/v1/submit-booking';

// Customer-facing payment provider. Alternatives: "manual", "maya", and "paymongo".
var PAYMENT_GATEWAY_PROVIDER = 'maya';

function hostedPaymentEndpoint() {
  return PAYMENT_GATEWAY_PROVIDER === 'maya' ? CREATE_MAYA_CHECKOUT_URL : CREATE_PAYMENT_URL;
}

function currentConvenienceFee() {
  return booking && booking.simulatePayment ? 0 : CONVENIENCE_FEE;
}

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
  basic:     ['face_trim','antitick','whitening','demat','deshed','premium_shampoo'],
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
var BOOKING_PARAMS = new URLSearchParams(window.location.search);
var IS_WALKIN = BOOKING_PARAMS.get('walkin') === '1';
var WALKIN_TOKEN = BOOKING_PARAMS.get('token') || '';
var TEST_PAYMENT_MODE = BOOKING_PARAMS.get('testPayment') === '1';
var _walkinGatePromise = null;

if (IS_WALKIN) {
  CONVENIENCE_FEE = 0;
  // The Edge Function validates and consumes this single-use token on submit.
  _walkinGatePromise = Promise.resolve(!!WALKIN_TOKEN);
}

// ── STATE ──
// Live data from DB (populated on init)
var liveRooms    = [];   // rooms[] from Supabase for current branch
var liveGroomers = [];   // groomers[] from Supabase for current branch
var liveStudios      = [];   // studios[] from Supabase for current branch
var liveStudioBlocks = [];   // studio_blocks[] for current branch studios

var booking = {
  location:null, service:null,
  // Grooming
  petSize:null, groomService:null, groomServicePrice:0, selectedAddons:{},
  groomDate:null, groomSlot:null, preferredStylist:null, preferredStylistId:null, groomNotes:'',
  // Hotel
  hotelCheckin:null, hotelCheckout:null, hotelRoomType:null, hotelRoomId:null, hotelRoomName:null,
  hotelBaseTotal:0, hotelLateTotal:0, hotelLateIsAdditionalNight:false,
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
  // Test-only checkout shortcut
  simulatePayment:false,
};
var currentStep = 1;
var saveDetails = false;
var uploadedVaccineFiles = [];
var uploadedGroomPegs = [];   // grooming reference photos ("pegs")
var secondCatVisible = false;

// ── Manual transfer payment (active while hosted gateways remain dormant) ──
var onPaymentScreen     = false;
var paymentReceiptFile  = null;   // the single uploaded receipt File
var selectedPaymentBank = 'gcash';
var ACCOUNT_NAME = 'Jayson E. Endicio';
var PAYMENT_METHODS = {
  gcash: { label: 'GCash', account: '0917 1468032',  raw: '09171468032',  name: 'GCash account', qr: 'images/payment/gcash-qr.png' },
  bpi:   { label: 'BPI',   account: '3509 005841',   raw: '3509005841',   name: 'BPI account',   qr: 'images/payment/bpi-qr.png' },
  bdo:   { label: 'BDO',   account: '0035 2034 7924', raw: '003520347924', name: 'BDO account',   qr: null },
};

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
  if (TEST_PAYMENT_MODE) {
    var simCard = document.getElementById('simulatePaymentCard');
    if (simCard) simCard.style.display = '';
  }
  if (IS_WALKIN) {
    var banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(107,203,119,0.15);border-bottom:0.5px solid rgba(107,203,119,0.3);padding:8px 16px;font-size:12px;color:#6BCB77;font-weight:600;text-align:center;';
    banner.textContent = '🚶 Walk-in booking — payment collected at counter';
    document.body.insertBefore(banner, document.body.firstChild);
  }
  var paymentPreparationNotice = document.getElementById('paymentPreparationNotice');
  if (paymentPreparationNotice && (IS_WALKIN || PAYMENT_GATEWAY_PROVIDER === 'manual')) {
    paymentPreparationNotice.style.display = 'none';
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
    // Manual transfer charges no convenience fee. Hosted providers use the
    // configured pricing-table fee when enabled later.
    if (PAYMENT_GATEWAY_PROVIDER === 'manual') CONVENIENCE_FEE = 0;
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
var _handlingHostedPaymentReturn = false;
var _checkingStoredPaymentRef = false;

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
  if (onPaymentScreen) { backFromPayment(); return; }
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
// ── Manual transfer payment page (online flow) ──
function showPaymentPage() {
  if (!_pricingLoaded) { showToast('Pricing data is unavailable. Please refresh the page and try again.', 7000); return; }
  collectAllState();
  onSummaryScreen = false;
  onPaymentScreen = true;
  var ss = document.getElementById('stepSummary'); if (ss) ss.classList.remove('active');
  document.getElementById('progressWrap').style.display = 'none';
  var pp = document.getElementById('stepPayment'); if (pp) pp.classList.add('active');

  var amt = getRunningTotal(); // subtotal − member discount (convenience fee is 0)
  document.getElementById('payAmount').textContent = '₱' + (amt || 0).toLocaleString();

  var btns = document.getElementById('payBankBtns');
  btns.innerHTML = Object.keys(PAYMENT_METHODS).map(function(k){
    return '<button type="button" class="pay-bank-btn" data-bank="'+k+'" onclick="renderPaymentMethod(\''+k+'\')">'+PAYMENT_METHODS[k].label+'</button>';
  }).join('');
  renderPaymentMethod(selectedPaymentBank || 'gcash');

  // Restore a previously chosen receipt (e.g. returning after an error)
  var _up = document.getElementById('payUploadLabel');
  var _prev = document.getElementById('payReceiptPreview');
  if (paymentReceiptFile) {
    document.getElementById('payUploadText').textContent = '✓ ' + paymentReceiptFile.name + ' — tap to change';
    _up.classList.add('has-file');
    _prev.innerHTML = '<img class="pay-receipt-thumb" src="'+URL.createObjectURL(paymentReceiptFile)+'" alt="Receipt preview">';
    _prev.style.display = 'block';
  } else {
    document.getElementById('payUploadText').textContent = '📎 Tap to attach receipt image';
    _up.classList.remove('has-file');
    _prev.style.display = 'none'; _prev.innerHTML = '';
  }

  document.getElementById('btnBack').style.display = '';
  var next = document.getElementById('btnNext');
  next.textContent = 'Submit Payment';
  next.className = 'btn-submit';
  next.onclick = function(){ submitBooking(); };
  refreshPaymentSubmit();
  window.scrollTo(0,0);
}

function renderPaymentMethod(bank) {
  selectedPaymentBank = bank;
  var m = PAYMENT_METHODS[bank]; if (!m) return;
  document.querySelectorAll('#payBankBtns .pay-bank-btn').forEach(function(b){
    b.classList.toggle('selected', b.getAttribute('data-bank') === bank);
  });
  var html = '';
  if (m.qr) html += '<img class="pay-qr" src="'+m.qr+'" alt="'+m.label+' QR code" onerror="this.style.display=\'none\'">';
  html += '<div class="pay-acct-list">' +
            '<div class="pay-acct-row">' +
              '<span class="pay-acct-label">Account no.</span>' +
              '<span class="pay-acct-num">'+m.account+'</span>' +
              '<button type="button" class="pay-copy-btn" onclick="copyAccount(\''+m.raw+'\', this)">Copy</button>' +
            '</div>' +
            '<div class="pay-acct-row">' +
              '<span class="pay-acct-label">Account name</span>' +
              '<span class="pay-acct-num" style="font-size:14px">'+ACCOUNT_NAME+'</span>' +
              '<button type="button" class="pay-copy-btn" onclick="copyAccount(\''+ACCOUNT_NAME+'\', this)">Copy</button>' +
            '</div>' +
          '</div>' +
          '<p class="pay-acct-name">Scan the QR or send to the '+m.label+' account above.</p>';
  document.getElementById('payMethodDetail').innerHTML = html;
}

function copyAccount(raw, btn) {
  function done(){ btn.textContent = 'Copied ✓'; btn.classList.add('copied'); setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('copied'); }, 1800); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(raw).then(done).catch(function(){ _legacyCopy(raw); done(); });
  } else { _legacyCopy(raw); done(); }
}
function _legacyCopy(text){ try{ var t=document.createElement('textarea'); t.value=text; t.style.position='fixed'; t.style.opacity='0'; document.body.appendChild(t); t.focus(); t.select(); document.execCommand('copy'); document.body.removeChild(t);}catch(e){} }

function onReceiptSelected(input) {
  var f = input.files && input.files[0];
  if (!f) return;
  if (!/^image\//.test(f.type)) { showToast('Please upload an image file (JPG or PNG).', 5000); input.value=''; return; }
  if (f.size > 5 * 1024 * 1024) { showToast('That image is too large. Please keep it under 5 MB.', 5000); input.value=''; return; }
  paymentReceiptFile = f;
  document.getElementById('payUploadText').textContent = '✓ ' + f.name + ' — tap to change';
  document.getElementById('payUploadLabel').classList.add('has-file');
  var prev = document.getElementById('payReceiptPreview');
  prev.innerHTML = '<img class="pay-receipt-thumb" src="'+URL.createObjectURL(f)+'" alt="Receipt preview">';
  prev.style.display = 'block';
  refreshPaymentSubmit();
}

function refreshPaymentSubmit() {
  if (!onPaymentScreen) return;
  var next = document.getElementById('btnNext');
  var ready = !!paymentReceiptFile && !!selectedPaymentBank;
  next.disabled = !ready;
  next.style.opacity = ready ? '' : '0.5';
}

function backFromPayment() {
  onPaymentScreen = false;
  var pp = document.getElementById('stepPayment'); if (pp) pp.classList.remove('active');
  showSummary();
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
  syncHostedCheckoutNotice();
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
    var wh = document.getElementById('waiverHouseRules');
    if (!wh || !wh.classList.contains('checked')) return false;
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
    if (svc === 'grooming') {
      var gp = document.getElementById('waiverGroomingPolicy');
      if (!gp || !gp.classList.contains('checked')) return false;
    }
    if (svc === 'hotel') {
      var hp = document.getElementById('waiverHotelCancellation');
      if (!hp || !hp.classList.contains('checked')) return false;
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
  next.className = 'btn-submit';
  next.disabled = false;
  if (IS_WALKIN) {
    // Walk-in pays at the counter — no online transfer page.
    next.textContent = 'Confirm Booking';
    next.onclick = function() { submitBooking(); };
  } else if (PAYMENT_GATEWAY_PROVIDER === 'manual') {
    next.textContent = 'Proceed to Payment';
    next.onclick = function() { showPaymentPage(); };
  } else {
    next.textContent = 'Proceed to Secure Checkout';
    next.onclick = function() { submitBooking(); };
  }
  var total = getRunningTotal();
  var navEl = document.getElementById('navTotal');
  if (total > 0) {
    document.getElementById('navTotalVal').textContent = '₱' + (total + currentConvenienceFee()).toLocaleString();
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
  var discountable = 0;
  if (svc === 'grooming') {
    raw = (booking.groomServicePrice || 0) +
      Object.keys(booking.selectedAddons).reduce(function(a,k) {
        return a + (ADDONS.find(function(x){return x.key===k;}) ? booking.selectedAddons[k] : 0);
      }, 0);
    discountable = booking.groomServicePrice || 0;
  } else if (svc === 'hotel') {
    raw = (booking.hotelBaseTotal || 0) + (booking.hotelLateTotal || 0);
    discountable = booking.hotelBaseTotal || 0;
  } else if (svc === 'daycare') {
    raw = booking.daycareTotal || 0;
    discountable = raw;
  }
  return raw - calculateMemberDiscount(svc, discountable, booking.memberValid);
}

// ── LOCATION ──
function selectLocation(el, val) {
  document.querySelectorAll('#step1 .option-card').forEach(function(c) { c.classList.remove('selected'); });
  el.classList.add('selected');
  booking.location = val;
  // Reset live data for new branch
  liveRooms = []; liveGroomers = []; liveStudios = []; liveStudioBlocks = [];
  window._branchIds = null;
  // Membership validity is branch-dependent (Standard memberships are branch-bound) —
  // force re-verification after a branch change so a discount can't carry across branches.
  booking.memberValid = false;
  var _mvMsg = document.getElementById('memberValidMsg');
  if (_mvMsg) _mvMsg.style.display = 'none';
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

function setValue(id, value) {
  var el = document.getElementById(id);
  if (el) el.value = value;
}

function setChecked(id, checked) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('checked', !!checked);
}

function clearActivePanels() {
  document.querySelectorAll('.step-panel').forEach(function(panel) {
    panel.classList.remove('active');
  });
}

function startSimulatedPaymentFlow() {
  if (!TEST_PAYMENT_MODE) return;
  var today = localDateStr();

  booking.location = 'eastwood';
  booking.service = 'daycare';
  booking.simulatePayment = true;
  booking.petSize = 'small_dog';
  booking.daycareBaseRate = 1;
  booking.daycareTotal = 1;
  booking.daycareDate = today;
  booking.daycareOpenTime = false;
  booking.daycareDropoffHour = 10;
  booking.daycarePickupHour = 13;
  booking.daycareDropoffText = '10:00 AM';
  booking.daycarePickupText = '1:00 PM';
  booking.daycareNotes = 'Simulated Maya payment test booking.';
  booking.petName = 'Maya Test';
  booking.petAnimal = 'dog';
  booking.petGender = 'male';
  booking.petBreed = 'Mixed';
  booking.petAge = '2';
  booking.petAgeUnit = 'years';
  booking.petMedical = '';
  booking.petTemperament = 'friendly_all';
  booking.isMember = false;
  booking.membershipId = null;
  booking.memberValid = false;
  booking.ownerFirst = 'Maya';
  booking.ownerLast = 'Tester';
  booking.ownerEmail = 'maya-test@barkhaus.ph';
  booking.ownerPhone = '09171234567';
  booking.ownerSource = 'Website';

  uploadedVaccineFiles = [];
  paymentReceiptFile = null;

  setValue('daycareDate', today);
  onDaycareDateChange();
  setValue('daycareDropoff', '10');
  setValue('daycarePickup', '13');
  setValue('daycareNotes', booking.daycareNotes);
  booking.daycareBaseRate = 1;
  booking.daycareTotal = 1;

  setValue('petName', booking.petName);
  setValue('petBreed', booking.petBreed);
  setValue('petAgeNum', booking.petAge);
  setValue('petAgeUnit', booking.petAgeUnit);
  setValue('petMedical', '');
  setValue('ownerFirst', booking.ownerFirst);
  setValue('ownerLast', booking.ownerLast);
  setValue('ownerEmail', booking.ownerEmail);
  setValue('ownerPhone', booking.ownerPhone);
  setValue('ownerSource', booking.ownerSource);
  setValue('ownerSourceOther', '');

  document.querySelectorAll('#step1 .option-card').forEach(function(card) { card.classList.remove('selected'); });
  var simCard = document.getElementById('simulatePaymentCard');
  if (simCard) simCard.classList.add('selected');
  document.querySelectorAll('#serviceGrid .option-card').forEach(function(card) { card.classList.remove('selected'); });
  document.querySelectorAll('#daycareSizeGrid .pet-type-btn').forEach(function(btn) { btn.classList.remove('selected'); });
  var smallBtn = document.querySelector('#daycareSizeGrid .pet-type-btn[onclick*="small_dog"]');
  if (smallBtn) smallBtn.classList.add('selected');
  document.querySelectorAll('#petTypeGroup .gender-btn').forEach(function(btn) { btn.classList.remove('selected'); });
  var dogBtn = document.getElementById('petTypeDog');
  if (dogBtn) dogBtn.classList.add('selected');
  document.querySelectorAll('#petGenderGrid .gender-btn').forEach(function(btn) { btn.classList.remove('selected'); });
  var maleBtn = document.querySelector('#petGenderGrid .gender-btn[onclick*="male"]');
  if (maleBtn) maleBtn.classList.add('selected');
  document.querySelectorAll('.temp-btn').forEach(function(btn) { btn.classList.remove('selected'); });
  var friendlyBtn = document.querySelector('.temp-btn[onclick*="friendly_all"]');
  if (friendlyBtn) friendlyBtn.classList.add('selected');

  renderVaccines();
  setChecked('bringVaccines', true);
  setChecked('vaccineWaiver', true);
  setChecked('waiverGeneralDaycare', true);
  setChecked('waiverVaccineDecl', true);
  setChecked('waiverMedia', true);
  checkSeniorWaiver();

  currentStep = 7;
  onPaymentScreen = false;
  onSummaryScreen = false;
  clearActivePanels();
  document.getElementById('progressWrap').style.display = 'none';
  showSummary();
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
  var discount = calculateMemberDiscount('grooming', base, booking.memberValid);
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

// Duration in minutes per service key. Dematting or deshedding adds one
// 30-minute buffer, so Bath & Dry becomes 60 minutes and Basic becomes 90.
var GROOM_SLOT_MINS = { bath_dry:30, basic:60, premium:120, ala_carte:60 };
var GROOM_DURATION_ADDONS = { demat:true, deshed:true };

function hasDurationAddonMap(addons) {
  return Object.keys(addons || {}).some(function(k){ return GROOM_DURATION_ADDONS[k]; });
}

function groomDurationMins(serviceKey, addons) {
  return (GROOM_SLOT_MINS[serviceKey || 'basic'] || 60) + (hasDurationAddonMap(addons) ? 30 : 0);
}

// Parse a slot string like "9:00 AM" into minutes since midnight
function slotToMins(slot) {
  var m = slot.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  var h = parseInt(m[1]), min = parseInt(m[2]), ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function timeValueToMins(value) {
  var display = slotToMins(String(value || ''));
  if (display >= 0) return display;
  var parts = String(value || '').split(':');
  if (parts.length < 2) return -1;
  var hour = parseInt(parts[0]), minute = parseInt(parts[1]);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return -1;
  return hour * 60 + minute;
}

function groomingSlotsForServiceHours(serviceHours, fallback) {
  if (serviceHours == null) return fallback;
  var valid = serviceHours.map(function(row) {
    return { start: timeValueToMins(row.start_time), last: timeValueToMins(row.last_service_time) };
  }).filter(function(row) { return row.start >= 0 && row.last >= row.start; });
  if (!valid.length) return [];
  var first = Math.min.apply(null, valid.map(function(row){ return row.start; }));
  var last  = Math.max.apply(null, valid.map(function(row){ return row.last; }));
  var slots = [];
  // Customer-facing starts are intentionally hourly. Admins retain half-hour
  // precision for operational scheduling and can use the gaps as buffers.
  for (var mins = Math.ceil(first / 60) * 60; mins <= last; mins += 60) {
    var hour24 = Math.floor(mins / 60), minute = mins % 60;
    var ap = hour24 >= 12 ? 'PM' : 'AM';
    slots.push((hour24 % 12 || 12) + ':' + String(minute).padStart(2, '0') + ' ' + ap);
  }
  return slots;
}

function serviceWindowForGroomer(serviceHours, groomerId) {
  if (serviceHours == null) return null;
  var row = serviceHours.find(function(hours) {
    return hours.resource_id === groomerId && hours.active !== false;
  });
  if (!row) return false;
  var start = timeValueToMins(row.start_time);
  var end = timeValueToMins(row.end_time);
  var last = timeValueToMins(row.last_service_time);
  if (start < 0 || end <= start || last < start || last > end) return false;
  return { start:start, end:end, last:last };
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
  var myDuration = groomDurationMins(serviceKey, booking.selectedAddons);
  var FALLBACK_SLOTS = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM'];

  // Which groomers to consider
  var groomerPool = isAny
    ? liveGroomers
    : liveGroomers.filter(function(g){ return g.id === groomerId; });

  grid.innerHTML = '<p style="font-size:12px;color:var(--mid);padding:8px 0">Checking availability...</p>';
  if (!groomerPool.length) {
    grid.innerHTML = '<p style="font-size:12px;color:var(--error);padding:8px 0">No groomer is available for this selection.</p>';
    return;
  }

  // Helper: parse "HH:MM" or "HH:MM:SS" → minutes since midnight
  function parseTMins(t) {
    var p = (t||'').split(':');
    return parseInt(p[0]||0)*60 + parseInt(p[1]||0);
  }

  // Helper: does [candStart, candEnd) overlap any range in the list?
  function overlaps(ranges, candStart, candEnd) {
    return ranges.some(function(r){ return candStart < r.end && candEnd > r.start; });
  }

  // All booking rows, service hours, and blocks fetched once for the whole pool.
  var bookingRows = [];
  var blockRows   = [];
  var serviceHours = null;

  try {
    var branchId = await getSelectedBranchId();
    if (!branchId || !dateVal) throw new Error('missing_context');

    // The RPC exposes only occupancy fields and filters inactive booking statuses
    // without making private parent booking rows readable to anonymous visitors.
    try {
      bookingRows = (await sbRpcPublic('get_grooming_occupancy', {
        p_branch_id: branchId,
        p_service_date: dateVal,
      })) || [];
      bookingRows.forEach(function(r) {
        r._durationAddons = r.has_duration_addon ? { demat:true } : null;
      });
    } catch(occupancyErr) {
      console.warn('Grooming occupancy check unavailable.', occupancyErr);
      throw new Error('occupancy_unavailable');
    }

    // 2. ALL one-off blocked_schedules for groomers on this date (no resource filter).
    //    rangesFor() does client-side resource filtering.
    var bsQuery = 'select=resource_id,start_time,end_time' +
      '&resource_type=eq.groomer&active=eq.true' +
      '&dates=cs.{' + dateVal + '}';
    blockRows = (await sbFetchPublic('blocked_schedules', bsQuery)) || [];

    try {
      var serviceHoursQuery = 'select=resource_id,start_time,end_time,last_service_time,active' +
        '&branch_id=eq.' + branchId + '&resource_type=eq.groomer' +
        '&service_date=eq.' + dateVal + '&active=eq.true' +
        '&resource_id=in.(' + liveGroomers.map(function(g){ return g.id; }).join(',') + ')';
      serviceHours = (await sbFetchPublic('resource_service_hours', serviceHoursQuery)) || [];
    } catch(hoursErr) {
      console.warn('Service-hours migration not available yet; using legacy grooming hours.', hoursErr);
      serviceHours = null;
    }

  } catch(e) {
    console.warn('Slot availability check failed:', e);
    grid.innerHTML = '<p style="font-size:12px;color:var(--error);padding:8px 0">Could not verify grooming availability. Please try again.</p>';
    return;
  }

  var ALL_SLOTS = groomingSlotsForServiceHours(serviceHours, FALLBACK_SLOTS);

  // Build the full blocked-ranges list for a given groomer
  function rangesFor(gId) {
    var ranges = [];
    // Active bookings
    bookingRows.filter(function(r){ return r.groomer_id === gId && r.timeslot; }).forEach(function(r) {
      var dur = groomDurationMins(r.groom_service_key || 'basic', r._durationAddons);
      var st  = slotToMins(r.timeslot);
      if (st >= 0) ranges.push({ start: st, end: st + dur });
    });
    // One-off blocked schedules
    blockRows.filter(function(b){ return b.resource_id === gId; }).forEach(function(b) {
      ranges.push({ start: parseTMins(b.start_time), end: parseTMins(b.end_time) });
    });
    return ranges;
  }

  var availableSlots = ALL_SLOTS.filter(function(slot) {
    var candStart = slotToMins(slot);
    var candEnd   = candStart + myDuration;
    function canServe(groomer) {
      var window = serviceWindowForGroomer(serviceHours, groomer.id);
      if (window === false) return false;
      if (window && (candStart < window.start || candStart > window.last || candEnd > window.end)) return false;
      return !overlaps(rangesFor(groomer.id), candStart, candEnd);
    }
    if (isAny) {
      // Count how many groomers in the pool are actually free at this slot
      var freeCount = groomerPool.filter(canServe).length;
      // Also count unassigned (groomer_id = null) bookings that overlap this slot —
      // each one consumes one of the free groomers, so it must be deducted.
      var unassignedCount = bookingRows.filter(function(r) {
        if (r.groomer_id != null) return false;
        if (!r.timeslot) return false;
        var dur = groomDurationMins(r.groom_service_key || 'basic', r._durationAddons);
        var st  = slotToMins(r.timeslot);
        return st >= 0 && candStart < st + dur && candEnd > st;
      }).length;
      // Available only if more free groomers remain after accounting for unassigned bookings
      return freeCount > unassignedCount;
    } else {
      // Is this specific groomer scheduled and free?
      var selectedGroomer = groomerPool.find(function(g){ return g.id === groomerId; });
      if (!selectedGroomer || !canServe(selectedGroomer)) return false;
      // Would unassigned bookings overflow into this groomer?
      // Count other groomers (not this one) who are free at this slot.
      var otherFreeCount = liveGroomers.filter(function(g) {
        return g.id !== groomerId && canServe(g);
      }).length;
      var unassignedAtSlot = bookingRows.filter(function(r) {
        if (r.groomer_id != null) return false;
        if (!r.timeslot) return false;
        var dur = groomDurationMins(r.groom_service_key || 'basic', r._durationAddons);
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

var HOTEL_EARLY_DROPOFF_START = 7;   // members-only early drop-off opens at 7:00 AM

function populateHotelDropoffTimes() {
  var checkin = document.getElementById('hotelCheckin').value;
  var sel     = document.getElementById('hotelDropoffTime');
  if (!checkin) { sel.innerHTML = '<option value="">Select date first</option>'; sel.removeAttribute('data-mall-open'); return; }
  var hours = getHotelHours(checkin, booking.location);
  // Allow early drop-off from 7:00 AM; hours before mall opening are members-only.
  var earliest = Math.min(HOTEL_EARLY_DROPOFF_START, hours.start);
  sel.setAttribute('data-mall-open', hours.start);
  var html = '<option value="">Select time</option>';
  for (var h = earliest; h <= hours.end; h++) {
    var isEarly = h < hours.start;
    html += '<option value="' + h + '">' + hotelTimeLabel(h) + (isEarly ? ' (Early — members only)' : '') + '</option>';
  }
  sel.innerHTML = html;
  if (booking.hotelDropoffTime) sel.value = booking.hotelDropoffTime;
  onHotelDropoffChange();
}

// Show the members-only note whenever the chosen drop-off is before mall opening.
function onHotelDropoffChange() {
  var sel  = document.getElementById('hotelDropoffTime');
  var note = document.getElementById('hotelEarlyDropoffNote');
  if (!sel || !note) return;
  var mallOpen = parseInt(sel.getAttribute('data-mall-open'), 10);
  var val      = parseInt(sel.value, 10);
  var isEarly  = !isNaN(val) && !isNaN(mallOpen) && val < mallOpen;
  note.style.display = isEarly ? 'block' : 'none';
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
      var detailRows;
      try {
        detailRows = await sbRpcPublic('get_hotel_occupancy', {
          p_branch_id: branch,
          p_checkin: cin,
          p_checkout: cout,
        });
      } catch(occupancyErr) {
        console.warn('Hotel occupancy check unavailable.', occupancyErr);
        throw new Error('occupancy_unavailable');
      }
      (detailRows || []).forEach(function(r) {
        var key = r.room_id || r.room_type;
        if (key) bookedRoomIds[key] = (bookedRoomIds[key] || 0) + 1;
      });
    }
  } catch(e) {
    console.error('Hotel availability check failed:', e);
    loading.style.display = 'none';
    grid.innerHTML = '<p style="font-size:12px;color:var(--error);padding:8px 0">Could not verify room availability. Please try again.</p>';
    return;
  }

  loading.style.display = 'none';

  if (!eligibleRooms.length) {
    grid.innerHTML = '<p style="font-size:12px;color:var(--error);padding:8px 0">No eligible rooms are available for this pet size.</p>';
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
      '&active=eq.true&order=sort_order.asc.nullslast,name.asc');
  } catch(e) { liveRooms = []; }
  try {
    liveGroomers = await sbFetchPublic('groomers',
      'select=id,name,color,schedule_restrictions,is_unavailable' +
      '&branch_id=eq.' + branchId +
      '&active=eq.true&is_unavailable=eq.false&order=sort_order.asc.nullslast,name.asc');
  } catch(e) { liveGroomers = []; }
  try {
    liveStudios = await sbFetchPublic('studios',
      'select=id,name,color,schedule_restrictions,is_unavailable' +
      '&branch_id=eq.' + branchId +
      '&active=eq.true&order=sort_order.asc.nullslast,name.asc');
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

function getStudioBlocksForDay(studioId, dow) {
  return liveStudioBlocks.filter(function(bl) {
    return bl.studio_id === studioId &&
      (bl.days_of_week.length === 0 || bl.days_of_week.indexOf(dow) !== -1);
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
  if (feeEl) feeEl.textContent = '+₱' + HOTEL_LATE_RATE.toLocaleString() + '/hour from 2:00–8:00 PM';
}

function hotelLateCharge(pickupHour, checkoutDate, rateSize) {
  var hour = parseInt(pickupHour) || 14;
  if (hour > 20) {
    var checkout = checkoutDate ? new Date(checkoutDate + ' 00:00:00') : null;
    var dow = checkout && !isNaN(checkout.getTime()) ? checkout.getDay() : 1;
    var dayType = (dow === 0 || dow === 5 || dow === 6) ? 'weekend' : 'weekday';
    return {
      amount: (HOTEL_RATES[dayType] && HOTEL_RATES[dayType][rateSize]) || 0,
      additionalNight: true,
      lateHours: 0
    };
  }
  var lateHours = Math.max(0, hour - 14);
  return {
    amount: lateHours * HOTEL_LATE_RATE,
    additionalNight: false,
    lateHours: lateHours
  };
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
  var lateCharge = hotelLateCharge(pickupHour, cout, rateSize);
  var lateHours  = lateCharge.lateHours;
  booking.hotelLateTotal = lateCharge.amount;
  booking.hotelLateIsAdditionalNight = lateCharge.additionalNight;

  // Show / hide the late pick-up fee note below the selector
  var lateNoteEl = document.getElementById('hotelLatePickupNote');
  if (lateNoteEl) {
    if (booking.hotelLateTotal > 0) {
      lateNoteEl.innerHTML = lateCharge.additionalNight
        ? '<strong>Additional night:</strong> +&#8369;' + booking.hotelLateTotal.toLocaleString() + ' (pick-up after 8:00 PM)'
        : '<strong>Late pick-up fee:</strong> +&#8369;' + booking.hotelLateTotal.toLocaleString() +
          ' (' + lateHours + ' hr' + (lateHours !== 1 ? 's' : '') + ' &times; &#8369;' + HOTEL_LATE_RATE.toLocaleString() + '/hr)';
      lateNoteEl.style.display = '';
    } else {
      lateNoteEl.style.display = 'none';
    }
  }

  var subtotal = baseTotal + booking.hotelLateTotal;
  var discount = calculateMemberDiscount('hotel', baseTotal, booking.memberValid);
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
      var lateLabel = lateCharge.additionalNight ? 'Additional night (pick-up after 8:00 PM)' : 'Late pick-up fee ('+lateHours+' hr'+(lateHours!==1?'s':'')+')';
      s4html += '<div class="price-line component"><span class="price-line-label">'+lateLabel+'</span><span class="price-line-val">&#8369;'+booking.hotelLateTotal.toLocaleString()+'</span></div>';
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
  var ALL_SLOTS = ['10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM',
    '4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM','9:00 PM'];
  var dow = new Date(dateVal + 'T00:00:00').getDay();

  // Show loading state
  grid.innerHTML = '<p style="font-size:12px;color:var(--mid);padding:8px 0">Checking availability…</p>';

  var studioPool = liveStudios.filter(function(s) { return !s.is_unavailable; });

  var bookingRows = [];
  var blockRows   = [];

  try {
    var branchId = await getSelectedBranchId();
    if (!branchId || !studioPool.length) throw new Error('missing_context');

    bookingRows = (await sbRpcPublic('get_studio_occupancy', {
      p_branch_id: branchId,
      p_service_date: dateVal,
    })) || [];

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
    console.warn('Studio slot availability check failed:', e);
    grid.innerHTML = '<p style="font-size:12px;color:var(--error);padding:8px 0">Could not verify studio availability. Please try again.</p>';
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
  var discount = calculateMemberDiscount('daycare', subtotal, booking.memberValid);
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
function handleGroomPegFiles(input) {
  var list = document.getElementById('groomPegList');
  for (var i = 0; i < input.files.length; i++) {
    (function(file) {
      if (!/^image\//.test(file.type)) { showToast('Please upload an image file (JPG, PNG or WEBP).', 5000); return; }
      if (file.size > 5 * 1024 * 1024) { showToast('"' + file.name + '" is over 5MB. Please upload a smaller image.', 5000); return; }
      uploadedGroomPegs.push(file);
      var item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = '&#128247; ' + file.name + '<span class="file-remove" onclick="removeGroomPeg(this,\'' + file.name + '\')">x</span>';
      list.appendChild(item);
    })(input.files[i]);
  }
  input.value = '';   // allow re-selecting the same file after a remove
}
function removeGroomPeg(el, name) {
  uploadedGroomPegs = uploadedGroomPegs.filter(function(f){return f.name!==name;});
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
    } else if (member.active === false) {
      msg.textContent = 'This membership is inactive.'; msg.style.color = 'var(--error)';
      booking.memberValid = false;
    } else if (member.valid_until && new Date(member.valid_until + 'T23:59:59') < new Date()) {
      msg.textContent = 'This membership expired on ' + member.valid_until + '.'; msg.style.color = 'var(--error)';
      booking.memberValid = false;
    } else if (member.tier !== 'passport' && member.branch_id && member.branch_id !== (await getSelectedBranchId())) {
      // Standard membership is valid only at its home branch; Passport works anywhere.
      msg.textContent = 'This membership can only be used at its home branch.'; msg.style.color = 'var(--error)';
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
    houseRules: 'Dogs without a valid vaccination record will not be allowed entry into the Play Park area. Owners must present their dog\'s updated vaccination record upon check-in for verification. Day Care guests without presented or updated vaccination records may still be admitted, subject to hotel room availability, but will be required to stay inside the Dog Hotel with an additional PHP 100 charge. Timeouts using a leash or cage may be implemented for reasons including rough or inappropriate play, aggressive behavior toward other dogs, guests, or staff, signs of exhaustion or overstimulation, scheduled meal times, designated rest and quiet periods, and nighttime sleeping hours for hotel guests. These measures are intended to ensure the safety, comfort, and well-being of all dogs in our care while maintaining a calm and positive environment. Owners and companions using the Indoor Play Park are responsible for supervising and monitoring their own dogs at all times. Our daycare attendants are always available to assist whenever needed. A PHP 250 late pickup penalty will be charged for daycare guests picked up after mall operating hours. The safety of all dog guests, human companions, and daycare attendants remains our highest priority at all times. Guests are expected to treat all Barkhaus staff members with respect at all times. The use of profanity, abusive language, or inappropriate behavior toward our staff will not be tolerated.',
    groomingPolicy: 'All grooming appointments are scheduled in advance and reserved exclusively for each client. Appointment slots are fixed and cannot be moved once confirmed; however, a fifteen (15)-minute grace period will be provided to accommodate unforeseen delays. Clients who fail to arrive within the allotted grace period may forfeit their appointment slot, and the reserved time may be reassigned to another client. To ensure smooth scheduling and fairness to all guests, rescheduling requests will only be accommodated once and must be communicated to Barkhaus at least three (3) hours prior to the scheduled appointment time. All down payments made for grooming appointments are strictly non-refundable, including cases of no-shows, late arrivals resulting in forfeited slots, or cancelled appointments. Owners are expected to pick up their dogs promptly after grooming services are completed. Failure to do so may require Barkhaus to extend the dog\'s stay for additional hours or overnight care, which will be subject to corresponding boarding or extended care charges.',
    hotelCancellation: 'To confirm all reservations, a non-refundable advance payment is required. Guests who wish to cancel or re-book their booking must notify management in advance. Cancellations made at least seven (7) days prior to the scheduled check-in date will be eligible for a refund equivalent to fifty percent (50%) of the total amount paid. Cancellations made six (6) days or less before the scheduled check-in date will only be eligible for a refund equivalent to twenty-five percent (25%) of the total amount paid. One-time rescheduling of bookings may be accommodated provided the request is made at least seven (7) days before the original check-in date and is subject to availability. Rescheduled bookings are considered final and may no longer be eligible for additional changes, cancellations, or refunds. Failure to arrive on the scheduled check-in date without prior notice will be considered a "No Show," and all payments made will be forfeited. Approved refunds will be processed within three (3) to seven (7) banking days.',
  };
  texts.houseRules = WAIVER_TEXT.houseRules;
  texts.general  = WAIVER_TEXT[svc] || '';
  if (svc === 'grooming') texts.groomingPolicy = WAIVER_TEXT.groomingPolicy;
  if (svc === 'hotel') texts.hotelCancellation = WAIVER_TEXT.hotelCancellation;
  texts.vaccine  = WAIVER_TEXT.vaccine;
  texts.media    = WAIVER_TEXT.media;
  if (booking.playparkConsent) texts.playpark = WAIVER_TEXT.playpark;
  var seniorSec = document.getElementById('seniorWaiverSection');
  if (seniorSec && seniorSec.style.display !== 'none') texts.senior = WAIVER_TEXT.senior;
  return texts;
}
function buildSummary() {
  collectAllState();
  ensureSummaryMarkup();
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
  var detailsSummaryEl = document.getElementById('bookingDetailsSummary');
  if (!detailsSummaryEl) return;
  detailsSummaryEl.innerHTML = groups.map(function(g) {
    if (!g.rows.length) return '';
    return '<div class="summary-group"><div class="summary-group-title">'+g.title+'</div>' +
      g.rows.map(renderRow).join('') + '</div>';
  }).join('');
  // \u2500\u2500 Price breakdown \u2500\u2500
  var lines = [];
  var subtotal = 0;
  var discountable = 0;
  if (svc === 'grooming') {
    if (booking.groomService) {
      var svcObj = GROOM_SERVICES.find(function(s){return s.key===booking.groomService;});
      if (svcObj && booking.groomServicePrice > 0) {
        lines.push({ label:svcObj.name, val:'\u20b1'+booking.groomServicePrice.toLocaleString(), amount:booking.groomServicePrice });
        subtotal += booking.groomServicePrice;
        discountable += booking.groomServicePrice;
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
        discountable += wdTotal;
      }
      if (weCount > 0) {
        var weRate = HOTEL_RATES.weekend[rateSize]||0;
        lines.push({ label: weCount+' weekend/holiday night'+(weCount!==1?'s':'')+' \u00d7 \u20b1'+weRate.toLocaleString()+' ('+roomLabel+')', val:'\u20b1'+weTotal.toLocaleString(), amount:weTotal });
        subtotal += weTotal;
        discountable += weTotal;
      }
    }
    if (booking.hotelLateTotal > 0) {
      lines.push({ label:booking.hotelLateIsAdditionalNight ? 'Additional night (pickup after 8 PM)' : 'Late pickup fee', val:'\u20b1'+booking.hotelLateTotal.toLocaleString(), amount:booking.hotelLateTotal });
      subtotal += booking.hotelLateTotal;
    }
  } else if (svc === 'daycare') {
    var dH = booking.daycareDropoffHour;
    var pH = booking.daycarePickupHour;
    var hrs = booking.daycareOpenTime ? 'Open time' : (pH - dH) + ' hour' + ((pH-dH)!==1?'s':'');
    lines.push({ label:'Daycare ('+hrs+')', val:'\u20b1'+booking.daycareTotal.toLocaleString(), amount:booking.daycareTotal });
    subtotal += booking.daycareTotal;
    discountable += booking.daycareTotal;
  }
  var html = lines.map(function(l) {
    return '<div class="price-line component">' +
      '<span class="price-line-label">'+l.label+'</span>' +
      '<span class="price-line-val'+(l.assess?' assess':'')+'">'+l.val+'</span>' +
      '</div>';
  }).join('');
  if (subtotal > 0) {
    var discRate = booking.memberValid ? (MEMBER_DISCOUNT[svc]||0) : 0;
    var discAmt  = calculateMemberDiscount(svc, discountable, booking.memberValid);
    var fee      = currentConvenienceFee();
    var total    = subtotal - discAmt + fee;
    // Always show subtotal when there are components so the hierarchy is clear
    html += '<div class="price-line subtotal-line"><span class="price-line-label">Subtotal</span><span class="price-line-val">\u20b1'+subtotal.toLocaleString()+'</span></div>';
    if (discAmt > 0) {
      var discPct = Math.round(discRate * 100);
      html += '<div class="price-line"><span class="price-line-label">Member discount ('+discPct+'%)</span><span class="price-line-val discount">-\u20b1'+discAmt.toLocaleString()+'</span></div>';
    }
    if (fee > 0) html += '<div class="price-line"><span class="price-line-label">Convenience fee</span><span class="price-line-val">\u20b1'+fee.toLocaleString()+'</span></div>';
    html += '<div class="price-line total-line"><span class="price-line-label">Total</span><span class="price-line-val">\u20b1'+total.toLocaleString()+'</span></div>';
  }
  var priceBreakdownEl = document.getElementById('priceBreakdown');
  if (priceBreakdownEl) priceBreakdownEl.innerHTML = html || '<div class="price-line"><span class="price-line-label">No price estimate available</span><span class="price-line-val">-</span></div>';
}

function ensureSummaryMarkup() {
  var summary = document.getElementById('stepSummary');
  if (!summary) return;
  if (document.getElementById('bookingDetailsSummary') && document.getElementById('priceBreakdown')) return;
  summary.innerHTML =
    '<p class="step-eyebrow">Almost done!</p>' +
    '<h1 class="step-title">Review your booking</h1>' +
    '<p class="step-subtitle">Please confirm the details below before submitting.</p>' +
    '<div class="info-box payment-heads-up" id="hostedCheckoutNotice">' +
      '<p><strong>Next: secure payment through Maya</strong></p>' +
      '<p>You will be redirected to a Maya checkout page that may display <strong>BARKHAUS EASTWOOD</strong>, even when your booking is for Estancia. This is our registered business account name and does not change your selected branch.</p>' +
      '<p>After payment, please take a screenshot of Maya&rsquo;s payment confirmation for your records.</p>' +
    '</div>' +
    '<div class="summary-card" id="bookingDetailsSummary"></div>' +
    '<p class="section-label">Price breakdown</p>' +
    '<div class="price-breakdown" id="priceBreakdown"></div>';
}

function syncHostedCheckoutNotice() {
  var notice = document.getElementById('hostedCheckoutNotice');
  if (!notice) return;
  notice.style.display = (!IS_WALKIN && PAYMENT_GATEWAY_PROVIDER !== 'manual') ? '' : 'none';
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
// Hosted-checkout redirect. Renders grouped sections + itemised pricing
// so the customer has a complete record of every detail they submitted.
function renderSuccessDetails(snap, detailsId, priceId) {
  if (!snap) return;
  var bk  = snap.bookingState || {};
  var svc = bk.service || '';
  renderSuccessPolicyNotice(svc);

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
      var lateLabel = bk.hotelLateIsAdditionalNight
        ? 'Additional night (pick-up after 8:00 PM)'
        : 'Late pick-up fee ('+(bk.hotelLateTotal / (HOTEL_LATE_RATE||100))+' hr'+((bk.hotelLateTotal / (HOTEL_LATE_RATE||100))!==1?'s':'')+' × ₱'+(HOTEL_LATE_RATE||100).toLocaleString()+'/hr)';
      plines.push({ label: lateLabel, amount: bk.hotelLateTotal });
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
    var discPct = Math.round((MEMBER_DISCOUNT[svc] || 0) * 100);
    ph += '<div class="price-line"><span class="price-line-label">Member discount'+(discPct?(' ('+discPct+'%)'):'')+' </span><span class="price-line-val discount">−₱'+snap.discountAmount.toLocaleString()+'</span></div>';
  }
  if ((snap.convenienceFee||0) > 0) {
    ph += '<div class="price-line"><span class="price-line-label">Convenience fee</span><span class="price-line-val">₱'+snap.convenienceFee.toLocaleString()+'</span></div>';
  }
  ph += '<div class="price-line total-line"><span class="price-line-label">Total Paid</span><span class="price-line-val">₱'+snap.total.toLocaleString()+'</span></div>';

  var priceEl = document.getElementById(priceId || 'successPriceBreakdown');
  if (priceEl) priceEl.innerHTML = ph;
}

function renderSuccessPolicyNotice(service) {
  var el = document.getElementById('successPolicyNotice');
  if (!el) return;
  var html = '';
  if (service === 'grooming') {
    html =
      '<strong>Grooming changes and cancellations</strong><br>' +
      'A one-time reschedule may be requested at least <strong>3 hours before</strong> the appointment. ' +
      'There is a <strong>15-minute grace period</strong>; arriving later may forfeit the reserved slot. ' +
      'All grooming down payments are <strong>non-refundable</strong>, including no-shows, late arrivals that forfeit the slot, and cancellations.';
  } else if (service === 'hotel') {
    html =
      '<strong>Hotel changes, cancellations, and refunds</strong><br>' +
      'A one-time reschedule may be requested at least <strong>7 days before check-in</strong>, subject to availability. ' +
      'Cancellations at least 7 days before check-in are eligible for a <strong>50% refund</strong>; cancellations 6 days or less before check-in are eligible for a <strong>25% refund</strong>. ' +
      'Rescheduled bookings are final, no-shows forfeit all payments, and approved refunds are processed within <strong>3-7 banking days</strong>.';
  }
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
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

// ── HANDLE RETURN FROM HOSTED PAYMENT PROVIDER ──
function showHostedPaymentChecking(ref) {
  document.querySelectorAll('.step-panel, #successScreen, #payReturnScreen').forEach(function(el) {
    el.classList.remove('active');
  });
  var pw = document.getElementById('progressWrap');
  var bn = document.getElementById('bottomNav');
  var ss = document.getElementById('stepSummary');
  var pr = document.getElementById('payReturnScreen');
  if (pw) pw.style.display = 'none';
  if (bn) bn.style.display = 'none';
  if (pr) pr.style.display = 'none';
  if (ss) {
    var displayRef = ref ? String(ref).replace(/[^A-Za-z0-9_-]/g, '') : '';
    ss.innerHTML =
      '<div class="pay-loading">' +
      '<div class="bh-spinner"></div>' +
      '<p class="pay-loading-text">Checking your payment...</p>' +
      '<p style="font-size:12px;color:var(--mid);margin-top:14px;line-height:1.7;max-width:300px;margin-left:auto;margin-right:auto">' +
      'Please wait while we confirm your booking' + (displayRef ? ' <strong style="color:var(--cream)">' + displayRef + '</strong>' : '') + '.</p>' +
      '</div>';
    ss.classList.add('active');
  }
}

function showHostedPaymentSuccess(ref) {
  // Hide ALL steps and the step UI, show only success screen
  document.querySelectorAll('.step-panel, #successScreen, #payReturnScreen').forEach(function(el) {
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
}

(async function checkPaymentReturn() {
  var params = new URLSearchParams(window.location.search);
  var status = params.get('payment');
  var ref    = params.get('ref');
  if (!status) return;
  _handlingHostedPaymentReturn = true;
  try {
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);

    // Maya may return through failure/cancel URLs even after a wallet screen shows
    // success. Always reconcile by booking ref before deciding which screen to show.
    var paymentState = null;
    if (ref && (status === 'success' || status === 'cancelled' || status === 'failed')) {
      showHostedPaymentChecking(ref);
      paymentState = await waitForHostedPaymentState(ref);
      if (paymentState && paymentState.confirmed) {
        showHostedPaymentSuccess(ref);
        return;
      }
    }

    if (status === 'success' && ref) {
      if (!paymentState || !paymentState.confirmed) {
        var pendingSnap = null;
        try { pendingSnap = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null'); } catch(e) {}
        if (pendingSnap) showPayReturnScreen(pendingSnap, ref);
        showToast('Payment is still being verified. Please keep your booking reference and check again shortly.', 8000);
        return;
      }
    } else if (status === 'cancelled' || status === 'failed') {
      if (paymentState && paymentState.status === 'pending' && paymentState.payment_status === 'unpaid') {
        var _pendingSnap = null;
        try { _pendingSnap = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null'); } catch(e) {}
        if (_pendingSnap) {
          showPayReturnScreen(_pendingSnap, ref || _pendingSnap.refNumber);
          var _pendingStatus = document.getElementById('payReturnStatus');
          if (_pendingStatus) _pendingStatus.textContent = 'Your payment is still being verified. Please wait a moment before retrying.';
        } else {
          showHostedPaymentChecking(ref);
        }
        showToast('Payment is still being verified. Please keep your booking reference and check again shortly.', 8000);
        return;
      }
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
  } finally {
    _handlingHostedPaymentReturn = false;
  }
})();

async function getHostedPaymentState(ref) {
  try {
    var res = await fetch(PAYMENT_STATUS_URL + '?ref=' + encodeURIComponent(ref), {
      headers: { 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY }
    });
    if (res.ok) return await res.json();
  } catch(e) {}
  return null;
}

async function waitForHostedPayment(ref) {
  var state = await waitForHostedPaymentState(ref);
  return !!(state && state.confirmed);
}

async function waitForHostedPaymentState(ref) {
  var latest = null;
  for (var attempt = 0; attempt < 10; attempt++) {
    var state = await getHostedPaymentState(ref);
    if (state) latest = state;
    if (state && state.confirmed) return state;
    if (state && state.status === 'cancelled' && state.payment_status !== 'unpaid') return state;
    await new Promise(function(resolve) { setTimeout(resolve, 2000); });
  }
  return latest;
}

// ── POLL FOR PAYMENT if ref is in sessionStorage (QR fallback) ──
// Preserve the pending reference across any hosted-checkout redirect.
setTimeout(checkStoredPaymentRef, 500);
window.addEventListener('pageshow', function() {
  setTimeout(checkStoredPaymentRef, 100);
});

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
async function checkStoredPaymentRef() {
  try {
    if (_handlingHostedPaymentReturn) return;
    if (_checkingStoredPaymentRef) return;
    var ref = sessionStorage.getItem('bk_pending_ref');
    if (!ref) return;
    _checkingStoredPaymentRef = true;
    // Already on success screen - clear and stop
    if (document.getElementById('successScreen') && document.getElementById('successScreen').classList.contains('active')) {
      sessionStorage.removeItem('bk_pending_ref');
      _checkingStoredPaymentRef = false;
      return;
    }
    var snap = null;
    try { snap = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null'); } catch(e) {}
    if (!snap) {
      _checkingStoredPaymentRef = false;
      return;
    }

    var pr = document.getElementById('payReturnScreen');
    if (pr && pr.classList.contains('active')) {
      _checkingStoredPaymentRef = false;
      return;
    }

    showPayReturnScreen(snap, ref || snap.refNumber);
    var statusEl = document.getElementById('payReturnStatus');
    if (statusEl) statusEl.textContent = 'Checking whether your payment went through...';

    if (await waitForHostedPayment(ref)) {
      showHostedPaymentSuccess(ref);
      _checkingStoredPaymentRef = false;
      return;
    }
    if (statusEl) statusEl.textContent = '';
  } catch(e) {
  } finally {
    _checkingStoredPaymentRef = false;
  }
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
    var latestState = await getHostedPaymentState(snap.refNumber);
    if (latestState && latestState.confirmed) {
      showHostedPaymentSuccess(snap.refNumber);
      return;
    }

    if (snap.refNumber && snap.cancellationToken) {
      if (statusEl) statusEl.textContent = 'Releasing your previous booking hold…';
      var released = await cancelPendingBooking(snap.refNumber, snap.cancellationToken);
      if (!released) {
        latestState = await getHostedPaymentState(snap.refNumber);
        if (latestState && latestState.confirmed) {
          showHostedPaymentSuccess(snap.refNumber);
          return;
        }
      }
    }

    snap.bookingId = null;
    snap.cancellationToken = null;
    var retryPayload = Object.assign({}, snap.rawPayload, {
      retry: true
    });
    var res  = await fetch(hostedPaymentEndpoint(), {
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
      snap.cancellationToken = data.cancellation_token || snap.cancellationToken;
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
// The checkout response returns a separate cancellation credential for this hold.
async function cancelPendingBooking(refNumber, cancellationToken) {
  if (!refNumber || !cancellationToken) return false;
  try {
    var res = await fetch(SUPABASE_URL + '/functions/v1/cancel-pending-booking', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':       SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ ref_number: refNumber, cancellation_token: cancellationToken }),
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
  if (typeof onHotelDropoffChange === 'function') onHotelDropoffChange();
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
  var cancelled = await cancelPendingBooking(snap.refNumber, snap.cancellationToken);
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
  _restoreCheck('waiverHouseRules',    _rp.waiverHouseRules);
  _restoreCheck('waiverGroomingPolicy', _rp.waiverGroomingPolicy);
  _restoreCheck('waiverHotelCancellation', _rp.waiverHotelCancellation);
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
// pg_cron should call expire_pending_bookings() so each pending checkout releases
// according to pending_bookings.expires_at (15 minutes for Maya):
//   SELECT cron.schedule(
//     'cancel-pending-bookings', '*/5 * * * *',
//     $$ SELECT public.expire_pending_bookings(); $$
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
      var dtRows = (await sbRpcPublic('get_hotel_occupancy', {
        p_branch_id: branchId,
        p_checkin: cin,
        p_checkout: cout,
      })) || [];
      if (dtRows.some(function(r){ return r.room_id === booking.hotelRoomId; })) {
        return { available: false, conflict: 'room' };
      }
      return { available: true };
    }

    if (svc === 'grooming') {
      var dateVal = booking.groomDate, slot = booking.groomSlot;
      if (!dateVal || !slot) return { available: true };
      var groomerId  = booking.preferredStylistId;
      var isAny      = !groomerId;
      var serviceKey = booking.groomService || 'basic';
      var myDuration = groomDurationMins(serviceKey, booking.selectedAddons);
      var candStart  = slotToMins(slot);
      var candEnd    = candStart + myDuration;
      var bkRows = (await sbRpcPublic('get_grooming_occupancy', {
        p_branch_id: branchId,
        p_service_date: dateVal,
      })) || [];
      bkRows.forEach(function(r) {
        r._durationAddons = r.has_duration_addon ? { demat:true } : null;
      });
      var serviceHours = null;
      try {
        serviceHours = (await sbFetchPublic('resource_service_hours',
          'select=resource_id,start_time,end_time,last_service_time,active' +
          '&branch_id=eq.' + branchId + '&resource_type=eq.groomer' +
          '&service_date=eq.' + dateVal + '&active=eq.true')) || [];
      } catch(hoursErr) {
        console.warn('Service-hours migration not available during submit recheck.', hoursErr);
      }
      var blockRows = [];
      try {
        blockRows = (await sbFetchPublic('blocked_schedules',
          'select=resource_id,start_time,end_time&resource_type=eq.groomer&active=eq.true' +
          '&dates=cs.{' + dateVal + '}')) || [];
      } catch(blockErr) {
        console.warn('Could not load grooming blocks during submit recheck.', blockErr);
      }
      function isGroomerFree(gId) {
        var window = serviceWindowForGroomer(serviceHours, gId);
        if (window === false) return false;
        if (window && (candStart < window.start || candStart > window.last || candEnd > window.end)) return false;
        var booked = bkRows.filter(function(r){ return r.groomer_id === gId && r.timeslot; })
          .some(function(r) {
            var dur = groomDurationMins(r.groom_service_key || 'basic', r._durationAddons);
            var st  = slotToMins(r.timeslot);
            return st >= 0 && candStart < (st + dur) && candEnd > st;
          });
        if (booked) return false;
        return !blockRows.some(function(block) {
          if (block.resource_id !== gId) return false;
          var start = timeValueToMins(block.start_time), end = timeValueToMins(block.end_time);
          return start >= 0 && candStart < end && candEnd > start;
        });
      }
      var unassignedAtSlot = bkRows.filter(function(r) {
        if (r.groomer_id != null) return false;
        var dur = groomDurationMins(r.groom_service_key || 'basic', r._durationAddons);
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
    console.warn('Pre-payment availability check error:', e);
    return { available: false, conflict: svc === 'hotel' ? 'room' : 'slot' };
  }
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

// ── SUBMIT (manual transfer or hosted-checkout redirect) ──
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
  var discountable = 0;
  if (svc === 'grooming') {
    subtotal = (booking.groomServicePrice||0) + Object.keys(booking.selectedAddons).reduce(function(a,k){return a+(booking.selectedAddons[k]||0);},0);
    discountable = booking.groomServicePrice || 0;
  } else if (svc === 'hotel') {
    subtotal = (booking.hotelBaseTotal||0) + (booking.hotelLateTotal||0);
    discountable = booking.hotelBaseTotal || 0;
  } else if (svc === 'daycare') {
    subtotal = booking.daycareTotal || 0;
    discountable = subtotal;
  }
  var discAmt  = calculateMemberDiscount(svc, discountable, booking.memberValid);
  var fee      = currentConvenienceFee();
  var total    = subtotal - discAmt + fee;

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
          body: JSON.stringify({
            uploadId: uploadId, fileName: _vf.name, contentType: _vf.type,
            fileSize: _vf.size, purpose: 'vaccine_document', vaccineKey: _vKey
          }),
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

  // ── Upload grooming reference photos ("pegs") ──
  // Same pipeline as vaccine docs: signed PUT to the vaccine-docs bucket, paths
  // passed to submit-booking which inserts grooming_reference_images rows.
  var groomReferenceImages = {};
  var groomReferenceFileNames = {};
  if (booking.service === 'grooming' && uploadedGroomPegs && uploadedGroomPegs.length > 0) {
    var pegUploadId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'pegs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    for (var _pi = 0; _pi < uploadedGroomPegs.length; _pi++) {
      var _pf = uploadedGroomPegs[_pi];
      var _pKey = 'peg_' + _pi;
      try {
        var _pUrlRes = await fetch(GET_UPLOAD_URL, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
            'apikey':        SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            uploadId: pegUploadId, fileName: _pf.name, contentType: _pf.type,
            fileSize: _pf.size, purpose: 'grooming_reference', vaccineKey: _pKey
          }),
        });
        var _pUrlData = await _pUrlRes.json();
        if (_pUrlData.uploadUrl && _pUrlData.path) {
          await fetch(_pUrlData.uploadUrl, { method: 'PUT', body: _pf, headers: { 'Content-Type': _pf.type } });
          groomReferenceImages[_pKey] = _pUrlData.path;
          groomReferenceFileNames[_pKey] = _pf.name;
        }
      } catch (_pe) {
        console.warn('Grooming reference upload failed (non-fatal):', _pf.name, _pe);
      }
    }
  }

  // ── Upload the manual-transfer receipt (manual provider only) ──
  var paymentReceiptPath = null, paymentReceiptName = null, paymentReceiptUploadToken = null;
  if (!IS_WALKIN && PAYMENT_GATEWAY_PROVIDER === 'manual' && paymentReceiptFile) {
    try {
      var _rId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'receipt-' + Date.now();
      var _rRes = await fetch(GET_UPLOAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({
          uploadId: _rId, fileName: paymentReceiptFile.name,
          contentType: paymentReceiptFile.type, fileSize: paymentReceiptFile.size,
          purpose: 'manual_payment_receipt', vaccineKey: 'receipt'
        }),
      });
      var _rData = await _rRes.json();
      if (_rData.uploadUrl && _rData.path) {
        await fetch(_rData.uploadUrl, { method: 'PUT', body: paymentReceiptFile, headers: { 'Content-Type': paymentReceiptFile.type } });
        paymentReceiptPath = _rData.path;
        paymentReceiptName = paymentReceiptFile.name;
        paymentReceiptUploadToken = _rData.authorizationToken || null;
      }
    } catch (_re) { console.warn('Receipt upload failed:', _re); }
    if (!paymentReceiptPath || !paymentReceiptUploadToken) {
      _submitting = false;
      showToast('Could not upload your receipt. Please check your connection and try again.', 6000);
      if (btn) { btn.textContent = 'Submit Payment'; btn.disabled = false; btn.style.opacity = ''; }
      return;
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
    waiverHouseRules:document.getElementById('waiverHouseRules').classList.contains('checked'),
    waiverGroomingPolicy:document.getElementById('waiverGroomingPolicy')?document.getElementById('waiverGroomingPolicy').classList.contains('checked'):false,
    waiverHotelCancellation:document.getElementById('waiverHotelCancellation')?document.getElementById('waiverHotelCancellation').classList.contains('checked'):false,
    waiverVaccine:document.getElementById('waiverVaccineDecl').classList.contains('checked'),
    waiverSeniorMedical:document.getElementById('seniorWaiver')?document.getElementById('seniorWaiver').classList.contains('checked'):false,
    waiverStudio:document.getElementById('waiverStudio')?document.getElementById('waiverStudio').classList.contains('checked'):false,
    waiverMedia:document.getElementById('waiverMedia').classList.contains('checked'),
    waiverPlaypark:document.getElementById('waiverPlaypark')?document.getElementById('waiverPlaypark').classList.contains('checked'):false,
    waiverTexts: buildWaiverTexts(),
    subtotal:subtotal, discountAmount:discAmt, convenienceFee:fee, total:total,
    hotelLateTotal:    booking.hotelLateTotal    || 0,
    hotelLateIsAdditionalNight: !!booking.hotelLateIsAdditionalNight,
    groomServicePrice: booking.groomServicePrice || 0,
    vaccineDocuments:  vaccineDocuments,
    vaccineFileNames:  vaccineFileNames,
    groomReferenceImages:    groomReferenceImages,
    groomReferenceFileNames: groomReferenceFileNames,
    bringVaccines: (function(){ var el=document.getElementById('bringVaccines'); return !!(el && el.classList.contains('checked')); })(),
    // Walk-in bookings go through submit-booking (creates all child records,
    // no payment), so flag them as admin-created with a walkin source.
    adminCreated:  IS_WALKIN,
    booking_source: IS_WALKIN ? 'walkin' : 'online',
    walkinToken: IS_WALKIN ? WALKIN_TOKEN : null,
    // The manual provider records a receipt for staff verification. Hosted
    // providers ignore this null field.
    manualPayment: (!IS_WALKIN && PAYMENT_GATEWAY_PROVIDER === 'manual' && paymentReceiptPath) ? {
      method:          selectedPaymentBank,
      receiptPath:     paymentReceiptPath,
      receiptFileName: paymentReceiptName,
      uploadToken:     paymentReceiptUploadToken,
    } : null,
  };

  // Show loading state. Move the spinner to the summary panel (and away from the
  // payment form) so that error/timeout recovery — which rebuilds the summary —
  // always has a valid panel to land on. The receipt stays in paymentReceiptFile,
  // so re-entering the payment page restores it.
  if (!IS_WALKIN && onPaymentScreen) {
    onPaymentScreen = false; onSummaryScreen = true;
    var _ppHide = document.getElementById('stepPayment'); if (_ppHide) _ppHide.classList.remove('active');
    var _ssShow = document.getElementById('stepSummary'); if (_ssShow) _ssShow.classList.add('active');
  }
  var _loadHead = IS_WALKIN ? 'Recording your booking...' : 'Confirming your booking...';
  var _loadSub  = IS_WALKIN
    ? 'Saving your booking — payment will be collected at the counter.'
    : 'We&rsquo;re recording your payment and confirming your booking. This will only take a moment.';
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
    _submitting = false;
    buildSummary();
    updateBottomNavForSummary();  // restores the correct button label + enabled state
    showToast('Request timed out. Please try again.', 5000);
  }, 30000);

  // Manual/walk-in submissions create the booking immediately. Hosted providers
  // create a pending booking and redirect to their secure checkout page.
  var paymentEndpoint = PAYMENT_GATEWAY_PROVIDER === 'manual' ? EDGE_FN_URL : hostedPaymentEndpoint();
  fetch(paymentEndpoint, {
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
        convenienceFee: fee, total: total,
        bookingId: data.booking_id || null,
        pendingId: data.pending_id || null,
        refNumber: data.ref_number || null,
        cancellationToken: data.cancellation_token || null,
        bookingState: JSON.parse(JSON.stringify(booking)),
        rawPayload: payload
      }));
    } catch(e) {}
    if (!IS_WALKIN && PAYMENT_GATEWAY_PROVIDER !== 'manual') {
      if (!data.checkout_url) throw new Error('No checkout URL returned by payment provider');
      _redirectingToPayment = true;
      window.location.href = data.checkout_url;
      return;
    }
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
    // Online manual-transfer path → booking is confirmed while staff verifies the receipt.
    var refNumOnline = data.ref_number || data.booking_id || 'BK-' + Date.now();
    document.querySelectorAll('.step-panel').forEach(function(el){ el.classList.remove('active'); });
    var pwO = document.getElementById('progressWrap'); if (pwO) pwO.style.display = 'none';
    var bnO = document.getElementById('bottomNav');    if (bnO) bnO.style.display = 'none';
    var ssO = document.getElementById('successScreen');
    if (ssO) { ssO.style.display = ''; ssO.classList.add('active'); }
    setSuccessTimestamp(refNumOnline);
    var msgO = ssO ? ssO.querySelector('.success-msg') : null;
    if (msgO) msgO.textContent = 'Your booking is confirmed and your payment has been received. A confirmation email is on its way — please arrive 15 minutes early.';
    try {
      var snapO = JSON.parse(sessionStorage.getItem('bk_snapshot') || 'null');
      if (snapO) { renderSuccessDetails(snapO, 'successDetails', 'successPriceBreakdown'); sessionStorage.removeItem('bk_snapshot'); }
    } catch(e) {}
  })
  .catch(function(err) {
    _submitting = false;
    clearTimeout(payTimeout);
    console.error('Payment error:', err);
    buildSummary();
    updateBottomNavForSummary();  // restores the correct button label + enabled state
    showToast('Connection error: ' + err.message, 6000);
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
