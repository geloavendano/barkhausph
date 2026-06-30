/* ═══════════════════════════════════════════════════════════
   Barkhaus — validation.js
   Per-step validation functions for the booking flow
   Depends on: booking state (booking, booking.service, etc.)
   ═══════════════════════════════════════════════════════════ */

function validateStep(step) {
  var validators = { 1:validateStep1, 2:validateStep2, 3:validateStep3,
                     4:validateStep4, 5:validateStep5, 6:validateStep6, 7:validateStep7 };
  return validators[step] ? validators[step]() : true;
}
function validateStep1() {
  if (!booking.location) { alert('Please select a branch.'); return false; }
  return true;
}
function validateStep2() {
  if (!booking.service) { alert('Please select a service.'); return false; }
  return true;
}
function validateStep3() {
  var svc = booking.service;
  if (svc === 'grooming') {
    if (!booking.petSize)      { alert('Please select a pet size.'); return false; }
    if (!booking.groomService) { alert('Please select a grooming service.'); return false; }
    if (booking.groomService === 'ala_carte' && Object.keys(booking.selectedAddons).length === 0) {
      alert('Ala Carte requires at least one add-on.'); return false;
    }
  }
  if (svc === 'hotel') {
    if (!booking.petSize) { alert('Please select a pet size.'); return false; }
    if (booking.location === 'estancia' && booking.petSize === 'cat') {
      alert('Cat hotel is only available at Eastwood.'); return false;
    }
    if (!document.getElementById('hotelCheckin').value || !document.getElementById('hotelCheckout').value) {
      alert('Please select check-in and check-out dates.'); return false;
    }
    if (!booking.hotelRoomType) { alert('Please select an available room.'); return false; }
  }
  if (svc === 'daycare') {
    if (!booking.petSize) { alert('Please select a pet size.'); return false; }
    if (!document.getElementById('daycareDate').value) { alert('Please select a date.'); return false; }
    if (!document.getElementById('daycareDropoff').value) { alert('Please select a drop-off time.'); return false; }
    if (!document.getElementById('daycarePickup').value)  { alert('Please select a pick-up time.');  return false; }
    if (!booking.daycareOpenTime) {
      var dH = parseInt(document.getElementById('daycareDropoff').value);
      var pH = parseInt(document.getElementById('daycarePickup').value);
      if (pH <= dH) { alert('Pick-up time must be after drop-off time.'); return false; }
    }
  }
  if (svc === 'studio') {
    if (!document.getElementById('studioDate').value) { alert('Please select a date.'); return false; }
    if (!booking.studioSlot) { alert('Please select a time slot.'); return false; }
  }
  return true;
}
function validateStep4() {
  var svc = booking.service;
  if (svc === 'grooming') {
    if (!document.getElementById('groomDate').value) { alert('Please select a date.'); return false; }
    if (!booking.groomSlot) { alert('Please select a time slot.'); return false; }
  }
  if (svc === 'hotel') {
    if (!document.getElementById('hotelDropoffTime').value) { alert('Please select a drop-off time.'); return false; }
    if (!document.getElementById('hotelPickupTime').value)  { alert('Please select a pick-up time.');  return false; }
  }
  return true;
}
function validateStep5() {
  if (!document.getElementById('petName').value.trim())  { alert("Please enter your pet's name."); return false; }
  if (!booking.petAnimal)                                { alert('Please select Dog or Cat.'); return false; }
  if (!booking.petGender)                                { alert("Please select your pet's sex."); return false; }
  if (!document.getElementById('petBreed').value.trim()) { alert("Please enter your pet's breed."); return false; }
  if (!document.getElementById('petAgeNum').value.trim()) { alert("Please enter your pet's age."); return false; }
  if (typeof isGroomAgeBlocked === 'function' && isGroomAgeBlocked()) {
    alert("We can't wait to meet your furry baby! 💛 Premium Grooming isn't recommended for pets 7 months and under — they're still a little too sensitive for the full session. Please choose Bath & Dry or Basic Grooming instead, and we'll give them all the gentle pampering they deserve.");
    return false;
  }
  if ((booking.service === 'hotel' || booking.service === 'daycare') && !booking.petSize) {
    alert("Please select your pet's size."); return false;
  }
  if (!booking.petTemperament) { alert("Please select your pet's temperament."); return false; }
  var _noFiles = !uploadedVaccineFiles || uploadedVaccineFiles.length === 0;
  if (_noFiles && !document.getElementById('bringVaccines').classList.contains('checked')) {
    alert('Please confirm that you will bring your pet\'s vaccine records to the venue, or upload them above.'); return false;
  }
  if (!document.getElementById('vaccineWaiver').classList.contains('checked')) {
    alert('Please agree to the vaccine liability declaration.'); return false;
  }
  var _seniorRow = document.getElementById('seniorWaiverRow');
  if (_seniorRow && _seniorRow.style.display !== 'none') {
    if (!document.getElementById('seniorWaiverAck').classList.contains('checked')) {
      alert('Please agree to the senior/medical pet acknowledgment to proceed.'); return false;
    }
  }
  if (booking.isMember === true && !booking.memberValid) {
    alert('Please enter a valid Membership ID, or select “No” if you are not a member.'); return false;
  }
  return true;
}
function validateStep6() {
  if (!document.getElementById('ownerFirst').value.trim() || !document.getElementById('ownerLast').value.trim()) {
    alert('Please enter your full name.'); return false;
  }
  var email = document.getElementById('ownerEmail').value.trim();
  if (!email || !email.includes('@')) { alert('Please enter a valid email address.'); return false; }
  if (!document.getElementById('ownerPhone').value.trim()) { alert('Please enter your mobile number.'); return false; }
  return true;
}
function validateStep7() {
  var svc = booking.service;
  var cfg = SERVICE_CONFIG[svc];
  if (cfg && cfg.generalWaiverId) {
    var waiverEl = document.getElementById(cfg.generalWaiverId);
    if (waiverEl && !waiverEl.classList.contains('checked')) {
      alert('Please agree to the General Terms and Liability Waiver.'); return false;
    }
  }
  if (!document.getElementById('waiverVaccineDecl').classList.contains('checked')) {
    alert('Please agree to the Vaccine & Health Declaration.'); return false;
  }
  if (svc === 'studio' && !document.getElementById('waiverStudio').classList.contains('checked')) {
    alert('Please agree to the Studio Usage Agreement.'); return false;
  }
  var _age  = parseInt((document.getElementById('petAgeNum')||{}).value) || 0;
  var _unit = (document.getElementById('petAgeUnit')||{}).value || 'months';
  var _med  = ((document.getElementById('petMedical')||{}).value || '').trim();
  if ((_age >= 6 && _unit === 'years') || _med.length > 0) {
    if (!document.getElementById('seniorWaiver').classList.contains('checked')) {
      alert('Please agree to the Senior & Pre-existing Conditions Waiver.'); return false;
    }
  }
  return true;
}
