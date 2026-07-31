(function () {
  'use strict';

  var SESSION_KEY = 'barkhaus_staging_customer';
  var PROFILE_KEY = 'barkhaus_staging_registered_profile';
  var MODE_KEY = 'barkhaus_staging_mode';
  var isAccountPage = document.body.hasAttribute('data-staging-account-page');
  var entryModal = document.getElementById('stagingEntryModal');
  var manageModal = document.getElementById('stagingManageModal');
  var accountNav = document.getElementById('stagingAccountNav');
  var choices = document.getElementById('stagingEntryChoices');
  var accountForm = document.getElementById('stagingAccountForm');
  var entryTitle = document.getElementById('stagingEntryTitle');
  var entryIntro = document.getElementById('stagingEntryIntro');
  var accountDraft = null;
  var petDocumentsDraft = [];

  function readCustomer() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (error) { return null; }
  }

  function readStoredProfile() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); }
    catch (error) { return null; }
  }

  function writeCustomer(customer) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(customer));
    localStorage.setItem(PROFILE_KEY, JSON.stringify(customer));
    localStorage.setItem(MODE_KEY, 'account');
  }

  function finishIdentity(provider, email) {
    var stored = readStoredProfile();
    if (stored && String(stored.email).toLowerCase() === String(email).toLowerCase()) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
      localStorage.setItem(MODE_KEY, 'account');
      if (isAccountPage) {
        window.location.href = '/staging/?account=signed-in';
        return;
      }
      closeModal(entryModal);
      renderAccountNav();
      showLandingNotice('Welcome back, ' + stored.firstName + '. You’re signed in.');
      return;
    }
    if (!isAccountPage) {
      var params = new URLSearchParams({ provider: provider, email: email });
      window.location.href = '/staging/account/?' + params.toString();
      return;
    }
    beginAccountSetup(provider, email);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char];
    });
  }

  function openModal(modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (modal === entryModal) resetEntryModal();
  }

  function modalCard(modal) {
    return modal.querySelector('.staging-modal');
  }

  function resetEntryModal() {
    choices.hidden = false;
    accountForm.hidden = true;
    accountForm.innerHTML = '';
    if (entryIntro) entryIntro.hidden = false;
    entryTitle.textContent = isAccountPage ? 'Create your account' : 'How would you like to continue?';
    modalCard(entryModal).classList.remove('staging-modal--wide');
    accountDraft = null;
    petDocumentsDraft = [];
  }

  function continueToBooking(mode) {
    localStorage.setItem(MODE_KEY, mode);
    sessionStorage.removeItem('barkhaus_staging_cart');
    sessionStorage.removeItem('barkhaus_staging_context');
    window.location.href = '/staging/booking/';
  }

  function renderAccountNav() {
    if (!accountNav) return;
    var customer = readCustomer();
    if (!customer) {
      accountNav.innerHTML = '<button type="button" class="staging-account-pill" data-open-entry>Sign in</button>';
      return;
    }
    accountNav.innerHTML =
      '<div class="staging-account-menu">' +
        '<button type="button" class="staging-account-pill" data-toggle-account aria-expanded="false">Hi, ' + escapeHtml(customer.firstName) + '</button>' +
        '<div class="staging-account-menu-options" hidden>' +
          '<button type="button" class="staging-account-action" data-open-manage>Manage account</button>' +
          '<button type="button" class="staging-account-action" data-logout>Log out</button>' +
        '</div>' +
      '</div>';
  }

  function closeAccountMenu() {
    if (!accountNav) return;
    var toggle = accountNav.querySelector('[data-toggle-account]');
    var options = accountNav.querySelector('.staging-account-menu-options');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (options) options.hidden = true;
  }

  function showEmailForm() {
    choices.hidden = true;
    accountForm.hidden = false;
    if (entryIntro) entryIntro.hidden = true;
    entryTitle.textContent = isAccountPage ? 'Create an account with email' : 'Sign in with email';
    accountForm.innerHTML =
      '<p class="staging-modal-copy">Enter your email and we’ll send you a secure one-time code.</p>' +
      '<label class="staging-field-label">Email address<input class="staging-field" id="stagingEmail" type="email" value="gelo@example.com" autocomplete="email"></label>' +
      '<div class="staging-form-error" id="entryFormError" hidden></div>' +
      '<button class="staging-primary" type="button" data-send-otp>Send one-time code</button>' +
      '<button class="staging-secondary" type="button" data-entry-back>Back</button>';
  }

  function showOtpForm(email) {
    entryTitle.textContent = isAccountPage ? 'Verify your email' : 'Enter your code';
    accountForm.innerHTML =
      '<p class="staging-modal-copy">For this test, use code <strong>123456</strong> to continue as <strong>' + escapeHtml(email) + '</strong>.</p>' +
      '<label class="staging-field-label">One-time code<input class="staging-field" id="stagingOtp" inputmode="numeric" value="123456" maxlength="6"></label>' +
      '<div class="staging-form-error" id="entryFormError" hidden></div>' +
      '<button class="staging-primary" type="button" data-verify-otp data-email="' + escapeHtml(email) + '">Verify code</button>' +
      '<button class="staging-secondary" type="button" data-entry-back>Back</button>';
  }

  function beginAccountSetup(provider, email) {
    accountDraft = { provider: provider, email: email, owner: {} };
    choices.hidden = true;
    accountForm.hidden = false;
    if (entryIntro) entryIntro.hidden = true;
    modalCard(entryModal).classList.add('staging-modal--wide');
    showOwnerSetup();
  }

  function setupProgress(step) {
    return '<div class="staging-setup-progress"><span class="' + (step >= 1 ? 'active' : '') + '">1</span><i></i><span class="' + (step >= 2 ? 'active' : '') + '">2</span></div>' +
      '<div class="staging-setup-labels"><span>Owner details</span><span>Pet profile</span></div>';
  }

  function showOwnerSetup() {
    entryTitle.textContent = 'Create your account';
    var owner = accountDraft.owner || {};
    accountForm.innerHTML = setupProgress(1) +
      '<p class="staging-modal-copy">Tell us how to contact you about your pet and upcoming visits.</p>' +
      '<div class="staging-field-grid">' +
        field('First name', 'setupFirst', owner.firstName || 'Gelo', 'text', true) +
        field('Last name', 'setupLast', owner.lastName || 'Avendaño', 'text', true) +
      '</div>' +
      field('Verified email', 'setupEmail', accountDraft.email, 'email', true, 'readonly') +
      field('Mobile number', 'setupPhone', owner.phone || '+63 917 123 4567', 'tel', true) +
      '<label class="staging-field-label">How did you hear about us?<select class="staging-field" id="setupSource">' +
        '<option value="">Select…</option><option>Instagram</option><option>Facebook</option><option>TikTok</option><option>Friend or family referral</option><option>Walk-in / saw the branch</option><option>Google search</option><option>Other</option>' +
      '</select></label>' +
      '<div class="staging-form-error" id="entryFormError" hidden></div>' +
      '<div class="staging-form-actions"><button class="staging-secondary" type="button" data-entry-back>Back</button><button class="staging-primary" type="button" data-owner-next>Continue to pet</button></div>';
    document.getElementById('setupSource').value = owner.source || '';
  }

  function saveOwnerDraft() {
    var first = value('setupFirst');
    var last = value('setupLast');
    var phone = value('setupPhone');
    if (!first || !last || !phone) {
      showFormError('Please complete your first name, last name, and mobile number.');
      return false;
    }
    accountDraft.owner = { firstName: first, lastName: last, phone: phone, source: value('setupSource') };
    return true;
  }

  function showPetSetup() {
    if (!saveOwnerDraft()) return;
    entryTitle.textContent = 'Add your first pet';
    petDocumentsDraft = [];
    accountForm.innerHTML = setupProgress(2) +
      '<p class="staging-modal-copy">Add your pet once, then choose them during future bookings and we’ll fill in their details for you.</p>' +
      petEditorMarkup(defaultPet(), 'Create account') +
      '<div class="staging-form-actions"><button class="staging-secondary" type="button" data-owner-back>Back</button><button class="staging-primary" type="button" data-complete-account>Create account</button></div>';
    renderProfileVaccineGrid('dog', {});
    renderDocumentList();
  }

  function defaultPet() {
    return {
      id: 'pet-' + Date.now(), name: 'Mochi', animal: 'dog', breed: 'Shih Tzu',
      gender: 'female', size: 'small_dog', age: '2', ageUnit: 'years',
      temperament: 'friendly_all', medical: '', feeding: '', medications: '',
      membershipId: '', vaccineValidUntil: '', vaccines: {}, vaccineDocuments: [],
      bringRecords: false, vetClinic: '', vetContact: '', vetAddress: '',
      emergencyName: '', emergencyPhone: ''
    };
  }

  function field(label, id, fieldValue, type, required, attributes) {
    return '<label class="staging-field-label">' + escapeHtml(label) + (required ? ' <em>*</em>' : '') +
      '<input class="staging-field" id="' + id + '" type="' + (type || 'text') + '" value="' + escapeHtml(fieldValue || '') + '" ' + (attributes || '') + '></label>';
  }

  function textarea(label, id, fieldValue, placeholder) {
    return '<label class="staging-field-label">' + escapeHtml(label) +
      '<textarea class="staging-field staging-textarea" id="' + id + '" placeholder="' + escapeHtml(placeholder || '') + '">' + escapeHtml(fieldValue || '') + '</textarea></label>';
  }

  function petEditorMarkup(pet) {
    petDocumentsDraft = (pet.vaccineDocuments || []).slice();
    return '<div class="staging-profile-section"><p class="staging-profile-section-title">Basic details</p>' +
      '<div class="staging-field-grid">' +
        field('Pet name', 'profilePetName', pet.name, 'text', true) +
        '<label class="staging-field-label">Animal <em>*</em><select class="staging-field" id="profilePetAnimal" data-profile-animal><option value="dog">Dog</option><option value="cat">Cat</option></select></label>' +
        field('Breed', 'profilePetBreed', pet.breed, 'text', true) +
        '<label class="staging-field-label">Sex <em>*</em><select class="staging-field" id="profilePetGender"><option value="female">Female</option><option value="male">Male</option></select></label>' +
        '<label class="staging-field-label">Size <em>*</em><select class="staging-field" id="profilePetSize"><option value="small_dog">Small dog — up to 6 kg</option><option value="medium_dog">Medium dog — up to 15 kg</option><option value="large_dog">Large dog — up to 30 kg</option><option value="giant_dog">Giant dog — over 30 kg</option><option value="cat">Cat</option></select></label>' +
        field('Age', 'profilePetAge', pet.age, 'number', true, 'min="0" max="30"') +
        '<label class="staging-field-label">Age unit<select class="staging-field" id="profilePetAgeUnit"><option value="years">Years</option><option value="months">Months</option></select></label>' +
        '<label class="staging-field-label">Temperament <em>*</em><select class="staging-field" id="profilePetTemperament"><option value="friendly_all">Friendly with all</option><option value="friendly_shy">Friendly but shy</option><option value="selective">Selective</option><option value="reactive">Reactive</option><option value="first_time">First time in group care</option></select></label>' +
      '</div></div>' +
      '<div class="staging-profile-section"><p class="staging-profile-section-title">Health &amp; care</p>' +
        textarea('Medical conditions or allergies', 'profilePetMedical', pet.medical, 'Leave blank if none') +
        '<div class="staging-field-grid">' +
          textarea('Feeding instructions', 'profilePetFeeding', pet.feeding, 'e.g. 1 cup twice daily') +
          textarea('Medication / special care', 'profilePetMedications', pet.medications, 'Dose, timing, or handling notes') +
        '</div>' +
      '</div>' +
      '<div class="staging-profile-section"><p class="staging-profile-section-title">Vaccination record</p>' +
        '<p class="staging-profile-help">Mark every vaccine that is currently up to date.</p>' +
        '<div class="staging-check-grid" id="profileVaccineGrid"></div>' +
        field('Record valid until', 'profileVaccineValidUntil', pet.vaccineValidUntil, 'date', false) +
        '<label class="staging-document-upload">📎 <strong>Add vaccine documents</strong><span>JPG, PNG, PDF or HEIC · files won’t be uploaded yet, but we’ll remember what you selected</span><input type="file" data-profile-docs multiple accept="image/*,.pdf,.heic,.heif"></label>' +
        '<div class="staging-document-list" id="profileDocumentList"></div>' +
        '<label class="staging-inline-check"><input type="checkbox" id="profileBringRecords" ' + (pet.bringRecords ? 'checked' : '') + '><span>I will bring the original vaccination record to Barkhaus.</span></label>' +
      '</div>' +
      '<div class="staging-profile-section"><p class="staging-profile-section-title">Membership</p>' +
        field('Barkhaus membership code', 'profileMembershipId', pet.membershipId, 'text', false) +
        '<p class="staging-profile-help">The code will be checked against the selected branch during booking.</p>' +
      '</div>' +
      '<div class="staging-profile-section"><p class="staging-profile-section-title">Veterinary &amp; emergency contacts</p>' +
        '<div class="staging-field-grid">' +
          field('Veterinary clinic', 'profileVetClinic', pet.vetClinic, 'text', false) +
          field('Clinic contact', 'profileVetContact', pet.vetContact, 'tel', false) +
        '</div>' +
        field('Clinic address', 'profileVetAddress', pet.vetAddress, 'text', false) +
        '<div class="staging-field-grid">' +
          field('Emergency contact name', 'profileEmergencyName', pet.emergencyName, 'text', false) +
          field('Emergency contact number', 'profileEmergencyPhone', pet.emergencyPhone, 'tel', false) +
        '</div>' +
      '</div>' +
      '<div class="staging-form-error" id="petFormError" hidden></div>';
  }

  function vaccineDefinitions(animal) {
    return animal === 'cat'
      ? [{ key:'Anti_rabies', label:'Anti-rabies' }, { key:'All_in_1_shot', label:'All-in-1 shot' }, { key:'Anti_parasitic', label:'Anti-parasitic' }]
      : [{ key:'Anti_rabies', label:'Anti-rabies' }, { key:'5_6_8_in_1_shot', label:'5/6/8-in-1 shot' }, { key:'Kennel_Cough___Bordetella', label:'Kennel Cough / Bordetella' }, { key:'Tick_and_Flea_treatment', label:'Tick and Flea treatment' }];
  }

  function currentVaccineChecks() {
    var checks = {};
    document.querySelectorAll('#profileVaccineGrid [data-vaccine-key]').forEach(function (input) {
      checks[input.getAttribute('data-vaccine-key')] = input.checked;
    });
    return checks;
  }

  function renderProfileVaccineGrid(animal, saved) {
    var grid = document.getElementById('profileVaccineGrid');
    if (!grid) return;
    grid.innerHTML = vaccineDefinitions(animal).map(function (vaccine) {
      return '<label class="staging-vaccine-check"><input type="checkbox" data-vaccine-key="' + vaccine.key + '" ' + (saved[vaccine.key] ? 'checked' : '') + '><span>' + escapeHtml(vaccine.label) + '</span></label>';
    }).join('');
  }

  function renderDocumentList() {
    var list = document.getElementById('profileDocumentList');
    if (!list) return;
    list.innerHTML = petDocumentsDraft.length ? petDocumentsDraft.map(function (name) {
      return '<div class="staging-document-item"><span>📄 ' + escapeHtml(name) + '</span><button type="button" data-remove-profile-doc="' + escapeHtml(name) + '" aria-label="Remove ' + escapeHtml(name) + '">&times;</button></div>';
    }).join('') : '<p class="staging-profile-help">No document added yet.</p>';
  }

  function hydratePetEditor(pet) {
    document.getElementById('profilePetAnimal').value = pet.animal || 'dog';
    document.getElementById('profilePetGender').value = pet.gender || 'female';
    document.getElementById('profilePetSize').value = pet.size || (pet.animal === 'cat' ? 'cat' : 'small_dog');
    document.getElementById('profilePetAgeUnit').value = pet.ageUnit || 'years';
    document.getElementById('profilePetTemperament').value = pet.temperament || 'friendly_all';
    renderProfileVaccineGrid(pet.animal || 'dog', pet.vaccines || {});
    renderDocumentList();
  }

  function collectPetForm(existing) {
    var name = value('profilePetName');
    var animal = value('profilePetAnimal');
    var breed = value('profilePetBreed');
    var age = value('profilePetAge');
    var temperament = value('profilePetTemperament');
    if (!name || !animal || !breed || age === '' || !temperament) {
      showPetFormError('Please complete the required basic pet details.');
      return null;
    }
    var size = value('profilePetSize');
    if (animal === 'cat') size = 'cat';
    return {
      id: existing && existing.id ? existing.id : 'pet-' + Date.now(),
      name: name, animal: animal, breed: breed,
      gender: value('profilePetGender'), size: size, age: age,
      ageUnit: value('profilePetAgeUnit'), temperament: temperament,
      medical: value('profilePetMedical'), feeding: value('profilePetFeeding'),
      medications: value('profilePetMedications'), vaccines: currentVaccineChecks(),
      vaccineValidUntil: value('profileVaccineValidUntil'),
      vaccineDocuments: petDocumentsDraft.slice(),
      bringRecords: document.getElementById('profileBringRecords').checked,
      membershipId: value('profileMembershipId').toUpperCase(),
      vetClinic: value('profileVetClinic'), vetContact: value('profileVetContact'),
      vetAddress: value('profileVetAddress'), emergencyName: value('profileEmergencyName'),
      emergencyPhone: value('profileEmergencyPhone')
    };
  }

  function finishAccount() {
    var pet = collectPetForm(null);
    if (!pet) return;
    var owner = accountDraft.owner;
    writeCustomer({
      provider: accountDraft.provider,
      firstName: owner.firstName,
      lastName: owner.lastName,
      email: accountDraft.email,
      phone: owner.phone,
      source: owner.source,
      pets: [pet]
    });
    window.location.href = '/staging/?account=created';
  }

  function renderManage() {
    var customer = readCustomer();
    var content = document.getElementById('stagingManageContent');
    if (!customer) return;
    modalCard(manageModal).classList.remove('staging-modal--wide');
    document.getElementById('stagingManageTitle').textContent = 'Owner & pets';
    var pets = (customer.pets || []).map(function (pet) {
      var vaccineCount = Object.keys(pet.vaccines || {}).filter(function (key) { return pet.vaccines[key]; }).length;
      return '<div class="staging-profile-card">' +
        '<strong>' + escapeHtml(pet.name) + '</strong>' +
        '<span>' + escapeHtml(pet.breed || pet.animal) + ' · ' + escapeHtml(sizeLabel(pet.size)) + ' · ' + escapeHtml(temperamentLabel(pet.temperament)) + '</span>' +
        '<span>' + vaccineCount + ' vaccine' + (vaccineCount === 1 ? '' : 's') + ' marked current · ' + (pet.vaccineDocuments || []).length + ' document' + ((pet.vaccineDocuments || []).length === 1 ? '' : 's') + '</span>' +
        '<div class="staging-profile-actions"><button type="button" data-edit-pet="' + escapeHtml(pet.id) + '">Edit full profile</button><button type="button" data-delete-pet="' + escapeHtml(pet.id) + '">Delete</button></div>' +
      '</div>';
    }).join('');
    content.innerHTML =
      '<div class="staging-profile-card"><strong>' + escapeHtml(customer.firstName + ' ' + customer.lastName) + '</strong><span>' + escapeHtml(customer.email) + ' · ' + escapeHtml(customer.phone) + '</span><div class="staging-profile-actions"><button type="button" data-edit-owner>Edit owner details</button></div></div>' +
      '<p class="staging-kicker" style="margin-top:22px">Registered pets</p>' +
      (pets || '<p class="staging-modal-copy">No pets have been added yet.</p>') +
      '<button class="staging-primary" style="width:100%;margin-top:14px" type="button" data-add-pet>Add another pet</button>';
  }

  function showOwnerEditor() {
    var customer = readCustomer();
    document.getElementById('stagingManageTitle').textContent = 'Edit owner details';
    document.getElementById('stagingManageContent').innerHTML =
      '<div class="staging-field-grid">' + field('First name', 'manageOwnerFirst', customer.firstName, 'text', true) + field('Last name', 'manageOwnerLast', customer.lastName, 'text', true) + '</div>' +
      field('Email', 'manageOwnerEmail', customer.email, 'email', true, 'readonly') +
      field('Mobile number', 'manageOwnerPhone', customer.phone, 'tel', true) +
      '<div class="staging-form-error" id="manageFormError" hidden></div>' +
      '<div class="staging-form-actions"><button class="staging-secondary" type="button" data-manage-back>Back</button><button class="staging-primary" type="button" data-save-owner>Save owner</button></div>';
  }

  function saveOwner() {
    var customer = readCustomer();
    var first = value('manageOwnerFirst');
    var last = value('manageOwnerLast');
    var phone = value('manageOwnerPhone');
    if (!first || !last || !phone) {
      showNamedError('manageFormError', 'Please complete the required owner details.');
      return;
    }
    customer.firstName = first;
    customer.lastName = last;
    customer.phone = phone;
    writeCustomer(customer);
    renderAccountNav();
    renderManage();
  }

  function showPetEditor(petId) {
    var customer = readCustomer();
    var pet = (customer.pets || []).find(function (item) { return item.id === petId; }) || defaultPet();
    modalCard(manageModal).classList.add('staging-modal--wide');
    document.getElementById('stagingManageTitle').textContent = petId ? 'Edit ' + pet.name : 'Add a pet';
    document.getElementById('stagingManageContent').innerHTML =
      '<p class="staging-modal-copy">Keep this information up to date so we can prepare the right care for your pet.</p>' +
      petEditorMarkup(pet) +
      '<div class="staging-form-actions"><button class="staging-secondary" type="button" data-manage-back>Back</button><button class="staging-primary" type="button" data-save-pet="' + escapeHtml(pet.id) + '">Save pet</button></div>';
    hydratePetEditor(pet);
  }

  function savePet(id) {
    var customer = readCustomer();
    var existing = (customer.pets || []).find(function (item) { return item.id === id; });
    var pet = collectPetForm(existing || { id: id });
    if (!pet) return;
    if (existing) customer.pets = customer.pets.map(function (item) { return item.id === id ? pet : item; });
    else customer.pets.push(pet);
    writeCustomer(customer);
    renderManage();
  }

  function value(id) {
    var element = document.getElementById(id);
    return element ? String(element.value || '').trim() : '';
  }

  function showFormError(message) { showNamedError('entryFormError', message); }
  function showPetFormError(message) { showNamedError('petFormError', message); }
  function showNamedError(id, message) {
    var element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
    element.scrollIntoView({ behavior:'smooth', block:'center' });
  }

  function showLandingNotice(message) {
    var old = document.querySelector('.staging-landing-notice');
    if (old) old.remove();
    var notice = document.createElement('div');
    notice.className = 'staging-landing-notice';
    notice.textContent = message;
    document.body.appendChild(notice);
    setTimeout(function () { notice.classList.add('visible'); }, 20);
    setTimeout(function () { notice.classList.remove('visible'); }, 6500);
  }

  function sizeLabel(value) {
    return ({ small_dog:'Small dog', medium_dog:'Medium dog', large_dog:'Large dog', giant_dog:'Giant dog', cat:'Cat' })[value] || value || '';
  }

  function temperamentLabel(value) {
    return ({ friendly_all:'Friendly with all', friendly_shy:'Friendly but shy', selective:'Selective', reactive:'Reactive', first_time:'First time' })[value] || value || '';
  }

  document.addEventListener('click', function (event) {
    var bookingLink = event.target.closest('a[href="booking.html"], a[href="/booking.html"]');
    if (bookingLink) {
      event.preventDefault();
      if (readCustomer()) continueToBooking('account');
      else openModal(entryModal);
      return;
    }
    if (event.target.closest('[data-open-entry]')) openModal(entryModal);
    var accountToggle = event.target.closest('[data-toggle-account]');
    if (accountToggle) {
      var options = accountNav.querySelector('.staging-account-menu-options');
      var willOpen = options.hidden;
      options.hidden = !willOpen;
      accountToggle.setAttribute('aria-expanded', String(willOpen));
      return;
    }
    if (!isAccountPage && (event.target.closest('[data-close-staging]') || event.target === entryModal)) closeModal(entryModal);
    if (event.target.closest('[data-close-manage]') || event.target === manageModal) closeModal(manageModal);
    if (event.target.closest('[data-open-manage]')) { closeAccountMenu(); renderManage(); openModal(manageModal); }
    if (event.target.closest('[data-logout]')) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.setItem(MODE_KEY, 'guest');
      renderAccountNav();
      showLandingNotice('You’re now logged out.');
    }

    var action = event.target.closest('[data-staging-action]');
    if (action) {
      var type = action.getAttribute('data-staging-action');
      if (type === 'guest') continueToBooking('guest');
      if (type === 'google') finishIdentity('google', 'gelo@gmail.com');
      if (type === 'email') showEmailForm();
    }
    if (event.target.closest('[data-send-otp]')) {
      var email = value('stagingEmail');
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) showOtpForm(email);
      else showFormError('Enter a valid email address.');
    }
    var verify = event.target.closest('[data-verify-otp]');
    if (verify) {
      if (value('stagingOtp').length === 6) finishIdentity('email_otp', verify.getAttribute('data-email'));
      else showFormError('Enter the six-digit one-time code.');
    }
    if (event.target.closest('[data-owner-next]')) showPetSetup();
    if (event.target.closest('[data-owner-back]')) showOwnerSetup();
    if (event.target.closest('[data-complete-account]')) finishAccount();
    if (event.target.closest('[data-entry-back]')) resetEntryModal();

    if (event.target.closest('[data-edit-owner]')) showOwnerEditor();
    if (event.target.closest('[data-save-owner]')) saveOwner();
    var edit = event.target.closest('[data-edit-pet]');
    if (edit) showPetEditor(edit.getAttribute('data-edit-pet'));
    if (event.target.closest('[data-add-pet]')) showPetEditor(null);
    var save = event.target.closest('[data-save-pet]');
    if (save) savePet(save.getAttribute('data-save-pet'));
    if (event.target.closest('[data-manage-back]')) renderManage();
    var remove = event.target.closest('[data-delete-pet]');
    if (remove) {
      var current = readCustomer();
      var pet = (current.pets || []).find(function (item) { return item.id === remove.getAttribute('data-delete-pet'); });
      if (pet && window.confirm('Delete ' + pet.name + ' from your account?')) {
        current.pets = current.pets.filter(function (item) { return item.id !== pet.id; });
        writeCustomer(current);
        renderManage();
      }
    }
    var removeDoc = event.target.closest('[data-remove-profile-doc]');
    if (removeDoc) {
      var name = removeDoc.getAttribute('data-remove-profile-doc');
      petDocumentsDraft = petDocumentsDraft.filter(function (doc) { return doc !== name; });
      renderDocumentList();
    }
    if (!event.target.closest('.staging-account-menu')) closeAccountMenu();
  });

  document.addEventListener('change', function (event) {
    if (event.target.matches('[data-profile-animal]')) {
      var existing = currentVaccineChecks();
      if (event.target.value === 'cat') document.getElementById('profilePetSize').value = 'cat';
      else if (document.getElementById('profilePetSize').value === 'cat') document.getElementById('profilePetSize').value = 'small_dog';
      renderProfileVaccineGrid(event.target.value, existing);
    }
    if (event.target.matches('[data-profile-docs]')) {
      Array.from(event.target.files || []).forEach(function (file) {
        if (petDocumentsDraft.indexOf(file.name) === -1) petDocumentsDraft.push(file.name);
      });
      event.target.value = '';
      renderDocumentList();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (!isAccountPage && entryModal && entryModal.classList.contains('open')) closeModal(entryModal);
      if (manageModal && manageModal.classList.contains('open')) closeModal(manageModal);
    }
  });

  if (isAccountPage) {
    var accountParams = new URLSearchParams(window.location.search);
    var accountProvider = accountParams.get('provider');
    var accountEmail = accountParams.get('email');
    if (accountProvider && accountEmail) beginAccountSetup(accountProvider, accountEmail);
    else resetEntryModal();
  } else {
    renderAccountNav();
  }
  if (readCustomer() && !readStoredProfile()) localStorage.setItem(PROFILE_KEY, JSON.stringify(readCustomer()));
  if (new URLSearchParams(window.location.search).get('account') === 'created') {
    var signedInCustomer = readCustomer();
    if (signedInCustomer) showLandingNotice('Account created. You’re signed in as ' + signedInCustomer.firstName + '. Press Book Now whenever you’re ready.');
    window.history.replaceState({}, '', '/staging/');
  }
})();
