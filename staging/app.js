(function () {
  'use strict';

  var modal = document.getElementById('accountModal');
  var body = document.getElementById('modalBody');
  var title = document.getElementById('modalTitle');
  var eyebrow = document.getElementById('modalEyebrow');
  var copy = document.getElementById('modalCopy');

  function go(mode) {
    sessionStorage.setItem('barkhaus_staging_mode', mode);
    window.location.href = '/staging/booking/';
  }

  function openAccount(mode) {
    modal.hidden = false;
    eyebrow.textContent = mode === 'create' ? 'New customer account' : 'Customer account demo';
    title.textContent = mode === 'create' ? 'Create a Barkhaus account' : 'Log in to use saved pets';
    copy.textContent = 'This staging screen is simulated. It does not create, update, or authenticate a production account.';
    body.innerHTML =
      '<button class="auth-btn google" id="googleDemo"><strong>G</strong> Continue with Google</button>' +
      '<div class="divider"><span>or use email OTP</span></div>' +
      '<label class="field-label" for="demoEmail">Email address</label>' +
      '<input class="form-control" id="demoEmail" type="email" value="gelo@example.com">' +
      '<button class="pill-btn wide" id="emailDemo">Send demo one-time code</button>' +
      '<p class="fine-print">Public customer access will use a customer-profile record only. Admin access remains separately allow-listed.</p>';
    document.getElementById('googleDemo').onclick = function () { go('account'); };
    document.getElementById('emailDemo').onclick = function () {
      body.innerHTML =
        '<div class="success-note"><strong>Demo code sent</strong><span>Enter any six digits to continue.</span></div>' +
        '<label class="field-label" for="demoOtp">One-time code</label>' +
        '<input class="form-control otp" id="demoOtp" inputmode="numeric" maxlength="6" placeholder="000000">' +
        '<button class="pill-btn wide" id="verifyDemo">Verify demo account</button>';
      document.getElementById('verifyDemo').onclick = function () { go('account'); };
    };
  }

  document.querySelectorAll('[data-entry]').forEach(function (button) {
    button.addEventListener('click', function () {
      var mode = button.getAttribute('data-entry');
      if (mode === 'guest') go('guest');
      else openAccount(mode);
    });
  });
  document.getElementById('headerAccountBtn').onclick = function () { openAccount('login'); };
  document.getElementById('modalClose').onclick = function () { modal.hidden = true; };
  modal.addEventListener('click', function (event) { if (event.target === modal) modal.hidden = true; });
})();
