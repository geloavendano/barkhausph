/* ═══════════════════════════════════════════════════════════
   Barkhaus — index.js  v1
   Public site JavaScript (extracted from index.html)
   Includes dynamic images from Supabase Storage + blog from DB
   ═══════════════════════════════════════════════════════════ */

/* ── CONFIG ─────────────────────────────────────────────── */
var SB_URL      = 'https://dxttnbtfhpanyiyduevn.supabase.co';
var SB_ANON     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s';
var STORAGE_PUB = SB_URL + '/storage/v1/object/public/site-images';


/* ── STORAGE ─────────────────────────────────────────────── */

/* List one folder in the site-images bucket, return sorted public URLs */
async function storageList(folder) {
  try {
    var r = await fetch(SB_URL + '/storage/v1/object/list/site-images', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: folder + '/', limit: 100, sortBy: { column: 'name', order: 'asc' } }),
    });
    if (!r.ok) return [];
    var files = await r.json();
    return files
      .filter(function(f) { return f.id && f.name; })
      .map(function(f) { return STORAGE_PUB + '/' + folder + '/' + encodeURIComponent(f.name); });
  } catch (e) { return []; }
}

/* Load all gallery folders from Storage in parallel */
async function loadStorageImages() {
  var folders = ['hero', 'estancia', 'eastwood', 'playpark', 'daycare', 'hotel', 'grooming', 'studio', 'events', 'store', 'cafe'];
  var out = {};
  await Promise.all(folders.map(async function(folder) {
    var urls = await storageList(folder);
    if (urls.length) out[folder] = urls;
  }));
  return out;
}

/* After initial render, replace img srcs with Storage versions */
function upgradeImagesFromStorage(storageImgs) {
  /* Hero */
  if (storageImgs.hero && storageImgs.hero.length) {
    var heroEl = document.getElementById('img-hero');
    if (heroEl) heroEl.src = storageImgs.hero[0];
  }

  /* Branch images */
  var branchMap = { b1: 'estancia', b2: 'eastwood' };
  Object.keys(branchMap).forEach(function(key) {
    var imgs = storageImgs[branchMap[key]];
    if (!imgs || !imgs.length) return;
    locImages[key] = imgs;
    var mainCont = document.getElementById(key + '-main');
    if (mainCont) { var mainImg = mainCont.querySelector('img'); if (mainImg) mainImg.src = imgs[0]; }
    imgs.forEach(function(src, i) {
      var el = document.querySelector('[data-img="' + key + '-' + i + '"]');
      if (el) el.src = src;
    });
  });

  /* Service gallery images */
  services.forEach(function(s, i) {
    var imgs = storageImgs[s.imgKey];
    if (!imgs || !imgs.length) return;
    if (imgs.length === 1) imgs = [imgs[0], imgs[0], imgs[0]];
    var key = 'svc' + i;
    _svcImgSets[key] = imgs;
    svcCarousels[i] = { idx: 0, imgs: imgs };
    var slide = document.getElementById('svc-slide-' + i);
    if (!slide) return;
    /* Rebuild the entire thumbnail block so count matches Storage */
    var imgCol = slide.querySelector('.svc-img-col');
    if (imgCol) {
      imgCol.innerHTML = buildSvcThumbnailsHtml(imgs, i, s.name);
    } else {
      /* Service had no images initially — insert the img col before text col */
      var textCol = slide.querySelector('.svc-text-col');
      var newCol = document.createElement('div');
      newCol.className = 'svc-img-col';
      newCol.innerHTML = buildSvcThumbnailsHtml(imgs, i, s.name);
      if (textCol) slide.insertBefore(newCol, textCol);
    }
  });
}


/* ── BLOG ────────────────────────────────────────────────── */

async function loadBlogPosts() {
  try {
    var r = await fetch(
      SB_URL + '/rest/v1/blog_posts?active=eq.true&order=sort_order&select=slug,title,excerpt,cover_image_path,tag',
      { headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON } }
    );
    return r.ok ? r.json() : null;
  } catch (e) { return null; }
}

var _ARROW_SVG = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

