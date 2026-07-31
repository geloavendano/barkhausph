(function () {
  'use strict';

  var SUPABASE_URL = 'https://dxttnbtfhpanyiyduevn.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR4dHRuYnRmaHBhbnlpeWR1ZXZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MjkyNDcsImV4cCI6MjA5MjEwNTI0N30.jrMk8-_Ga01TydNPUwCzlymf1W44PjaXXIUjCLALb2s';
  var CACHE_KEY = 'barkhaus_customer_profile_cache';
  var LEGACY_CACHE_KEY = 'barkhaus_staging_customer';
  var AUTH_STORAGE_KEY = 'barkhaus-customer-auth-v1';
  var listeners = [];
  var currentSession = null;
  var currentProfile = readCache();
  var initialization = null;
  var subscribed = false;

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    window.BarkhausCustomerAccount = {
      initialize: function () { return Promise.reject(new Error('Customer sign-in could not be loaded.')); },
      profile: function () { return null; },
      hasSession: function () { return false; }
    };
    return;
  }

  var authOptions = {
    storageKey: AUTH_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce'
  };
  if (window.supabase.processLock) authOptions.lock = window.supabase.processLock;

  var client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: authOptions,
    global: { headers: { 'x-client-info': 'barkhaus-customer-web' } }
  });

  function readCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || localStorage.getItem(LEGACY_CACHE_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  function writeCache(profile) {
    currentProfile = profile || null;
    if (currentProfile) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(currentProfile));
      // The read-only staging booking page consumes this mirror while its own
      // network guard intentionally blocks Auth and account API requests.
      localStorage.setItem(LEGACY_CACHE_KEY, JSON.stringify(currentProfile));
    } else {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(LEGACY_CACHE_KEY);
    }
  }

  function emit() {
    var state = { session: currentSession, profile: currentProfile };
    listeners.slice().forEach(function (listener) {
      try { listener(state); } catch (error) { console.error(error); }
    });
  }

  async function functionError(error) {
    try {
      if (error && error.context && typeof error.context.clone === 'function') {
        var payload = await error.context.clone().json();
        if (payload && payload.error) return new Error(payload.error);
      }
    } catch (ignored) {}
    return new Error((error && error.message) || 'We could not reach your Barkhaus account.');
  }

  async function invoke(body) {
    if (!currentSession) throw new Error('Please sign in to continue.');
    var result = await client.functions.invoke('customer-account', { body: body });
    if (result.error) throw await functionError(result.error);
    if (result.data && Object.prototype.hasOwnProperty.call(result.data, 'profile')) {
      writeCache(result.data.profile);
      emit();
    }
    return result.data || {};
  }

  async function refreshProfile() {
    if (!currentSession) {
      writeCache(null);
      emit();
      return null;
    }
    var data = await invoke({ action: 'get_profile' });
    return data.profile || null;
  }

  async function initialize() {
    if (initialization) return initialization;
    initialization = (async function () {
      if (!subscribed) {
        subscribed = true;
        client.auth.onAuthStateChange(function (_event, session) {
          currentSession = session || null;
          window.setTimeout(function () {
            if (currentSession) refreshProfile().catch(function (error) {
              console.error('Customer profile refresh failed:', error);
              emit();
            });
            else {
              writeCache(null);
              emit();
            }
          }, 0);
        });
      }
      var result = await client.auth.getSession();
      if (result.error) throw result.error;
      currentSession = result.data.session || null;
      if (currentSession) await refreshProfile();
      else {
        writeCache(null);
        emit();
      }
      return { session: currentSession, profile: currentProfile };
    })();
    try { return await initialization; }
    catch (error) { initialization = null; throw error; }
  }

  async function signInWithGoogle() {
    var result = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/staging/account/',
        queryParams: { prompt: 'select_account' }
      }
    });
    if (result.error) throw result.error;
  }

  async function sendEmailOtp(email) {
    var result = await client.auth.signInWithOtp({
      email: String(email || '').trim().toLowerCase(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.origin + '/staging/account/'
      }
    });
    if (result.error) throw result.error;
  }

  async function verifyEmailOtp(email, token) {
    var result = await client.auth.verifyOtp({
      email: String(email || '').trim().toLowerCase(),
      token: String(token || '').trim(),
      type: 'email'
    });
    if (result.error) throw result.error;
    currentSession = result.data.session || null;
    if (currentSession) await refreshProfile();
    return { session: currentSession, profile: currentProfile };
  }

  async function signOut() {
    // Local scope removes only the public-site session. It does not revoke a
    // separate admin session that may exist for the same email in this browser.
    var result = await client.auth.signOut({ scope: 'local' });
    if (result.error) throw result.error;
    currentSession = null;
    writeCache(null);
    emit();
  }

  async function saveOwner(owner) {
    var data = await invoke({ action: 'save_owner', owner: owner });
    return data.profile || null;
  }

  async function savePet(pet) {
    var data = await invoke({ action: 'save_pet', pet: pet });
    return { petId: data.petId, profile: data.profile || null };
  }

  async function uploadDocument(petId, file) {
    var authorization = await invoke({
      action: 'create_document_upload',
      petId: petId,
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size
    });
    var upload = await fetch(authorization.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file
    });
    if (!upload.ok) throw new Error('The vaccine document upload failed. Please try again.');
    await invoke({
      action: 'register_document',
      petId: petId,
      path: authorization.path,
      fileName: file.name,
      contentType: file.type
    });
  }

  async function uploadDocuments(petId, drafts) {
    var uploads = (drafts || []).filter(function (draft) { return draft && draft.file; });
    for (var index = 0; index < uploads.length; index++) {
      await uploadDocument(petId, uploads[index].file);
    }
    return refreshProfile();
  }

  async function validateMembership(code, petName) {
    var data = await invoke({
      action: 'validate_membership',
      code: String(code || '').trim().toUpperCase(),
      petName: String(petName || '').trim()
    });
    return data.membership || null;
  }

  async function archivePet(petId) {
    var data = await invoke({ action: 'archive_pet', petId: petId });
    return data.profile || null;
  }

  async function archiveDocument(documentId) {
    var data = await invoke({ action: 'archive_document', documentId: documentId });
    return data.profile || null;
  }

  window.BarkhausCustomerAccount = {
    initialize: initialize,
    onChange: function (listener) {
      listeners.push(listener);
      return function () { listeners = listeners.filter(function (item) { return item !== listener; }); };
    },
    profile: function () { return currentProfile; },
    session: function () { return currentSession; },
    hasSession: function () { return !!currentSession; },
    email: function () { return currentSession && currentSession.user ? currentSession.user.email || '' : ''; },
    userMetadata: function () { return currentSession && currentSession.user ? currentSession.user.user_metadata || {} : {}; },
    signInWithGoogle: signInWithGoogle,
    sendEmailOtp: sendEmailOtp,
    verifyEmailOtp: verifyEmailOtp,
    signOut: signOut,
    refreshProfile: refreshProfile,
    saveOwner: saveOwner,
    savePet: savePet,
    validateMembership: validateMembership,
    uploadDocuments: uploadDocuments,
    archivePet: archivePet,
    archiveDocument: archiveDocument
  };
})();
