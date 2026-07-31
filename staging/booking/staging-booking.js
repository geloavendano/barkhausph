(function () {
  'use strict';

  // This staging client is intentionally read-only. Its only network requests are
  // public REST reads and privacy-safe RPCs that already power booking.html.
  var SUPABASE_URL = 'https://dxttnbtfhpanyiyduevn.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s';
  var app = document.getElementById('bookingApp');
  var toast = document.getElementById('toast');
  var mode = sessionStorage.getItem('barkhaus_staging_mode') || 'guest';
  var savedPets = [
    { id:'demo-mochi', name:'Mochi', animal:'dog', size:'medium_dog', gender:'male', breed:'Shiba Inu', age:'3', ageUnit:'years', temperament:'friendly_shy', medical:'Sensitive to loud dryers.', vaccines:['anti_rabies','combo','bordetella','tick_flea'] },
    { id:'demo-luna', name:'Luna', animal:'cat', size:'cat', gender:'female', breed:'Domestic Shorthair', age:'2', ageUnit:'years', temperament:'friendly_all', medical:'', vaccines:['anti_rabies','all_in_one','anti_parasitic'] }
  ];
  var state = {
    step:'branch', branch:null, branchId:null, service:null, cart:[], draft:{},
    owner: mode === 'account' ? { first:'Gelo', last:'Endicio', email:'gelo@example.com', phone:'+63 917 123 4567', source:'Website' } : {},
    rooms:[], groomers:[], pricingReady:false, availabilityBusy:false, slots:[],
    member:null, memberStatus:'', files:{ vaccines:[], pegs:[] }
  };
  var stepOrder = ['branch','service','availability','details','health','owner','waiver','review'];
  var stepNames = {branch:'Branch',service:'Service',availability:'Availability',details:'Pet details',health:'Health & records',owner:'Owner',waiver:'Waivers',review:'Review',checkout:'Checkout preview'};

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>'"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]; }); }
  function peso(value) { return '₱' + Math.round(Number(value)||0).toLocaleString('en-PH'); }
  function dateToday() { var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function alpha(index) { var n=index+1,s=''; while(n>0){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);} return s; }
  function labelSize(key) { return {small_dog:'Small Dog',medium_dog:'Medium Dog',large_dog:'Large Dog',giant_dog:'Giant Dog',cat:'Cat'}[key]||key||''; }
  function serviceLabel(key) { return key==='hotel'?'Pet Hotel':'Grooming'; }
  function showToast(message) { toast.textContent=message; toast.hidden=false; clearTimeout(showToast.timer); showToast.timer=setTimeout(function(){toast.hidden=true;},4500); }

  async function apiFetch(table, query) {
    var response = await fetch(SUPABASE_URL + '/rest/v1/' + table + (query ? '?' + query : ''), { headers:{ apikey:SUPABASE_ANON_KEY, Authorization:'Bearer '+SUPABASE_ANON_KEY, 'Content-Type':'application/json' } });
    if (!response.ok) throw new Error('Read failed ('+response.status+')');
    return response.json();
  }
  async function rpc(name, params) {
    var response = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, { method:'POST', headers:{ apikey:SUPABASE_ANON_KEY, Authorization:'Bearer '+SUPABASE_ANON_KEY, 'Content-Type':'application/json' }, body:JSON.stringify(params||{}) });
    if (!response.ok) throw new Error('Availability read failed ('+response.status+')');
    return response.json();
  }

  function setStep(step) { state.step=step; window.scrollTo(0,0); render(); }
  function backButton(target) { return '<button class="back-btn" data-back="'+target+'">← Back</button>'; }
  function heading(title, subtitle) { return '<p class="eyebrow">Barkhaus booking · read-only</p><h1>'+title+'</h1><p class="step-subtitle">'+subtitle+'</p>'; }
  function updateProgress() {
    var index = state.step === 'checkout' ? 8 : stepOrder.indexOf(state.step)+1;
    index=Math.max(1,index);
    document.getElementById('progressName').textContent=stepNames[state.step]||'Booking';
    document.getElementById('progressCount').textContent=index+' of 8';
    document.getElementById('progressFill').style.width=(index/8*100)+'%';
  }
  function bindCommon() {
    app.querySelectorAll('[data-back]').forEach(function(button){button.onclick=function(){setStep(button.getAttribute('data-back'));};});
  }
  function field(label,id,value,type,placeholder,extra) { return '<label><span class="field-label">'+label+'</span><input class="form-control" id="'+id+'" type="'+(type||'text')+'" value="'+esc(value||'')+'" placeholder="'+esc(placeholder||'')+'" '+(extra||'')+'></label>'; }

  async function initReads() {
    try {
      var values = await Promise.all([
        apiFetch('pricing','select=category,service_key,size_key,day_type,membership_type,price'),
        apiFetch('rate_calendar','select=rate_date,label,holiday_type,rate_day_type,active&active=eq.true'),
        apiFetch('branches','select=id,name&order=created_at')
      ]);
      loadPricingData(values[0]); loadRateCalendarData(values[1]); state.pricingReady=true; state.branches=values[2];
    } catch (error) { state.readError='Live production data could not be loaded. Refresh to retry.'; }
    render();
  }
  async function loadResources() {
    if (!state.branchId) return;
    try {
      var values=await Promise.all([
        apiFetch('rooms','select=id,name,color,room_type,pet_type,allowed_sizes,is_locked&branch_id=eq.'+state.branchId+'&active=eq.true&order=sort_order.asc.nullslast,name.asc'),
        apiFetch('groomers','select=id,name,color,is_unavailable&branch_id=eq.'+state.branchId+'&active=eq.true&is_unavailable=eq.false&order=sort_order.asc.nullslast,name.asc')
      ]);
      state.rooms=values[0]||[]; state.groomers=values[1]||[];
    } catch(error) { showToast('Could not load branch resources. Please retry.'); }
  }

  function render() {
    updateProgress();
    if (state.step==='branch') renderBranch();
    else if (state.step==='service') renderService();
    else if (state.step==='availability') renderAvailability();
    else if (state.step==='details') renderDetails();
    else if (state.step==='health') renderHealth();
    else if (state.step==='owner') renderOwner();
    else if (state.step==='waiver') renderWaiver();
    else if (state.step==='review') renderReview();
    else renderCheckout();
    bindCommon();
  }

  function renderBranch() {
    var cards=(state.branches||[]).map(function(branch){
      var key=branch.name.toLowerCase().includes('estancia')?'estancia':branch.name.toLowerCase().includes('eastwood')?'eastwood':'';
      if(!key)return '';
      var detail=key==='estancia'?'Capitol Commons, Pasig · Mon–Thu 11AM–9PM':'Eastwood Mall, Quezon City · Open daily 10AM–10PM';
      return '<button class="choice-card" data-branch="'+key+'" data-id="'+branch.id+'"><span class="radio"></span><span><strong>'+esc(branch.name)+'</strong><small>'+detail+'</small></span><b>→</b></button>';
    }).join('');
    app.innerHTML=heading('Choose a branch','Every service in this combined checkout will use the same Barkhaus location.')+(state.readError?'<div class="warn-note">'+state.readError+'</div>':'')+'<div class="card-stack">'+(cards||'<div class="info-note">Loading live branches…</div>')+'</div>';
    app.querySelectorAll('[data-branch]').forEach(function(button){button.onclick=async function(){state.branch=button.dataset.branch;state.branchId=button.dataset.id;await loadResources();setStep('service');};});
  }

  function renderService() {
    var branchName=state.branch==='estancia'?'Estancia':'Eastwood';
    app.innerHTML=backButton(state.cart.length?'review':'branch')+heading(state.cart.length?'Add another service':'What would you like to book?',branchName+' · Availability is shown before owner, health, document and waiver fields.')+
      (state.cart.length?'<div class="success-note"><strong>Same order</strong><span>'+state.cart.length+' service'+(state.cart.length>1?'s':'')+' already added. Branch and owner details will be reused.</span></div>':'')+
      '<div class="service-stack"><button class="service-card" data-service="grooming"><span>✂️</span><span><strong>Grooming</strong><small>Package, add-ons, groomer preference and live time slots</small></span><b>Choose</b></button><button class="service-card" data-service="hotel"><span>🏠</span><span><strong>Pet Hotel</strong><small>Dates, compatible rooms and live occupancy</small></span><b>Choose</b></button><button class="service-card disabled" disabled><span>☀️</span><span><strong>Daycare</strong><small>Walk-in at the selected branch</small></span><b>Walk-in</b></button></div>';
    app.querySelectorAll('[data-service]').forEach(function(button){button.onclick=function(){state.service=button.dataset.service;state.draft={service:state.service,addons:{},vaccines:{}};state.slots=[];state.member=null;state.memberStatus='';state.files={vaccines:[],pegs:[]};setStep('availability');};});
  }

  function petChooserHtml() {
    var saved=mode==='account'?'<p class="section-label">Saved pets</p><div class="card-stack">'+savedPets.map(function(p){return '<button class="pet-card '+(state.draft.petId===p.id?'selected':'')+'" data-pet="'+p.id+'"><span>'+(p.animal==='cat'?'🐈':'🐕')+'</span><span><strong>'+p.name+'</strong><small>'+p.breed+' · '+labelSize(p.size)+'</small></span><b>Use</b></button>';}).join('')+'</div>':'';
    var sizes=['small_dog','medium_dog','large_dog','giant_dog','cat'];
    return saved+'<p class="section-label">'+(mode==='account'?'Or choose another pet size':'Pet type and size')+'</p><div class="size-grid">'+sizes.map(function(key){return '<button class="size-btn '+(state.draft.petSize===key?'selected':'')+'" data-size="'+key+'"><span>'+(key==='cat'?'🐈':'🐕')+'</span>'+labelSize(key)+'</button>';}).join('')+'</div>';
  }
  function groomPrice() { return state.pricingReady && state.draft.groomPackage && state.draft.petSize ? Number((GROOM_PRICES[state.draft.groomPackage]||{})[state.draft.petSize]||0) : 0; }
  function selectedAddonTotal() { return Object.keys(state.draft.addons||{}).reduce(function(total,key){var addon=ADDONS.find(function(a){return a.key===key;}); return total+Number(addon&&!addon.assessment?state.draft.addons[key]||0:0);},0); }
  function groomDuration() { var base={bath_dry:45,basic:75,premium:120,ala_carte:60}[state.draft.groomPackage]||60; return base+((state.draft.addons||{}).demat|| (state.draft.addons||{}).deshed?30:0); }
  function parseSlot(slot){var m=String(slot).match(/(\d+):(\d+)\s*(AM|PM)/i);if(!m)return-1;var h=+m[1],min=+m[2],ap=m[3].toUpperCase();if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+min;}
  function formatSlot(mins){var h=Math.floor(mins/60),m=mins%60,ap=h>=12?'PM':'AM',display=h%12||12;return display+':'+String(m).padStart(2,'0')+' '+ap;}

  function renderAvailability() {
    var content=backButton('service')+heading(state.service==='hotel'?'Find an available room':'Find an available grooming slot','Only service and pet attributes needed for pricing and availability are asked here.');
    content+=petChooserHtml();
    if(state.draft.petSize){
      if(state.service==='grooming') content+=groomAvailabilityHtml(); else content+=hotelAvailabilityHtml();
    } else content+='<div class="info-note">Choose a saved pet or pet size to continue.</div>';
    app.innerHTML=content;
    bindPetChoices();
    if(state.service==='grooming') bindGroomAvailability(); else bindHotelAvailability();
  }
  function bindPetChoices(){
    app.querySelectorAll('[data-pet]').forEach(function(button){button.onclick=function(){var p=savedPets.find(function(x){return x.id===button.dataset.pet;});Object.assign(state.draft,{petId:p.id,petName:p.name,petAnimal:p.animal,petSize:p.size,petGender:p.gender,petBreed:p.breed,petAge:p.age,petAgeUnit:p.ageUnit,petTemperament:p.temperament,petMedical:p.medical,vaccines:Object.fromEntries(p.vaccines.map(function(v){return[v,true];}))});state.slots=[];render();};});
    app.querySelectorAll('[data-size]').forEach(function(button){button.onclick=function(){Object.assign(state.draft,{petId:null,petSize:button.dataset.size,petAnimal:button.dataset.size==='cat'?'cat':'dog'});state.slots=[];render();};});
  }
  function groomAvailabilityHtml(){
    var packages=[['bath_dry','Bath & Dry','30–45 min'],['basic','Basic Groom','60–75 min'],['premium','Premium Groom','90–120 min'],['ala_carte','Ala Carte','Choose individual services']];
    var html='<p class="section-label">Grooming package</p><div class="package-stack">'+packages.map(function(p){var price=state.pricingReady?Number((GROOM_PRICES[p[0]]||{})[state.draft.petSize]||0):0;return '<button class="package-card '+(state.draft.groomPackage===p[0]?'selected':'')+'" data-package="'+p[0]+'"><span><strong>'+p[1]+'</strong><small>'+p[2]+'</small></span><b>'+(price?peso(price):'Live price')+'</b></button>';}).join('')+'</div>';
    if(state.draft.groomPackage){
      html+='<p class="section-label">Add-ons <span style="color:var(--cream-m)">(optional)</span></p><div class="option-grid">'+ADDONS.map(function(a){var price=a.assessment?'Assessed':a.sizeDependent?Number(FACE_TRIM_PRICES[state.draft.petSize]||0):Number(a.price||0);var on=Object.prototype.hasOwnProperty.call(state.draft.addons||{},a.key);return '<button class="mini-btn '+(on?'selected':'')+'" data-addon="'+a.key+'" data-price="'+(typeof price==='number'?price:0)+'">'+esc(a.name)+'<small style="display:block">'+(typeof price==='number'?peso(price):price)+'</small></button>';}).join('')+'</div>'+
        '<div class="two-col"><label><span class="field-label">Preferred groomer</span><select class="form-control" id="groomerSelect"><option value="">Any available</option>'+state.groomers.map(function(g){return '<option value="'+g.id+'" '+(state.draft.groomerId===g.id?'selected':'')+'>'+esc(g.name)+'</option>';}).join('')+'</select></label><label><span class="field-label">Date</span><input class="form-control" id="groomDate" type="date" min="'+dateToday()+'" value="'+esc(state.draft.groomDate||'')+'"></label></div>';
    }
    if(state.availabilityBusy) html+='<div class="info-note">Checking production grooming availability…</div>';
    else if(state.draft.groomDate && state.slots.length) html+='<div class="live-note"><strong>Live availability</strong> · '+state.slots.length+' slots currently available</div><div class="slot-grid">'+state.slots.map(function(slot){return '<button class="slot-btn '+(state.draft.groomSlot===slot?'selected':'')+'" data-slot="'+slot+'">'+slot+'<small>Available</small></button>';}).join('')+'</div>';
    else if(state.draft.groomDate && state.slotsLoaded) html+='<div class="warn-note">No verified slots are available for this selection. Try another date, package, or groomer.</div>';
    if(state.draft.groomSlot) html+='<div class="price-panel" style="margin-top:16px"><div class="price-row"><span>Grooming package</span><b>'+peso(groomPrice())+'</b></div><div class="price-row"><span>Selected priced add-ons</span><b>'+peso(selectedAddonTotal())+'</b></div><div class="price-row total"><span>Estimated service total</span><b>'+peso(groomPrice()+selectedAddonTotal())+'</b></div></div><div class="sticky-action"><button class="pill-btn wide" id="availabilityContinue">Continue with this schedule</button><small>Live availability will be checked again before a future real checkout.</small></div>';
    return html;
  }
  function bindGroomAvailability(){
    app.querySelectorAll('[data-package]').forEach(function(button){button.onclick=function(){state.draft.groomPackage=button.dataset.package;state.draft.groomSlot=null;state.slots=[];state.draft.addons={};render();};});
    app.querySelectorAll('[data-addon]').forEach(function(button){button.onclick=function(){var key=button.dataset.addon;if(Object.prototype.hasOwnProperty.call(state.draft.addons,key))delete state.draft.addons[key];else state.draft.addons[key]=Number(button.dataset.price||0);state.draft.groomSlot=null;if(state.draft.groomDate)loadGroomSlots();else render();};});
    var groomer=document.getElementById('groomerSelect');if(groomer)groomer.onchange=function(){state.draft.groomerId=groomer.value||null;state.draft.groomSlot=null;if(state.draft.groomDate)loadGroomSlots();};
    var date=document.getElementById('groomDate');if(date)date.onchange=function(){state.draft.groomDate=date.value;state.draft.groomSlot=null;loadGroomSlots();};
    app.querySelectorAll('[data-slot]').forEach(function(button){button.onclick=function(){state.draft.groomSlot=button.dataset.slot;render();};});
    var next=document.getElementById('availabilityContinue');if(next)next.onclick=function(){setStep('details');};
  }
  async function loadGroomSlots(){
    if(!state.draft.groomDate||!state.draft.groomPackage||!state.branchId)return;
    state.availabilityBusy=true;state.slots=[];state.slotsLoaded=false;render();
    try{
      var values=await Promise.all([
        rpc('get_grooming_occupancy',{p_branch_id:state.branchId,p_service_date:state.draft.groomDate}),
        apiFetch('blocked_schedules','select=resource_id,start_time,end_time&resource_type=eq.groomer&active=eq.true&dates=cs.{'+state.draft.groomDate+'}')
      ]);
      var hours=[];
      try{hours=await apiFetch('resource_service_hours','select=resource_id,start_time,end_time,last_service_time,active&branch_id=eq.'+state.branchId+'&resource_type=eq.groomer&service_date=eq.'+state.draft.groomDate+'&active=eq.true');}catch(hoursError){hours=[];}
      var bookings=values[0]||[],blocks=values[1]||[],duration=groomDuration();
      var pool=state.draft.groomerId?state.groomers.filter(function(g){return g.id===state.draft.groomerId;}):state.groomers;
      var candidates=[];for(var min=9*60;min<=19*60;min+=30)candidates.push(formatSlot(min));
      function toMin(value){var p=String(value||'').split(':');return Number(p[0])*60+Number(p[1]||0);}
      function canServe(g,slot){var start=parseSlot(slot),end=start+duration,window=hours.find(function(h){return h.resource_id===g.id;});if(window){var open=toMin(window.start_time),close=toMin(window.end_time),last=toMin(window.last_service_time);if(start<open||start>last||end>close)return false;}var booked=bookings.filter(function(b){return b.groomer_id===g.id&&b.timeslot;}).some(function(b){var s=parseSlot(b.timeslot),d={bath_dry:45,basic:75,premium:120}[b.groom_service_key]||60;return start<s+d&&end>s;});if(booked)return false;return !blocks.filter(function(b){return b.resource_id===g.id;}).some(function(b){return start<toMin(b.end_time)&&end>toMin(b.start_time);});}
      state.slots=candidates.filter(function(slot){var start=parseSlot(slot);if(state.draft.groomDate===dateToday()&&start<=new Date().getHours()*60+new Date().getMinutes())return false;var free=pool.filter(function(g){return canServe(g,slot);}).length;var unassigned=bookings.filter(function(b){if(b.groomer_id||!b.timeslot)return false;var s=parseSlot(b.timeslot),d={bath_dry:45,basic:75,premium:120}[b.groom_service_key]||60;return start<s+d&&start+duration>s;}).length;return free>unassigned;});
    }catch(error){state.slots=[];showToast('Could not verify grooming availability. Try again.');}
    state.availabilityBusy=false;state.slotsLoaded=true;render();
  }

  function hotelRateKey(room){return {small_cage:'small_dog',medium_cage:'medium_dog',large_cage:'large_dog',single_cabin:'cat_single_cabin',villa:'cat_villa'}[room.room_type]||state.draft.petSize;}
  function hotelTotal(room){if(!room||!state.draft.hotelCheckin||!state.draft.hotelCheckout)return 0;var total=0,d=new Date(state.draft.hotelCheckin+'T12:00:00'),end=new Date(state.draft.hotelCheckout+'T12:00:00'),key=hotelRateKey(room);while(d<end){var type=hotelDayType(d);total+=Number((HOTEL_RATES[type]||{})[key]||0);d.setDate(d.getDate()+1);}return total;}
  function hotelAvailabilityHtml(){
    var html='<div class="two-col"><label><span class="field-label">Check-in</span><input class="form-control" id="hotelCheckin" type="date" min="'+dateToday()+'" value="'+esc(state.draft.hotelCheckin||'')+'"></label><label><span class="field-label">Check-out</span><input class="form-control" id="hotelCheckout" type="date" min="'+esc(state.draft.hotelCheckin||dateToday())+'" value="'+esc(state.draft.hotelCheckout||'')+'"></label></div>';
    if(state.availabilityBusy)html+='<div class="info-note">Checking production room occupancy…</div>';
    else if(state.draft.hotelCheckin&&state.draft.hotelCheckout&&state.roomsLoaded){
      var available=state.availableRooms||[];html+='<div class="live-note"><strong>Live availability</strong> · '+available.length+' compatible room'+(available.length===1?'':'s')+' currently available</div><div class="room-stack">'+available.map(function(room){return '<button class="room-card '+(state.draft.roomId===room.id?'selected':'')+'" data-room="'+room.id+'"><span>🛏️</span><span><strong>'+esc(room.name)+'</strong><small>'+esc(room.room_type.replace(/_/g,' '))+' · compatible with '+labelSize(state.draft.petSize)+'</small></span><b>'+peso(hotelTotal(room))+'</b></button>';}).join('')+'</div>'+(available.length?'':'<div class="warn-note">No verified compatible rooms are available for these dates.</div>');
    }
    if(state.draft.roomId){var selected=state.rooms.find(function(r){return r.id===state.draft.roomId;});html+='<div class="price-panel" style="margin-top:16px"><div class="price-row"><span>'+esc(selected.name)+'</span><b>'+peso(hotelTotal(selected))+'</b></div><div class="price-row total"><span>Estimated stay total</span><b>'+peso(hotelTotal(selected))+'</b></div></div><div class="sticky-action"><button class="pill-btn wide" id="availabilityContinue">Continue with this room</button><small>Occupancy will be checked again before a future real checkout.</small></div>';}
    return html;
  }
  function bindHotelAvailability(){
    var cin=document.getElementById('hotelCheckin'),cout=document.getElementById('hotelCheckout');
    if(cin)cin.onchange=function(){state.draft.hotelCheckin=cin.value;state.draft.hotelCheckout='';state.draft.roomId=null;render();};
    if(cout)cout.onchange=function(){state.draft.hotelCheckout=cout.value;state.draft.roomId=null;loadHotelRooms();};
    app.querySelectorAll('[data-room]').forEach(function(button){button.onclick=function(){state.draft.roomId=button.dataset.room;render();};});
    var next=document.getElementById('availabilityContinue');if(next)next.onclick=function(){setStep('details');};
  }
  async function loadHotelRooms(){
    if(!state.draft.hotelCheckin||!state.draft.hotelCheckout)return;
    if(state.draft.hotelCheckout<=state.draft.hotelCheckin){showToast('Checkout must be after check-in.');return;}
    state.availabilityBusy=true;state.roomsLoaded=false;render();
    try{var occupied=await rpc('get_hotel_occupancy',{p_branch_id:state.branchId,p_checkin:state.draft.hotelCheckin,p_checkout:state.draft.hotelCheckout});var ids=new Set((occupied||[]).map(function(r){return r.room_id;}).filter(Boolean)),types=new Set((occupied||[]).filter(function(r){return !r.room_id&&r.room_type;}).map(function(r){return r.room_type;}));state.availableRooms=state.rooms.filter(function(r){return !r.is_locked&&Array.isArray(r.allowed_sizes)&&r.allowed_sizes.includes(state.draft.petSize)&&!ids.has(r.id)&&!types.has(r.room_type);});}
    catch(error){state.availableRooms=[];showToast('Could not verify hotel occupancy. Try again.');}
    state.availabilityBusy=false;state.roomsLoaded=true;render();
  }

  function renderDetails(){
    var d=state.draft,profile=d.petId?'<div class="success-note"><strong>Filled from saved pet</strong><span>Confirm or update anything that changed for this visit.</span></div>':'';
    app.innerHTML=backButton('availability')+heading(d.petId?'Confirm '+esc(d.petName)+'’s details':'Tell us about your pet','The selected price and availability are already known. These fields support safe admission and care.')+profile+
      '<div class="two-col">'+field('Pet name','petName',d.petName,'text','e.g. Mochi')+field('Size used for availability','petSize',labelSize(d.petSize),'text','', 'readonly')+'</div><div class="two-col"><label><span class="field-label">Animal type</span><select class="form-control" id="petAnimal"><option value="dog" '+(d.petAnimal==='dog'?'selected':'')+'>Dog</option><option value="cat" '+(d.petAnimal==='cat'?'selected':'')+'>Cat</option></select></label><label><span class="field-label">Sex</span><select class="form-control" id="petGender"><option value="">Select</option><option value="male" '+(d.petGender==='male'?'selected':'')+'>Male</option><option value="female" '+(d.petGender==='female'?'selected':'')+'>Female</option></select></label></div>'+
      field('Breed','petBreed',d.petBreed,'text','e.g. Shiba Inu')+'<div class="two-col">'+field('Age','petAge',d.petAge,'number','2','min="0" max="30"')+'<label><span class="field-label">Age unit</span><select class="form-control" id="petAgeUnit"><option value="years" '+(d.petAgeUnit==='years'?'selected':'')+'>Years</option><option value="months" '+(d.petAgeUnit==='months'?'selected':'')+'>Months</option></select></label></div>'+
      '<label><span class="field-label">Known medical issues or allergies</span><textarea class="form-control" id="petMedical" placeholder="Leave blank if none">'+esc(d.petMedical||'')+'</textarea></label><label><span class="field-label">Temperament</span><select class="form-control" id="petTemperament"><option value="">Select temperament</option><option value="friendly_all" '+(d.petTemperament==='friendly_all'?'selected':'')+'>Friendly with all</option><option value="friendly_shy" '+(d.petTemperament==='friendly_shy'?'selected':'')+'>Friendly but shy</option><option value="selective">Selective</option><option value="reactive">Reactive</option><option value="first_time">First time</option></select></label>'+
      (state.service==='grooming'?'<label><span class="field-label">Grooming special requests</span><textarea class="form-control" id="serviceNotes" placeholder="Style, sensitivities, handling notes">'+esc(d.serviceNotes||'')+'</textarea></label>':'')+
      (state.service==='hotel'?'<label><span class="field-label">Feeding instructions</span><textarea class="form-control" id="hotelFeeding">'+esc(d.hotelFeeding||'')+'</textarea></label><label><span class="field-label">Medications / special care</span><textarea class="form-control" id="hotelMeds">'+esc(d.hotelMeds||'')+'</textarea></label><div class="two-col">'+field('Drop-off time','hotelDropoff',d.hotelDropoff,'time','')+field('Pickup time','hotelPickup',d.hotelPickup,'time','')+'</div><label><span class="field-label">Play park consent</span><select class="form-control" id="playparkConsent"><option value="">Select</option><option value="yes">Yes, please</option><option value="no">No thanks</option></select></label>':'')+
      '<button class="pill-btn wide" id="detailsContinue">Continue to health & records</button>';
    document.getElementById('detailsContinue').onclick=function(){
      var required=['petName','petGender','petBreed','petAge','petTemperament'];for(var i=0;i<required.length;i++){if(!document.getElementById(required[i]).value){showToast('Please complete all required pet details.');return;}}
      Object.assign(d,{petName:document.getElementById('petName').value.trim(),petAnimal:document.getElementById('petAnimal').value,petGender:document.getElementById('petGender').value,petBreed:document.getElementById('petBreed').value.trim(),petAge:document.getElementById('petAge').value,petAgeUnit:document.getElementById('petAgeUnit').value,petMedical:document.getElementById('petMedical').value,petTemperament:document.getElementById('petTemperament').value});
      if(state.service==='grooming')d.serviceNotes=document.getElementById('serviceNotes').value;else Object.assign(d,{hotelFeeding:document.getElementById('hotelFeeding').value,hotelMeds:document.getElementById('hotelMeds').value,hotelDropoff:document.getElementById('hotelDropoff').value,hotelPickup:document.getElementById('hotelPickup').value,playparkConsent:document.getElementById('playparkConsent').value});
      setStep('health');
    };
  }

  function vaccineList(){return state.draft.petAnimal==='cat'?[['anti_rabies','Anti-rabies'],['all_in_one','All-in-1 shot'],['anti_parasitic','Anti-parasitic']]:[['anti_rabies','Anti-rabies'],['combo','5/6/8-in-1 shot'],['bordetella','Kennel Cough / Bordetella'],['tick_flea','Tick and Flea treatment']];}
  function renderHealth(){
    var d=state.draft,vaccines=vaccineList();
    app.innerHTML=backButton('details')+heading('Health, records and membership','Files stay only in this browser preview. Membership validation uses the existing production read-only check.')+
      '<p class="section-label">Vaccine declarations</p><div class="option-grid">'+vaccines.map(function(v){return '<button class="mini-btn '+(d.vaccines[v[0]]?'selected':'')+'" data-vaccine="'+v[0]+'">'+v[1]+'</button>';}).join('')+'</div>'+
      '<label class="file-box" style="margin-top:14px"><input id="vaccineFiles" type="file" multiple accept="image/*,.pdf"><strong>Upload vaccine records</strong><small>JPG, PNG or PDF · selected locally only on staging</small></label><div class="file-list" id="vaccineFileList">'+state.files.vaccines.map(function(f){return '<span>📎 '+esc(f.name)+'</span>';}).join('')+'</div>'+
      '<label class="checkbox-card"><input id="bringVaccines" type="checkbox" '+(d.bringVaccines?'checked':'')+'><span><strong>I will bring vaccine records to the venue</strong><small>Required when no document is selected.</small></span></label>'+
      (state.service==='grooming'?'<label class="file-box" style="margin-top:14px"><input id="pegFiles" type="file" multiple accept="image/*"><strong>Upload grooming reference photos</strong><small>Optional style pegs · selected locally only</small></label><div class="file-list" id="pegFileList">'+state.files.pegs.map(function(f){return '<span>📎 '+esc(f.name)+'</span>';}).join('')+'</div>':'')+
      '<p class="section-label">Barkhaus membership</p><label><span class="field-label">Is this pet a registered member?</span><select class="form-control" id="memberChoice"><option value="no">No</option><option value="yes" '+(d.isMember?'selected':'')+'>Yes</option></select></label><div id="memberFields" '+(d.isMember?'':'hidden')+'>'+field('Membership ID','memberCode',d.memberCode,'text','BH-M001')+'<button class="outline-btn wide" id="validateMember" style="margin-top:9px">Validate production membership</button><div class="inline-status '+(state.member?'good':state.memberStatus?'bad':'')+'" id="memberStatus">'+esc(state.memberStatus)+'</div></div>'+
      (state.service==='hotel'?'<p class="section-label">Veterinary & emergency contacts</p>'+field('Veterinary clinic','vetClinic',d.vetClinic,'text','Clinic name')+field('Clinic contact','vetContact',d.vetContact,'tel','Phone number')+field('Clinic address','vetAddress',d.vetAddress,'text','Street, city')+'<div class="two-col">'+field('Emergency contact','emergencyName',d.emergencyName,'text','Full name')+field('Emergency phone','emergencyPhone',d.emergencyPhone,'tel','+63 9XX XXX XXXX')+'</div>':'')+
      '<button class="pill-btn wide" id="healthContinue">Continue</button>';
    app.querySelectorAll('[data-vaccine]').forEach(function(button){button.onclick=function(){var key=button.dataset.vaccine;d.vaccines[key]=!d.vaccines[key];render();};});
    document.getElementById('vaccineFiles').onchange=function(e){state.files.vaccines=Array.from(e.target.files||[]);render();};
    if(document.getElementById('pegFiles'))document.getElementById('pegFiles').onchange=function(e){state.files.pegs=Array.from(e.target.files||[]);render();};
    document.getElementById('memberChoice').onchange=function(e){d.isMember=e.target.value==='yes';state.member=null;state.memberStatus='';render();};
    if(document.getElementById('validateMember'))document.getElementById('validateMember').onclick=validateMembership;
    document.getElementById('healthContinue').onclick=function(){d.bringVaccines=document.getElementById('bringVaccines').checked;if(!state.files.vaccines.length&&!d.bringVaccines){showToast('Select vaccine documents or confirm you will bring them.');return;}if(d.isMember&&!state.member){showToast('Validate the membership or select No.');return;}if(state.service==='hotel'){['vetClinic','vetContact','vetAddress','emergencyName','emergencyPhone'].forEach(function(id){d[id]=document.getElementById(id).value;});}if(mode==='guest'&&!state.owner.email&&state.cart.length===0)setStep('owner');else setStep('waiver');};
  }
  async function validateMembership(){
    var code=document.getElementById('memberCode').value.trim().toUpperCase();state.draft.memberCode=code;state.memberStatus='Validating production membership…';render();
    try{var member=await rpc('validate_member',{p_code:code});if(!member||!member.member_code)throw new Error('Membership ID not found.');if(member.active===false)throw new Error('This membership is inactive.');if(member.valid_until&&new Date(member.valid_until+'T23:59:59')<new Date())throw new Error('This membership is expired.');var petNames=Array.isArray(member.pet_names)?member.pet_names:[member.pet_name];if(petNames.filter(Boolean).map(function(n){return n.trim().toLowerCase();}).indexOf(state.draft.petName.trim().toLowerCase())<0)throw new Error('Pet name does not match this membership.');if(member.tier!=='passport'&&member.branch_id&&member.branch_id!==state.branchId)throw new Error('Membership is valid only at its home branch.');state.member=member;state.memberStatus='Member verified · discount will be applied in Review.';}
    catch(error){state.member=null;state.memberStatus=error.message||'Could not validate membership.';}render();
  }

  function renderOwner(){
    var o=state.owner;
    app.innerHTML=backButton('health')+heading(mode==='account'?'Confirm your contact details':'Who should we contact?','Owner information is collected once and reused for every service in this order.')+(mode==='account'?'<div class="mock-profile"><span class="avatar">GE</span><div><strong>Saved customer profile</strong><small>Authentication remains simulated in this read-only staging version.</small></div></div>':'')+
      '<div class="two-col">'+field('First name','ownerFirst',o.first,'text','Juan')+field('Last name','ownerLast',o.last,'text','Dela Cruz')+'</div>'+field('Email','ownerEmail',o.email,'email','juan@example.com')+field('Mobile','ownerPhone',o.phone,'tel','+63 9XX XXX XXXX')+'<label><span class="field-label">How did you hear about us?</span><select class="form-control" id="ownerSource"><option>Website</option><option>Instagram</option><option>Facebook</option><option>TikTok</option><option>Friend or family referral</option><option>Walk-in / saw the branch</option><option>Google search</option><option>Other</option></select></label><button class="pill-btn wide" id="ownerContinue">Continue to waivers</button>';
    document.getElementById('ownerContinue').onclick=function(){var ids=['ownerFirst','ownerLast','ownerEmail','ownerPhone'];for(var i=0;i<ids.length;i++){if(!document.getElementById(ids[i]).value.trim()){showToast('Please complete all owner contact fields.');return;}}state.owner={first:document.getElementById('ownerFirst').value.trim(),last:document.getElementById('ownerLast').value.trim(),email:document.getElementById('ownerEmail').value.trim(),phone:document.getElementById('ownerPhone').value.trim(),source:document.getElementById('ownerSource').value};setStep('waiver');};
  }

  function renderWaiver(){
    var serviceText=state.service==='hotel'?'<strong>Pet Hotel General Terms and Liability Waiver</strong><p>I authorize Barkhaus to provide boarding and routine care for my pet. I have disclosed relevant medical, behavioral, feeding and medication information. I understand that room assignment, handling and group activity may be adjusted for safety.</p><p>I understand the hotel rescheduling, cancellation, no-show, late pickup and emergency-care policies, and that approved refunds are processed according to Barkhaus policy.</p>':'<strong>Grooming General Terms and Liability Waiver</strong><p>I authorize Barkhaus to perform the requested grooming services. I have disclosed medical, behavioral, allergy and sensitivity information that may affect the grooming process.</p><p>I acknowledge the risks related to matting, skin sensitivity, young or senior pets, and understand that Barkhaus may modify or stop service when needed for safety.</p>';
    var senior=(state.draft.petAgeUnit==='years'&&Number(state.draft.petAge)>=6)||String(state.draft.petMedical||'').trim();
    app.innerHTML=backButton(mode==='guest'&&!state.owner.email?'owner':'health')+heading('Review and accept waivers','Required acknowledgments are recorded per applicable pet and service in the future order implementation.')+'<div class="waiver-box">'+serviceText+'</div><label class="checkbox-card"><input id="generalWaiver" type="checkbox"><span><strong>I agree to the service terms and liability waiver.</strong></span></label><div class="waiver-box" style="margin-top:14px"><strong>Vaccine & Health Declaration</strong><p>I confirm that declared vaccines are current and effective before admission. I understand Barkhaus may refuse service when records are incomplete, expired, or not yet effective.</p></div><label class="checkbox-card"><input id="vaccineWaiver" type="checkbox"><span><strong>I agree to the Vaccine & Health Declaration.</strong></span></label>'+(senior?'<div class="waiver-box" style="margin-top:14px"><strong>Senior & Pre-existing Conditions</strong><p>I acknowledge that senior pets and pets with known medical conditions may face additional risk during service.</p></div><label class="checkbox-card"><input id="seniorWaiver" type="checkbox"><span><strong>I agree to the Senior & Pre-existing Conditions Waiver.</strong></span></label>':'')+'<label class="checkbox-card"><input id="mediaConsent" type="checkbox"><span><strong>Optional media consent</strong><small>I consent to photos and videos of my pet being used by Barkhaus.</small></span></label><button class="pill-btn wide" id="addToOrder">Add service to Review</button>';
    document.getElementById('addToOrder').onclick=function(){if(!document.getElementById('generalWaiver').checked||!document.getElementById('vaccineWaiver').checked||(senior&&!document.getElementById('seniorWaiver').checked)){showToast('Please accept all required waivers.');return;}state.draft.waivers={general:true,vaccine:true,senior:senior,media:document.getElementById('mediaConsent').checked};addItem();};
  }
  function itemPrice(){if(state.service==='grooming')return groomPrice()+selectedAddonTotal();var room=state.rooms.find(function(r){return r.id===state.draft.roomId;});return hotelTotal(room);}
  function addItem(){var raw=itemPrice(),rate=state.member?memberDiscountRate(state.service,state.member.membership_type||'standard'):0,discount=Math.round(raw*rate),d=JSON.parse(JSON.stringify(state.draft));state.cart.push({service:state.service,petName:d.petName,petSize:d.petSize,title:serviceLabel(state.service),schedule:state.service==='grooming'?d.groomDate+' · '+d.groomSlot:d.hotelCheckin+' → '+d.hotelCheckout,detail:state.service==='grooming'?({bath_dry:'Bath & Dry',basic:'Basic Groom',premium:'Premium Groom',ala_carte:'Ala Carte'}[d.groomPackage]):esc((state.rooms.find(function(r){return r.id===d.roomId;})||{}).name||'Selected room'),subtotal:raw,discount:discount,total:raw-discount,data:d,files:{vaccines:state.files.vaccines.map(function(f){return f.name;}),pegs:state.files.pegs.map(function(f){return f.name;})}});state.draft={};state.service=null;state.member=null;state.memberStatus='';state.files={vaccines:[],pegs:[]};setStep('review');}

  function totals(){var subtotal=state.cart.reduce(function(t,i){return t+i.subtotal;},0),discount=state.cart.reduce(function(t,i){return t+i.discount;},0),fee=Number(CONVENIENCE_FEE||0);return{subtotal:subtotal,discount:discount,fee:fee,total:subtotal-discount+fee};}
  function renderReview(){var t=totals();app.innerHTML=backButton('service')+heading('Review your Barkhaus order',(state.branch==='estancia'?'Estancia':'Eastwood')+' · '+state.cart.length+' service'+(state.cart.length===1?'':'s')+' · one future payment')+'<div class="mock-profile"><span class="avatar">'+esc((state.owner.first||'G')[0]+(state.owner.last||'E')[0])+'</span><div><strong>'+esc((state.owner.first||'Guest')+' '+(state.owner.last||'customer'))+'</strong><small>'+esc(state.owner.email||'Owner details collected during first service')+'</small></div></div><div class="cart-stack">'+state.cart.map(function(item,index){return '<article class="cart-card"><span class="item-letter">'+alpha(index)+'</span><div><div class="cart-title"><span><strong>'+esc(item.petName)+'</strong><small>'+item.title+'</small></span><b>'+peso(item.total)+'</b></div><p>'+item.detail+'<br>'+item.schedule+'</p><p>'+item.files.vaccines.length+' vaccine document'+(item.files.vaccines.length===1?'':'s')+' selected · required waivers accepted</p><div class="cart-actions"><button data-remove="'+index+'">Remove</button></div></div></article>';}).join('')+'</div><button class="add-service" id="addService"><strong>＋ Add another service</strong><br><small>Same branch and owner · choose any saved or new pet</small></button><div class="price-panel"><div class="price-row"><span>Services subtotal</span><b>'+peso(t.subtotal)+'</b></div>'+(t.discount?'<div class="price-row discount"><span>Membership savings</span><b>−'+peso(t.discount)+'</b></div>':'')+'<div class="price-row"><span>Future online checkout fee</span><b>'+peso(t.fee)+'</b></div><div class="price-row total"><span>Future order payment</span><b>'+peso(t.total)+'</b></div></div><button class="pill-btn wide" id="previewCheckout" '+(state.cart.length?'':'disabled')+'>Preview combined checkout</button>';
    app.querySelectorAll('[data-remove]').forEach(function(button){button.onclick=function(){state.cart.splice(Number(button.dataset.remove),1);render();};});document.getElementById('addService').onclick=function(){setStep('service');};document.getElementById('previewCheckout').onclick=function(){setStep('checkout');};}
  function renderCheckout(){var t=totals(),order='BH-3CE089';app.innerHTML=backButton('review')+heading('Combined checkout preview','This is the exact handoff shape planned for the future order Edge Function and separate Maya webhook.')+'<div class="preview-order"><small>ORDER REFERENCE</small><strong>'+order+'</strong><span>'+peso(t.total)+' future Maya payment</span></div><div class="cart-stack">'+state.cart.map(function(item,index){return '<article class="cart-card"><span class="item-letter">'+alpha(index)+'</span><div><div class="cart-title"><span><strong>'+order+'-'+alpha(index)+'</strong><small>'+esc(item.petName)+' · '+item.title+'</small></span><b>'+peso(item.total)+'</b></div><p>Child allocation · '+item.schedule+'</p></div></article>';}).join('')+'</div><div class="warn-note"><strong>Submission is disabled.</strong><br>No booking, pending hold, Storage upload, Maya checkout, webhook, payment record, or email will be created from this staging page.</div><button class="pill-btn wide" id="disabledSubmit" disabled>Real checkout not enabled yet</button><button class="outline-btn wide" id="emailPreview" style="margin-top:10px">Preview combined email summary</button><div id="emailSummary"></div>';
    document.getElementById('emailPreview').onclick=function(){document.getElementById('emailSummary').innerHTML='<div class="info-note"><strong>Confirmation email preview</strong><br>Subject: Your Barkhaus order is confirmed · '+order+'<br><br>'+state.cart.map(function(item,index){return order+'-'+alpha(index)+' · '+esc(item.petName)+' · '+item.title+' · '+item.schedule+' · '+peso(item.total);}).join('<br>')+'<br><br><strong>Total paid: '+peso(t.total)+'</strong></div>';};}

  document.getElementById('restartBtn').onclick=function(){if(confirm('Clear this staging order and restart?')){state.cart=[];state.branch=null;state.branchId=null;state.draft={};state.service=null;setStep('branch');}};
  initReads();
})();