function renderBlogCards(posts) {
  var track = document.getElementById('blogTrack');
  if (!track) return;
  if (!posts || !posts.length) {
    var section = document.getElementById('blog');
    if (section) section.style.display = 'none';
    return;
  }
  track.innerHTML = posts.map(function(p) {
    var imgSrc = p.cover_image_path
      ? STORAGE_PUB + '/blog/' + encodeURIComponent(p.cover_image_path)
      : '';
    return '<a class="blog-card" href="blog/' + p.slug + '.html">' +
      (imgSrc ? '<img class="blog-card-img" src="' + imgSrc + '" alt="' + p.title + '" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
      (p.tag ? '<span class="blog-card-tag">' + p.tag + '</span>' : '') +
      '<p class="blog-card-title">' + p.title + '</p>' +
      '<p class="blog-card-excerpt">' + (p.excerpt || '') + '</p>' +
      '<span class="blog-card-cta">Read article ' + _ARROW_SVG + '</span>' +
      '</a>';
  }).join('');
}


/* ── LOCATION DATA + FUNCTIONS ──────────────────────────── */

var locImages = {
  b1: typeof BARKHAUS_IMAGES !== 'undefined' ? BARKHAUS_IMAGES.b1 : [],
  b2: typeof BARKHAUS_IMAGES !== 'undefined' ? BARKHAUS_IMAGES.b2 : [],
};

var locations = [
  {
    key: 'b1', name: 'Estancia',
    addr: '2nd Floor Main Wing at Estancia Mall, Capitol Commons, Pasig City',
    hours: 'Mon-Thu 11AM-9PM\nFri-Sun 10AM-10PM',
    maps: 'https://maps.app.goo.gl/YrzAVYHE8G6982gz8',
    mainId: 'b1-main', thumbsId: 'b1-thumbs', modal: null,
  },
  {
    key: 'b2', name: 'Eastwood',
    addr: '4th Floor Eastwood Mall, Libis, Quezon City',
    hours: '10AM-10PM everyday',
    maps: 'https://maps.app.goo.gl/yPbYz7y2urnmLAuU6',
    mainId: 'b2-main', thumbsId: 'b2-thumbs', modal: null,
  },
  {
    key: 'b3', name: 'Greenhills',
    addr: 'GF Pet Stop, Connecticut Bldg., Greenhills Shopping Center, San Juan, Metro Manila',
    hours: 'Opening soon',
    maps: '#',
    mainId: null, thumbsId: null, modal: null,
  },
];

var currentLoc = 0, autoTimer, userNavigated = false;

function switchLoc(idx, userAction) {
  if (userAction) stopAuto();
  currentLoc = idx;
  document.getElementById('locSlides').style.transform = 'translateX(' + (-idx * 100) + '%)';
  document.querySelectorAll('.loc-tab').forEach(function(t, i) { t.classList.toggle('active', i === idx); });
  document.querySelectorAll('.loc-dot').forEach(function(d, i) { d.classList.toggle('active', i === idx); });
  var l = locations[idx];
  document.getElementById('locName').textContent = l.name;
  document.getElementById('locAddr').textContent = l.addr;
  document.getElementById('locHours').innerHTML = l.hours.replace('\n', '<br>');
  var mapsEl = document.getElementById('locMaps');
  if (mapsEl) { mapsEl.href = l.maps; mapsEl.style.display = l.maps === '#' ? 'none' : ''; }
}

function switchThumb(locKey, imgIdx, el) {
  stopAuto();
  var loc = locations.find(function(l) { return l.key === locKey; });
  var img = document.getElementById(loc.mainId).querySelector('img');
  if (locImages[locKey][imgIdx]) img.src = locImages[locKey][imgIdx];
  el.closest('.loc-thumbs').querySelectorAll('.loc-thumb').forEach(function(t) { t.classList.remove('active'); });
  el.classList.add('active');
}

function restartAuto() {
  if (userNavigated) return;
  clearInterval(autoTimer);
  autoTimer = setInterval(function() {
    if (!userNavigated) switchLoc((currentLoc + 1) % locations.length, false);
  }, 4500);
}

function stopAuto() { userNavigated = true; clearInterval(autoTimer); }

/* Location modal — HTML trigger not wired up yet, kept for future use */
function openModal(idx) {
  var l = locations[idx]; if (!l || !l.modal) return;
  var m = l.modal;
  document.getElementById('modal-tag').textContent = m.tag;
  document.getElementById('modal-name').textContent = l.name;
  document.getElementById('modal-subtitle').textContent = m.subtitle;
  document.getElementById('modal-desc-1').textContent = m.desc1;
  document.getElementById('modal-desc-2').textContent = m.desc2;
  document.getElementById('modal-element').textContent = m.element;
  document.getElementById('modal-element-desc').textContent = m.elementDesc;
  document.getElementById('modal-features').innerHTML = m.features.map(function(f) {
    return '<div class="loc-modal-feature"><div class="loc-modal-feature-dot"></div>' +
      '<div class="loc-modal-feature-text"><strong>' + f.label + '</strong>' +
      (f.detail ? ' - ' + f.detail : '') + '</div></div>';
  }).join('');
  document.getElementById('modal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
function closeModalOnOverlay(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}


/* ── SERVICE DATA ────────────────────────────────────────── */

var services = [
  {
    tag: 'Play', name: 'Indoor Play Park', imgKey: 'playpark',
    desc: 'Our indoor play park is a safe, climate-controlled space designed to keep dogs active, social, and mentally stimulated, rain or shine.',
    features: [
      { label: 'Assisted play sessions',  detail: 'Trained staff on-site to assist you' },
      { label: 'Spacious open layout',    detail: 'For free play and group activities' },
      { label: 'Indoor area',             detail: 'Weather-proof fun, always' },
      { label: 'Comfort zones',           detail: 'Available for rest and cool-downs' },
    ],
    pricing: '<div class="svc-price-row"><span class="svc-price-label">Entrance (2 hrs)<br><small style="font-size:0.82em;color:var(--mid);font-weight:400">1 Pet and 1 Human Companion</small></span><span class="svc-price-val">₱350</span></div><div class="svc-price-row"><span class="svc-price-label">Extra Person</span><span class="svc-price-val">+₱100</span></div><div class="svc-price-row"><span class="svc-price-label">Succeeding Hour</span><span class="svc-price-val">+₱100</span></div>',
  },
  {
    tag: 'Daycare', name: 'Day Care', imgKey: 'daycare',
    desc: 'Drop off your pet and leave them in great hands. Our Day Care is designed for owners who need a full day away — your dog enjoys supervised play and socialisation while you focus on your day.',
    features: [
      { label: 'Drop-off and go',  detail: 'No need to stay — we take it from here' },
      { label: 'Supervised all day', detail: 'Staff always present' },
      { label: 'Play and rest time', detail: 'Balanced schedule for your pet' },
      { label: 'Daily updates',    detail: 'Know how your pet is doing' },
    ],
    pricing: '<div class="svc-price-row"><span class="svc-price-label">Small Dog (up to 3hrs)</span><span class="svc-price-val">₱500</span></div><div class="svc-price-row"><span class="svc-price-label">Medium Dog (up to 3hrs)</span><span class="svc-price-val">₱550</span></div><div class="svc-price-row"><span class="svc-price-label">Large Dog (up to 3hrs)</span><span class="svc-price-val">₱650</span></div><div class="svc-price-row"><span class="svc-price-label">Additional hour (Dogs)</span><span class="svc-price-val">+₱100</span></div><div class="svc-price-row"><span class="svc-price-label">Cat (up to 3hrs)</span><span class="svc-price-val">₱300</span></div><div class="svc-price-row"><span class="svc-price-label">Additional hour (Cats)</span><span class="svc-price-val">+₱50</span></div>',
  },
  {
    tag: 'Stay', name: 'Pet Hotel', imgKey: 'hotel',
    desc: 'Your pet deserves a vacation too. Our Pet Hotel offers cozy, private accommodations with attentive care — so you can travel worry-free knowing your furry family member is in great hands. Cat boarding is also available at our Eastwood branch.',
    features: [
      { label: 'Dog & cat rooms available', detail: 'Cat boarding at Eastwood branch' },
      { label: '24/7 staff presence',       detail: 'We never leave them alone' },
      { label: 'Regular feeding, rest and play time', detail: 'Follows your pet\'s schedule' },
      { label: 'Daily photo updates',       detail: 'See how they\'re doing anytime' },
    ],
    pricing: '<div class="svc-price-row"><span class="svc-price-label">Small Dog - Mon-Thu</span><span class="svc-price-val">₱1,200/night</span></div><div class="svc-price-row"><span class="svc-price-label">Small Dog - Fri-Sun</span><span class="svc-price-val">₱1,300/night</span></div><div class="svc-price-row"><span class="svc-price-label">Medium Dog - Mon-Thu</span><span class="svc-price-val">₱1,300/night</span></div><div class="svc-price-row"><span class="svc-price-label">Medium Dog - Fri-Sun</span><span class="svc-price-val">₱1,400/night</span></div><div class="svc-price-row"><span class="svc-price-label">Large Dog - Mon-Thu</span><span class="svc-price-val">₱1,500/night</span></div><div class="svc-price-row"><span class="svc-price-label">Large Dog - Fri-Sun</span><span class="svc-price-val">₱1,600/night</span></div><div class="svc-price-row"><span class="svc-price-label">Late pickup (after 2PM)</span><span class="svc-price-val">+₱100/hr</span></div><div class="svc-price-row"><span class="svc-price-label">Cat Single Cabin</span><span class="svc-price-val">₱700/night</span></div><div class="svc-price-row"><span class="svc-price-label">Cat Villa</span><span class="svc-price-val">₱1,000/night</span></div>',
  },
  {
    tag: 'Care', name: 'Grooming', imgKey: 'grooming',
    desc: 'From baths to blowouts, nail trims to full grooms - our grooming team treats every pet like a star. We use gentle, pet-safe products so your fur baby comes out looking and feeling their best.',
    features: [
      { label: 'Full bath & blow dry',             detail: 'Breed-appropriate in-house shampoo' },
      { label: 'Haircut & styling',                detail: 'Breed cuts or custom styles' },
      { label: 'Nail trim, ear cleaning and more', detail: 'Included in Basic and Premium Groom' },
      { label: 'Walk-ins welcome',                 detail: 'Subject to availability' },
    ],
    pricing: '<div class="svc-price-row"><span class="svc-price-label">Bath and Dry<button class="price-info-btn" onclick="showPriceInfo(event,\'bath_dry\')">ⓘ</button></span><span class="svc-price-val">₱450-₱750</span></div><div class="svc-price-row"><span class="svc-price-label">Basic Groom<button class="price-info-btn" onclick="showPriceInfo(event,\'basic\')">ⓘ</button></span><span class="svc-price-val">₱650-₱1,250</span></div><div class="svc-price-row"><span class="svc-price-label">Premium Groom<button class="price-info-btn" onclick="showPriceInfo(event,\'premium\')">ⓘ</button></span><span class="svc-price-val">₱850-₱1,450</span></div><div class="svc-price-row"><span class="svc-price-label">Face Trim<button class="price-info-btn" onclick="showPriceInfo(event,\'face_trim\')">ⓘ</button></span><span class="svc-price-val">₱200-₱450</span></div><div class="svc-price-row"><span class="svc-price-label">Add-ons<button class="price-info-btn" onclick="showPriceInfo(event,\'addons\')">ⓘ</button></span><span class="svc-price-val">from ₱100</span></div>',
  },
  {
    tag: 'Capture', name: 'BarkStudio', imgKey: 'studio',
    desc: 'Capture unforgettable moments at our professional studio — perfect for timeless pet portraits, either solo or with their fur parents.',
    features: [
      { label: 'Multiple colored backdrops', detail: 'Choose from available colors' },
      { label: 'Studio lights & props provided', detail: 'Everything you need, ready to go' },
      { label: 'Hourly booking',             detail: 'Take your time, no rush' },
      { label: 'Eastwood only',              detail: 'Available at our Eastwood branch' },
    ],
    pricing: '<div class="svc-price-row" style="padding-bottom:2px"><span class="svc-price-label" style="font-weight:700;color:var(--yellow)">Package A</span><span class="svc-price-val">₱899</span></div><div class="svc-price-row" style="padding-top:0;padding-bottom:8px;border-bottom:1px solid var(--border)"><span class="svc-price-label" style="font-size:0.82em;color:var(--cream-m);line-height:1.6">15 min shoot · 1 pax, 1 pet<br>1 Backdrop · 1 4R Photo Edit<br>1 Collage Photo Edit · Soft Copies</span></div><div class="svc-price-row" style="padding-bottom:2px;padding-top:8px"><span class="svc-price-label" style="font-weight:700;color:var(--yellow)">Package B</span><span class="svc-price-val">₱1,499</span></div><div class="svc-price-row" style="padding-top:0;padding-bottom:8px;border-bottom:1px solid var(--border)"><span class="svc-price-label" style="font-size:0.82em;color:var(--cream-m);line-height:1.6">30 min shoot · 5 pax, 2 pets<br>2 Backdrops · 2 4R Photo Edit<br>3 Collage · 4 Strips Photo Edit · Soft Copies</span></div><div class="svc-price-row" style="padding-bottom:2px;padding-top:8px"><span class="svc-price-label" style="font-weight:700;color:var(--cream)">Add-ons</span></div><div class="svc-price-row" style="padding-top:0"><span class="svc-price-label">Additional 1 Pax</span><span class="svc-price-val">+₱150</span></div><div class="svc-price-row"><span class="svc-price-label">Additional 1 Dog</span><span class="svc-price-val">+₱150</span></div><div class="svc-price-row"><span class="svc-price-label">Additional 10 mins</span><span class="svc-price-val">+₱500</span></div>',
  },
  {
    tag: 'Events', name: 'Events', imgKey: 'events',
    desc: 'Throwing a party? Make it a Barkhaus party! From puppy birthdays to dog-friendly gatherings, we set the stage for an unforgettable celebration - with your furry guests as the stars.',
    features: [
      { label: 'Birthday packages',    detail: 'Decorations, cake & more' },
      { label: 'Private event booking', detail: 'Reserve the space for your group' },
      { label: 'Pet-friendly catering', detail: 'Treats for your four-legged guests' },
      { label: 'Photo opportunities',  detail: 'Themed setups available' },
    ],
    pricing: '<div class="svc-price-row"><span class="svc-price-label">Birthday packages</span><a class="svc-price-val svc-contact-link" href="#footer-section">Contact branch</a></div><div class="svc-price-row"><span class="svc-price-label">Private events</span><a class="svc-price-val svc-contact-link" href="#footer-section">Contact branch</a></div>',
  },
  {
    tag: 'Shop', name: 'Store', imgKey: 'store',
    desc: 'Stock up on everything your pet needs — and a few things they simply deserve. Our in-store shop carries a curated selection of treats, grooming products, accessories, toys, and more from trusted pet brands.',
    features: [
      { label: 'Treats & food',        detail: 'Wholesome snacks and meal options' },
      { label: 'Grooming products',    detail: 'Shampoos, conditioners & care essentials' },
      { label: 'Toys & accessories',   detail: 'For dogs who like to look good and play hard' },
      { label: 'Available in-store',   detail: 'Visit us at any Barkhaus branch' },
    ],
    pricing: '',
  },
  {
    tag: 'Cafe', name: 'Cafe', imgKey: 'cafe',
    desc: 'Enjoy a cup of coffee while your furry best friend hangs out beside you. Our Barkhaus Cafe serves specialty coffee, refreshers, and dog-safe puppuccinos.',
    features: [
      { label: 'Specialty coffee & drinks', detail: 'Crafted in-house' },
      { label: 'Puppuccinos available',     detail: 'A treat for your pup too' },
      { label: 'Pet-friendly seating',      detail: 'Bring your fur baby along' },
      { label: 'Eastwood only',             detail: 'Available at our Eastwood branch' },
    ],
    pricing: '<div class="svc-price-row"><span class="svc-price-label">Cafe Menu</span><a class="svc-price-val svc-contact-link" href="#" onclick="lbOpen([\'https://dxttnbtfhpanyiyduevn.supabase.co/storage/v1/object/public/site-images/cafe-menu.png\'],0);return false;">View Menu</a></div>',
  },
];


/* ── SERVICE CAROUSEL ────────────────────────────────────── */

var svcCarIdx = 0, svcCarImages = [];
var currentSvc = 0, svcCarousels = {};
var _svcImgSets = {};

function buildSvcCarousel(images, svcName) {
  var carousel = document.getElementById('svc-carousel');
  var track    = document.getElementById('svc-carousel-track');
  var dots     = document.getElementById('svc-carousel-dots');
  if (!carousel || !track || !dots) return;
  if (!images || !images.length) { carousel.style.display = 'none'; return; }
  svcCarImages = images; svcCarIdx = 0;
  carousel.setAttribute('data-count', images.length);
  track.innerHTML = images.map(function(src) {
    return '<div class="svc-carousel-slide"><img src="' + src + '" alt="' + (svcName || 'Barkhaus') + ' – pet care service at Barkhaus Pet Services Philippines"></div>';
  }).join('');
  dots.innerHTML = images.map(function(_, i) {
    return '<div class="svc-carousel-dot' + (i === 0 ? ' active' : '') + '" onclick="svcCarouselGo(' + i + ')"></div>';
  }).join('');
  track.style.transform = 'translateX(0)';
  carousel.style.display = 'block';
}

function svcCarouselGo(idx) {
  var track = document.getElementById('svc-carousel-track');
  var dots  = document.getElementById('svc-carousel-dots');
  if (!track) return;
  svcCarIdx = (idx + svcCarImages.length) % svcCarImages.length;
  track.style.transform = 'translateX(-' + (svcCarIdx * 100) + '%)';
  if (dots) dots.querySelectorAll('.svc-carousel-dot').forEach(function(d, i) { d.classList.toggle('active', i === svcCarIdx); });
}

function svcCarouselNav(dir) { svcCarouselGo(svcCarIdx + dir); }

function openSvcModal(idx) {
  var s = services[idx];
  document.getElementById('svc-modal-tag').textContent  = s.tag;
  document.getElementById('svc-modal-name').textContent = s.name;
  document.getElementById('svc-modal-desc').textContent = s.desc;
  document.getElementById('svc-modal-features').innerHTML = s.features.map(function(f) {
    return '<div class="svc-modal-feature"><div class="svc-modal-feature-dot"></div><div class="svc-modal-feature-text"><strong>' + f.label + '</strong>' + (f.detail ? ' - ' + f.detail : '') + '</div></div>';
  }).join('');
  var imgs = [];
  if (typeof BARKHAUS_IMAGES !== 'undefined' && BARKHAUS_IMAGES.services && s.imgKey) {
    var src = BARKHAUS_IMAGES.services[s.imgKey];
    imgs = Array.isArray(src) ? src : (src ? [src] : []);
  }
  /* Prefer Storage images if already loaded */
  if (_svcImgSets['svc' + idx] && _svcImgSets['svc' + idx].length) imgs = _svcImgSets['svc' + idx];
  buildSvcCarousel(imgs, s.name);
  document.getElementById('svc-modal-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSvcModal() {
  document.getElementById('svc-modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
function closeSvcModalOnOverlay(e) {
  if (e.target === document.getElementById('svc-modal-overlay')) closeSvcModal();
}

function buildSvcThumbnailsHtml(imgs, slideIdx, svcName) {
  if (!imgs || !imgs.length) return '';
  var key = 'svc' + slideIdx;
  _svcImgSets[key] = imgs;
  var MAX = 9;
  var visible = imgs.length > MAX ? imgs.slice(0, MAX) : imgs;
  var extra   = imgs.length > MAX ? imgs.length - MAX : 0;
  var items = visible.map(function(src, i) {
    var isMore = extra > 0 && i === visible.length - 1;
    return '<div class="svc-thumb' + (isMore ? ' svc-thumb-more' : '') + '" onclick="lbOpenSet(\'' + key + '\',' + i + ')">' +
      '<img src="' + src + '" alt="' + (svcName || 'Barkhaus') + ' – pet care service at Barkhaus Pet Services Philippines" loading="lazy">' +
      (isMore ? '<div class="svc-thumb-more-label">+' + extra + '</div>' : '') +
      '</div>';
  }).join('');
  return '<div class="svc-thumbs" data-count="' + visible.length + '">' + items + '</div>';
}

function svcImgNav(slideIdx, dir) {
  var state = svcCarousels[slideIdx]; if (!state) return;
  svcImgGo(slideIdx, (state.idx + dir + state.imgs.length) % state.imgs.length);
}

function svcImgGo(slideIdx, idx) {
  var state = svcCarousels[slideIdx]; if (!state) return;
  state.idx = idx;
  var track = document.getElementById('svc-track-' + slideIdx);
  if (track) track.style.transform = 'translateX(-' + (idx * 100) + '%)';
  var car = document.getElementById('svc-car-' + slideIdx);
  if (car) car.querySelectorAll('.svc-img-dot').forEach(function(d, i) { d.classList.toggle('active', i === idx); });
}

function initSvcSlides() {
  var wrap = document.getElementById('svcSlidesWrap');
  var nav  = document.getElementById('svcNav');
  if (!wrap || !nav) return;

  wrap.innerHTML = services.map(function(s, i) {
    var imgs = [];
    if (typeof BARKHAUS_IMAGES !== 'undefined' && BARKHAUS_IMAGES.services && s.imgKey) {
      var src = BARKHAUS_IMAGES.services[s.imgKey];
      imgs = Array.isArray(src) ? src : (src ? [src] : []);
    }
    if (imgs.length === 1) imgs = [imgs[0], imgs[0], imgs[0]];
    svcCarousels[i] = { idx: 0, imgs: imgs };

    var carouselHtml  = buildSvcThumbnailsHtml(imgs, i, s.name);
    var featureHtml   = s.features.map(function(f) {
      return '<div class="svc-slide-feature"><div class="svc-slide-feature-dot"></div>' +
        '<div class="svc-slide-feature-text"><strong>' + f.label + '</strong>' +
        (f.detail ? ' — ' + f.detail : '') + '</div></div>';
    }).join('');
    var pricingHtml   = s.pricing ? '<p class="svc-pricing-label">Rates</p><div class="svc-price-rows">' + s.pricing + '</div>' : '';
    var textContent   =
      '<p class="svc-slide-eyebrow">' + s.tag + '</p>' +
      '<h3 class="svc-slide-name">' + s.name + '</h3>' +
      '<p class="svc-slide-desc">' + s.desc + '</p>' +
      (featureHtml ? '<div class="svc-slide-features">' + featureHtml + '</div>' : '') +
      pricingHtml;
    var inner = carouselHtml
      ? '<div class="svc-img-col">' + carouselHtml + '</div><div class="svc-text-col">' + textContent + '</div>'
      : '<div class="svc-text-col">' + textContent + '</div>';

    return '<div class="svc-slide' + (i === 0 ? ' active' : '') + '" id="svc-slide-' + i + '">' + inner + '</div>';
  }).join('');

  nav.innerHTML = services.map(function(s, i) {
    return '<div class="svc-nav-item' + (i === 0 ? ' active' : '') + '" onclick="switchSvc(' + i + ')">' +
      '<span class="svc-nav-label">' + s.name + '</span>' +
      '<div class="svc-nav-bar"></div></div>';
  }).join('');
}

function switchSvc(idx) {
  var nav = document.querySelector('.svc-nav');
  if (nav) { nav.classList.remove('nav-expanded'); nav.removeAttribute('data-expanding'); }
  if (idx === currentSvc) return;
  var slides   = document.querySelectorAll('.svc-slide');
  var navItems = document.querySelectorAll('.svc-nav-item');
  if (slides[currentSvc])   slides[currentSvc].classList.remove('active');
  if (navItems[currentSvc]) navItems[currentSvc].classList.remove('active');
  currentSvc = idx;
  if (slides[currentSvc])   slides[currentSvc].classList.add('active');
  if (navItems[currentSvc]) navItems[currentSvc].classList.add('active');
}


/* ── LIGHTBOX ────────────────────────────────────────────── */

var lbImgs = [], lbIdx = 0;

function lbOpenSet(key, idx) { lbOpen(_svcImgSets[key] || [], idx); }

function lbOpen(imgs, idx) {
  lbImgs = imgs; lbIdx = idx; lbShow();
  document.getElementById('lb-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', lbKeyDown);
}

function lbShow() {
  var img  = document.getElementById('lb-img');
  var dots = document.getElementById('lb-dots');
  if (img) img.src = lbImgs[lbIdx];
  if (dots) dots.innerHTML = lbImgs.map(function(_, i) {
    return '<div class="lb-dot' + (i === lbIdx ? ' active' : '') + '" onclick="lbGo(' + i + ')"></div>';
  }).join('');
  var p = document.querySelector('.lb-prev'), n = document.querySelector('.lb-next');
  if (p) p.style.display = lbImgs.length > 1 ? 'flex' : 'none';
  if (n) n.style.display = lbImgs.length > 1 ? 'flex' : 'none';
}

function lbNav(dir) { lbIdx = (lbIdx + dir + lbImgs.length) % lbImgs.length; lbShow(); }
function lbGo(idx)  { lbIdx = idx; lbShow(); }

function lbClose() {
  document.getElementById('lb-overlay').classList.remove('open');
  document.body.style.overflow = '';
  document.removeEventListener('keydown', lbKeyDown);
}

function lbOverlayClick(e) { if (e.target === document.getElementById('lb-overlay')) lbClose(); }
function lbKeyDown(e) {
  if (e.key === 'ArrowLeft') lbNav(-1);
  else if (e.key === 'ArrowRight') lbNav(1);
  else if (e.key === 'Escape') lbClose();
}


/* ── PRICE INFO POPOVER ──────────────────────────────────── */

var PRICE_INFO = {
  bath_dry:  { title: 'Bath and Dry',    text: 'Bath, Blow Dry and Brush Out.' },
  basic:     { title: 'Basic Groom',     text: 'Shampoo, Blow Dry, Brush Out, Teeth Brushing, Sanitary Clean, Paw Pad Trim, Nail Trim and Filing, Ear Cleaning, Anal Gland Expression.' },
  premium:   { title: 'Premium Groom',   text: 'Customized Haircut, Face Trim, Shampoo, Blow Dry, Brush Out, Teeth Brushing, Sanitary Clean, Paw Pad Trim, Nail Trim and Filing, Ear Cleaning, Anal Gland Expression.' },
  face_trim: { title: 'Face Trim',       text: 'Styling and trimming of the fur around the snout, eyes, ears, and chin for a neat, polished finish. Priced by pet size.' },
  addons:    { title: 'Add-on Services', text: 'Individual services available à la carte: Nail Trim and Filing, Ear Cleaning, Teeth Brushing, Sanitary Clean, Anti-tick and Flea Bath, Whitening Bath, Paw Pads Trim, Anal Gland Expression, Deshedding, Dematting, Premium Shampoo.' },
};

function showPriceInfo(e, key) {
  e.stopPropagation();
  var info = PRICE_INFO[key]; if (!info) return;
  document.getElementById('priceInfoTitle').textContent = info.title;
  document.getElementById('priceInfoText').textContent  = info.text;
  document.getElementById('priceInfoOverlay').classList.add('visible');
  document.getElementById('priceInfoPopover').classList.add('visible');
}
function hidePriceInfo() {
  document.getElementById('priceInfoOverlay').classList.remove('visible');
  document.getElementById('priceInfoPopover').classList.remove('visible');
}


/* ── MODALS + MISC UI ────────────────────────────────────── */

function showComingSoon() {
  var el = document.getElementById('comingSoonOverlay');
  if (el) el.style.display = 'flex';
}
function hideComingSoon() {
  var el = document.getElementById('comingSoonOverlay');
  if (el) el.style.display = 'none';
}

function blogNav(dir) {
  var track = document.getElementById('blogTrack'); if (!track) return;
  var card  = track.querySelector('.blog-card');
  track.scrollBy({ left: dir * (card ? card.offsetWidth + 16 : 320), behavior: 'smooth' });
}

function homeFaqToggle(idx) {
  var item = document.getElementById('hfti' + idx); if (!item) return;
  var isOpen = item.classList.contains('open');
  document.querySelectorAll('#faq-fold .faq-item').forEach(function(el) { el.classList.remove('open'); });
  if (!isOpen) item.classList.add('open');
}


/* ── PAWS ANIMATION ──────────────────────────────────────── */

(function() {
  var canvas = document.getElementById('paws-bg');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  function resize() { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; }
  resize();
  new ResizeObserver(resize).observe(canvas);

  function drawPaw(x, y, size, alpha, travelAngle, isLeft) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(travelAngle - Math.PI / 2);
    if (isLeft) ctx.scale(-1, 1);
    ctx.fillStyle = '#4D96B9';
    ctx.beginPath(); ctx.ellipse(-size*0.18, size*0.05, size*0.22, size*0.28, -0.25, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse( size*0.18, size*0.05, size*0.22, size*0.28,  0.25, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-size*0.38, size*0.05); ctx.lineTo(size*0.38, size*0.05); ctx.lineTo(0, size*0.48); ctx.closePath(); ctx.fill();
    [[-size*0.36,-size*0.32,size*0.13,size*0.17,0.4],[-size*0.13,-size*0.48,size*0.13,size*0.17,0.1],[size*0.13,-size*0.48,size*0.13,size*0.17,-0.1],[size*0.36,-size*0.32,size*0.13,size*0.17,-0.4]].forEach(function(t) {
      ctx.beginPath(); ctx.ellipse(t[0], t[1], t[2], t[3], t[4], 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }

  var TRAIL_COUNT = 4, trails = [];

  function createTrail() {
    var goRight  = Math.random() > 0.5;
    var startX   = goRight ? -8 : 108;
    var startY   = 10 + Math.random() * 80;
    var angle    = goRight ? (Math.random()-0.5)*0.5 : Math.PI+(Math.random()-0.5)*0.5;
    var stepFwd  = 7 + Math.random() * 4;
    var stepSide = 2.5 + Math.random() * 1.5;
    var size     = 7 + Math.random() * 7;
    var numPairs = 5 + Math.floor(Math.random() * 5);
    var maxA     = 0.12 + Math.random() * 0.13;
    var steps = [], cx = startX, cy = startY;
    var perpAngle = angle + Math.PI / 2;
    for (var p = 0; p < numPairs; p++) {
      for (var foot = 0; foot < 2; foot++) {
        var side = (foot === 0 ? 1 : -1) * stepSide;
        steps.push({ x: cx + Math.cos(perpAngle)*side + Math.cos(angle)*stepFwd*0.5, y: cy + Math.sin(perpAngle)*side + Math.sin(angle)*stepFwd*0.5, isLeft: foot===0, alpha:0, maxAlpha:maxA, born:0 });
      }
      cx += Math.cos(angle) * stepFwd;
      cy += Math.sin(angle) * stepFwd;
    }
    return { steps: steps, size: size, angle: angle, currentStep: 0, stepDelay: 0, done: false };
  }

  for (var i = 0; i < TRAIL_COUNT; i++) {
    var t = createTrail(); t.stepDelay = -Math.floor(Math.random()*160); trails.push(t);
  }

  var frame = 0, STEP_INTERVAL = 22;

  function loop() {
    frame++;
    var w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#0F1C26'; ctx.fillRect(0, 0, w, h);
    trails.forEach(function(trail, ti) {
      trail.stepDelay++;
      if (trail.stepDelay > 0 && trail.stepDelay % STEP_INTERVAL === 0 && trail.currentStep < trail.steps.length) {
        trail.steps[trail.currentStep].born = frame; trail.currentStep++;
      }
      trail.steps.forEach(function(step) {
        if (step.born === 0) return;
        var age = frame - step.born;
        if      (age < 6)  step.alpha = (age/6) * step.maxAlpha;
        else if (age < 90) step.alpha = step.maxAlpha;
        else               step.alpha = Math.max(0, step.maxAlpha*(1-(age-90)/70));
        drawPaw((step.x/100)*w, (step.y/100)*h, trail.size, step.alpha, trail.angle, step.isLeft);
      });
      var last = trail.steps[trail.steps.length-1];
      if (trail.currentStep >= trail.steps.length && last.alpha <= 0.001) trails[ti] = createTrail();
    });
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();


/* ── IMAGE INIT (BARKHAUS_IMAGES fallback) ───────────────── */

function initImages() {
  if (typeof BARKHAUS_IMAGES === 'undefined') return;
  var heroEl = document.getElementById('img-hero');
  if (heroEl && BARKHAUS_IMAGES.hero) heroEl.src = BARKHAUS_IMAGES.hero;
  ['b1', 'b2'].forEach(function(key) {
    var imgs = BARKHAUS_IMAGES[key] || [];
    if (!imgs.length) return;
    var branchName = key === 'b1' ? 'Barkhaus Estancia, Capitol Commons Pasig' : 'Barkhaus Eastwood, Quezon City';
    var mainCont   = document.getElementById(key + '-main');
    if (mainCont) {
      var mainImg = mainCont.querySelector('img');
      if (mainImg && imgs[0]) { mainImg.src = imgs[0]; if (!mainImg.alt) mainImg.alt = branchName + ' – Pet Services, Grooming and Daycare'; }
    }
    imgs.forEach(function(src, i) {
      var el = document.querySelector('[data-img="' + key + '-' + i + '"]');
      if (el) { el.src = src; if (!el.alt) el.alt = branchName + ' – branch photo ' + (i + 1); }
    });
  });
}


/* ── FLOAT NAV ───────────────────────────────────────────── */

new IntersectionObserver(function(entries) {
  document.getElementById('floatNav').classList.toggle('visible', !entries[0].isIntersecting);
}, { threshold: 0.1 }).observe(document.getElementById('hero'));


/* ── SWIPE + TOUCH HANDLERS ──────────────────────────────── */

/* Location section swipe */
(function() {
  var swipeStart = 0;
  var el = document.getElementById('locations');
  if (!el) return;
  el.addEventListener('touchstart', function(e) { swipeStart = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', function(e) {
    var d = swipeStart - e.changedTouches[0].clientX;
    if (Math.abs(d) > 40) switchLoc(Math.max(0, Math.min(2, currentLoc + (d > 0 ? 1 : -1))), true);
  }, { passive: true });
})();

/* Service slides swipe */
(function() {
  var startX = 0;
  var el = document.getElementById('services'); if (!el) return;
  el.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', function(e) {
    var target = e.target;
    if (target.closest && target.closest('.svc-img-carousel')) {
      var car = target.closest('.svc-img-carousel');
      var slideIdx = parseInt(car.id.replace('svc-car-', ''));
      var d = startX - e.changedTouches[0].clientX;
      if (Math.abs(d) > 30) svcImgNav(slideIdx, d > 0 ? 1 : -1);
      return;
    }
    var d = startX - e.changedTouches[0].clientX;
    if (Math.abs(d) > 50) { var next = currentSvc + (d > 0 ? 1 : -1); if (next >= 0 && next < services.length) switchSvc(next); }
  }, { passive: true });
})();

/* Service modal carousel swipe */
(function() {
  var startX = 0;
  var el = document.getElementById('svc-carousel'); if (!el) return;
  el.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', function(e) {
    var d = startX - e.changedTouches[0].clientX;
    if (Math.abs(d) > 35) svcCarouselNav(d > 0 ? 1 : -1);
  }, { passive: true });
})();

/* Lightbox touch swipe */
(function() {
  var el = document.getElementById('lb-overlay'); if (!el) return;
  var sx = 0;
  el.addEventListener('touchstart', function(e) { sx = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', function(e) {
    var d = sx - e.changedTouches[0].clientX;
    if (Math.abs(d) > 40) lbNav(d > 0 ? 1 : -1);
  }, { passive: true });
})();

/* Blog track swipe */
(function() {
  var track = document.getElementById('blogTrack'); if (!track) return;
  var startX = 0, startY = 0, startScroll = 0, swiping = false;
  track.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; startScroll = track.scrollLeft; swiping = false; }, { passive: true });
  track.addEventListener('touchmove', function(e) {
    var dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
    if (!swiping && Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) swiping = true;
    if (swiping) { e.preventDefault(); e.stopPropagation(); track.scrollLeft = startScroll - dx; }
  }, { passive: false });
  track.addEventListener('touchend', function() { swiping = false; }, { passive: true });
})();

/* Global touch blocking (prevents vertical snap-scroll during horizontal swipes) */
(function() {
  var startX, startY, blocking;
  document.addEventListener('touchstart', function(e) { startX = e.touches[0].clientX; startY = e.touches[0].clientY; blocking = null; }, { passive: true });
  document.addEventListener('touchmove', function(e) {
    if (blocking === null) {
      var dx = Math.abs(e.touches[0].clientX - startX), dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 5 || dy > 5) blocking = dx > dy;
    }
    if (blocking && !e.target.closest('.loc-thumbs')) e.preventDefault();
  }, { passive: false });
})();


/* ── SERVICE NAV COLLAPSE + AUTO-HIDE ────────────────────── */

(function() {
  var nav = document.querySelector('.svc-nav'); if (!nav) return;
  var hideTimer = null, shownForCurrentVisit = false, MOBILE_BP = 640;
  function isMobile() { return window.innerWidth < MOBILE_BP; }
  function hideLabels() { clearTimeout(hideTimer); nav.classList.add('labels-hidden'); nav.classList.remove('nav-expanded'); }
  function showLabelsThen(ms) { clearTimeout(hideTimer); nav.classList.remove('labels-hidden'); hideTimer = setTimeout(hideLabels, ms || 3000); }
  if (isMobile()) nav.classList.add('labels-hidden');
  nav.addEventListener('click', function(e) {
    if (!isMobile()) return;
    if (e.target.closest('.svc-nav-item')) return;
    nav.classList.toggle('nav-expanded'); showLabelsThen(3000);
  });
  var svcSection = document.getElementById('services');
  if (svcSection) {
    new IntersectionObserver(function(entries) {
      if (!isMobile()) return;
      if (entries[0].isIntersecting) { if (!shownForCurrentVisit) { shownForCurrentVisit = true; showLabelsThen(3000); } }
      else { shownForCurrentVisit = false; hideLabels(); }
    }, { threshold: 0.5 }).observe(svcSection);
  }
  window.addEventListener('resize', function() {
    if (!isMobile()) { clearTimeout(hideTimer); nav.classList.remove('labels-hidden'); }
    else if (!shownForCurrentVisit) { hideLabels(); }
  });
})();

/* IntersectionObserver for service card section (kept for future use) */
var _cardObs = new IntersectionObserver(function() {}, { threshold: 0.1 });
var _svcSection = document.getElementById('services');
if (_svcSection) _cardObs.observe(_svcSection);


/* ── HASH ROUTING (deep-link to service tab) ─────────────── */

(function() {
  var map = {};
  services.forEach(function(s, i) { if (s) map['svc-' + s.imgKey] = i; });
  function applyHash() {
    var hash = window.location.hash.replace('#', '');
    if (map[hash] !== undefined) {
      var s = document.getElementById('services');
      if (s) s.scrollIntoView({ behavior: 'smooth' });
      setTimeout(function() { switchSvc(map[hash]); }, 350);
    }
  }
  window.addEventListener('hashchange', applyHash);
  document.addEventListener('DOMContentLoaded', applyHash);
})();

/* Escape key closes modals */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') hideComingSoon();
});


/* ── MAIN INIT ───────────────────────────────────────────── */

/* 1. Render immediately with local images.js data */
initImages();
initSvcSlides();
restartAuto();

/* 2. Async: upgrade images from Storage + render blog posts */
(async function() {
  var results     = await Promise.all([loadStorageImages(), loadBlogPosts()]);
  var storageImgs = results[0];
  var blogPosts   = results[1];

  /* Upgrade gallery images if Storage has content */
  if (Object.keys(storageImgs).length) upgradeImagesFromStorage(storageImgs);

  /* Render blog cards from DB */
  renderBlogCards(blogPosts);
})();
