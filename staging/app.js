(function () {
  'use strict';

  var SESSION_KEY = 'barkhaus_staging_customer';
  var MODE_KEY = 'barkhaus_staging_mode';
  var entryModal = document.getElementById('stagingEntryModal');
  var manageModal = document.getElementById('stagingManageModal');
  var accountNav = document.getElementById('stagingAccountNav');
  var choices = document.getElementById('stagingEntryChoices');
  var accountForm = document.getElementById('stagingAccountForm');
  var pendingDestination = '/staging/booking/';

  function readCustomer() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (error) { return null; }
  }

  function writeCustomer(customer) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(customer));
    localStorage.setItem(MODE_KEY, 'account');
  }

  function sampleCustomer(provider, email) {
    return {
      provider: provider,
      firstName: 'Gelo',
      lastName: 'Avendaño',
      email: email || 'gelo@example.com',
      phone: '+63 917 123 4567',
      pets: [
        { id: 'mochi', name: 'Mochi', animal: 'dog', breed: 'Shih Tzu', gender: 'female', size: 'small_dog', age: '4', ageUnit: 'years', medical: '', temperament: 'friendly_all' },
        { id: 'milo', name: 'Milo', animal: 'dog', breed: 'Golden Retriever', gender: 'male', size: 'large_dog', age: '2', ageUnit: 'years', medical: 'Sensitive stomach', temperament: 'friendly_shy' }
      ]
    };
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

  function resetEntryModal() {
    choices.hidden = false;
    accountForm.hidden = true;
    accountForm.innerHTML = '';
  }

  function continueToBooking(mode) {
    localStorage.setItem(MODE_KEY, mode);
    sessionStorage.removeItem('barkhaus_staging_cart');
    sessionStorage.removeItem('barkhaus_staging_context');
    window.location.href = pendingDestination;
  }

  function renderAccountNav() {
    var customer = readCustomer();
    if (!customer) {
      accountNav.innerHTML = '<button type="button" class="staging-account-pill" data-open-entry>Sign in</button>';
      return;
    }
    accountNav.innerHTML =
      '<button type="button" class="staging-account-pill" data-open-manage>Hi, ' + escapeHtml(customer.firstName) + '</button>' +
      '<button type="button" class="staging-account-action" data-logout>Log out</button>';
  }

  function showEmailForm() {
    choices.hidden = true;
    accountForm.hidden = false;
    accountForm.innerHTML =
      '<p class="staging-modal-copy">Enter your email to preview the one-time-code sign-in.</p>' +
      '<label class="staging-field-label">Email address<input class="staging-field" id="stagingEmail" type="email" value="gelo@example.com" autocomplete="email"></label>' +
      '<button class="staging-primary" type="button" data-send-otp>Send one-time code</button>' +
      '<button class="staging-secondary" type="button" data-entry-back>Back</button>';
  }

  function showOtpForm(email) {
    accountForm.innerHTML =
      '<p class="staging-modal-copy">A preview code was sent to <strong>' + escapeHtml(email) + '</strong>.</p>' +
      '<label class="staging-field-label">One-time code<input class="staging-field" id="stagingOtp" inputmode="numeric" value="123456" maxlength="6"></label>' +
      '<button class="staging-primary" type="button" data-verify-otp data-email="' + escapeHtml(email) + '">Verify &amp; continue</button>' +
      '<button class="staging-secondary" type="button" data-entry-back>Back</button>';
  }

  function showProfileSetup(provider, email) {
    choices.hidden = true;
    accountForm.hidden = false;
    accountForm.innerHTML =
      '<p class="staging-modal-copy">First-time customer setup. These owner and pet details will be available in the booking form.</p>' +
      '<label class="staging-field-label">First name<input class="staging-field" id="setupFirst" value="Gelo"></label>' +
      '<label class="staging-field-label">Last name<input class="staging-field" id="setupLast" value="Avendaño"></label>' +
      '<label class="staging-field-label">Mobile number<input class="staging-field" id="setupPhone" value="+63 917 123 4567"></label>' +
      '<label class="staging-field-label">Pet name<input class="staging-field" id="setupPetName" value="Mochi"></label>' +
      '<label class="staging-field-label">Breed<input class="staging-field" id="setupPetBreed" value="Shih Tzu"></label>' +
      '<label class="staging-field-label">Pet size<select class="staging-field" id="setupPetSize"><option value="small_dog">Small dog</option><option value="medium_dog">Medium dog</option><option value="large_dog">Large dog</option><option value="giant_dog">Giant dog</option><option value="cat">Cat</option></select></label>' +
      '<button class="staging-primary" type="button" data-save-profile data-provider="' + escapeHtml(provider) + '" data-email="' + escapeHtml(email) + '">Create customer account &amp; continue</button>' +
      '<button class="staging-secondary" type="button" data-entry-back>Back</button>';
  }

  function saveProfile(button) {
    var size = document.getElementById('setupPetSize').value;
    var profile = {
      provider: button.getAttribute('data-provider'),
      firstName: document.getElementById('setupFirst').value.trim() || 'Customer',
      lastName: document.getElementById('setupLast').value.trim(),
      email: button.getAttribute('data-email'),
      phone: document.getElementById('setupPhone').value.trim(),
      pets: [{
        id: 'pet-' + Date.now(),
        name: document.getElementById('setupPetName').value.trim() || 'Pet',
        animal: size === 'cat' ? 'cat' : 'dog',
        breed: document.getElementById('setupPetBreed').value.trim(),
        gender: 'female', size: size, age: '2', ageUnit: 'years', medical: '', temperament: 'friendly_all'
      }]
    };
    writeCustomer(profile);
    continueToBooking('account');
  }

  function renderManage() {
    var customer = readCustomer();
    var content = document.getElementById('stagingManageContent');
    if (!customer) return;
    var pets = (customer.pets || []).map(function (pet) {
      return '<div class="staging-profile-card">' +
        '<strong>' + escapeHtml(pet.name) + '</strong>' +
        '<span>' + escapeHtml(pet.breed || pet.animal) + ' · ' + escapeHtml(sizeLabel(pet.size)) + '</span>' +
        '<div class="staging-profile-actions"><button type="button" data-edit-pet="' + escapeHtml(pet.id) + '">Edit</button><button type="button" data-delete-pet="' + escapeHtml(pet.id) + '">Delete</button></div>' +
      '</div>';
    }).join('');
    content.innerHTML =
      '<div class="staging-profile-card"><strong>' + escapeHtml(customer.firstName + ' ' + customer.lastName) + '</strong><span>' + escapeHtml(customer.email) + ' · ' + escapeHtml(customer.phone) + '</span></div>' +
      '<p class="staging-kicker" style="margin-top:22px">Registered pets</p>' + pets +
      '<button class="staging-primary" style="width:100%;margin-top:14px" type="button" data-add-pet>Add a pet</button>';
  }

  function showPetEditor(petId) {
    var customer = readCustomer();
    var pet = (customer.pets || []).find(function (item) { return item.id === petId; }) || { id: 'pet-' + Date.now(), name: '', animal: 'dog', breed: '', gender: 'female', size: 'small_dog', age: '', ageUnit: 'years', medical: '', temperament: 'friendly_all' };
    document.getElementById('stagingManageContent').innerHTML =
      '<p class="staging-modal-copy">These preview details will be available for selection inside the real booking form.</p>' +
      '<label class="staging-field-label">Pet name<input class="staging-field" id="managePetName" value="' + escapeHtml(pet.name) + '"></label>' +
      '<label class="staging-field-label" style="margin-top:10px">Breed<input class="staging-field" id="managePetBreed" value="' + escapeHtml(pet.breed) + '"></label>' +
      '<label class="staging-field-label" style="margin-top:10px">Size<select class="staging-field" id="managePetSize"><option value="small_dog">Small dog</option><option value="medium_dog">Medium dog</option><option value="large_dog">Large dog</option><option value="giant_dog">Giant dog</option><option value="cat">Cat</option></select></label>' +
      '<button class="staging-primary" style="width:100%;margin-top:14px" type="button" data-save-pet="' + escapeHtml(pet.id) + '">Save pet</button>' +
      '<button class="staging-secondary" style="width:100%;margin-top:8px" type="button" data-manage-back>Back</button>';
    document.getElementById('managePetSize').value = pet.size;
  }

  function savePet(id) {
    var customer = readCustomer();
    var existing = (customer.pets || []).find(function (item) { return item.id === id; });
    var pet = existing || { id: id, animal: 'dog', gender: 'female', age: '2', ageUnit: 'years', medical: '', temperament: 'friendly_all' };
    pet.name = document.getElementById('managePetName').value.trim() || 'New pet';
    pet.breed = document.getElementById('managePetBreed').value.trim();
    pet.size = document.getElementById('managePetSize').value;
    pet.animal = pet.size === 'cat' ? 'cat' : 'dog';
    if (!existing) customer.pets.push(pet);
    writeCustomer(customer);
    renderManage();
    renderAccountNav();
  }

  function sizeLabel(value) {
    return ({ small_dog: 'Small dog', medium_dog: 'Medium dog', large_dog: 'Large dog', giant_dog: 'Giant dog', cat: 'Cat' })[value] || value || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char];
    });
  }

  document.addEventListener('click', function (event) {
    var bookingLink = event.target.closest('a[href="booking.html"], a[href="/booking.html"]');
    if (bookingLink) {
      event.preventDefault();
      pendingDestination = '/staging/booking/';
      if (readCustomer()) continueToBooking('account');
      else openModal(entryModal);
      return;
    }
    if (event.target.closest('[data-open-entry]')) openModal(entryModal);
    if (event.target.closest('[data-close-staging]') || event.target === entryModal) closeModal(entryModal);
    if (event.target.closest('[data-close-manage]') || event.target === manageModal) closeModal(manageModal);
    if (event.target.closest('[data-open-manage]')) { renderManage(); openModal(manageModal); }
    if (event.target.closest('[data-logout]')) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.setItem(MODE_KEY, 'guest');
      renderAccountNav();
    }
    var action = event.target.closest('[data-staging-action]');
    if (action) {
      var type = action.getAttribute('data-staging-action');
      if (type === 'guest') continueToBooking('guest');
      if (type === 'google') showProfileSetup('google', 'gelo@gmail.com');
      if (type === 'email') showEmailForm();
    }
    if (event.target.closest('[data-send-otp]')) {
      var email = document.getElementById('stagingEmail').value.trim();
      if (email) showOtpForm(email);
    }
    var verify = event.target.closest('[data-verify-otp]');
    if (verify) showProfileSetup('email_otp', verify.getAttribute('data-email'));
    var saveProfileButton = event.target.closest('[data-save-profile]');
    if (saveProfileButton) saveProfile(saveProfileButton);
    if (event.target.closest('[data-entry-back]')) resetEntryModal();
    var edit = event.target.closest('[data-edit-pet]');
    if (edit) showPetEditor(edit.getAttribute('data-edit-pet'));
    if (event.target.closest('[data-add-pet]')) showPetEditor(null);
    var save = event.target.closest('[data-save-pet]');
    if (save) savePet(save.getAttribute('data-save-pet'));
    if (event.target.closest('[data-manage-back]')) renderManage();
    var remove = event.target.closest('[data-delete-pet]');
    if (remove) {
      var customer = readCustomer();
      customer.pets = (customer.pets || []).filter(function (pet) { return pet.id !== remove.getAttribute('data-delete-pet'); });
      writeCustomer(customer);
      renderManage();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (entryModal.classList.contains('open')) closeModal(entryModal);
      if (manageModal.classList.contains('open')) closeModal(manageModal);
    }
  });

  renderAccountNav();
})();
