import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import {
  arrayUnion,
  collection,
  doc,
  getDocs,
  getDoc,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  deleteDoc,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

let app;
let currentUser = null;
let currentProfile = null;
let stopMenus = null;
let stopFriends = null;
let friendAvailability = [];
let sharedMeals = [];
let friendEntries = [];
let myGroups = [];
let stopGroups = null;
let stopSharedAvailability = null;
let stopSharedMeals = null;
let stopRecipeShares = null;
let sharedRecipeRecords = [];
let sharedScheduleEvents = [];
let stopScheduleShares = null;
let stopPersonalData = [];
let personalReady = { recipes: false, plans: false, shopping: false, settings: false };
let personalBaseline = { recipes: new Map(), plans: new Map(), shopping: new Map(), settings: null };
let applyingPersonalSnapshot = false;
let personalSyncTimer = null;
let syncingPersonalData = false;
let loadingRemoteState = false;
let deepLinkHandled = false;

const ref = (collectionName, id) => doc(db, collectionName, id);
const pairId = (uidA, uidB) => [uidA, uidB].sort().join('__');
const friendlyError = error => {
  const messages = {
    'auth/email-already-in-use': 'That email already has an account. Try signing in.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/invalid-credential': 'That email or password didn’t match.',
    'auth/popup-closed-by-user': 'The Google sign-in window was closed before finishing.',
    'auth/unauthorized-domain': 'Add cleveraggie.github.io to Firebase Authentication’s authorized domains.',
    'permission-denied': 'Firebase blocked this action. Check that the Firestore rules have been published.',
    'unavailable': 'Firebase is temporarily unavailable. Check your connection and try again.'
  };
  return messages[error?.code] || error?.message || 'Something went wrong. Please try again.';
};
const reportListenerError = (label, error) => {
  console.error(`The Dinner Table could not load ${label}.`, error);
  toast(`Could not load ${label}. ${friendlyError(error)}`);
};
const toast = message => app?.toast?.(message);
const personalCacheKey = uid => `sunday-table-personal-${uid}`;
const lastPersonalUserKey = 'sunday-table-last-cloud-user';
const seedRecipeIds = new Set(['r1', 'r2', 'r3', 'r4']);

const personalCollection = name => collection(db, 'userData', currentUser.uid, name);
const personalDocument = (name, id) => doc(db, 'userData', currentUser.uid, name, id);
const personalSettingsDocument = () => doc(db, 'userData', currentUser.uid, 'settings', 'app');

function ensureShoppingItemIds() {
  if (!app?.state?.items) return;
  for (const item of app.state.items) if (!item.id) item.id = crypto.randomUUID();
}

function activatePersonalAccount(user) {
  const uid = user.uid;
  const previousUid = localStorage.getItem(lastPersonalUserKey);
  const localState = app.state;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(personalCacheKey(uid)) || 'null'); } catch { cached = null; }
  if (cached) {
    const cachedRecipes = Array.isArray(cached.recipes) ? cached.recipes : [];
    // The app can be used while Firebase is restoring the login session. If a
    // recipe was saved in that window, keep the newer browser copy instead of
    // replacing it with this account's older cache on startup.
    if (previousUid === uid && Number(localState.localSavedAt) > Number(cached.savedAt || 0)) {
      const merged = new Map(cachedRecipes.map(recipe => [recipe.id, recipe]));
      for (const recipe of Array.isArray(localState.recipes) ? localState.recipes : []) merged.set(recipe.id, recipe);
      app.state.recipes = [...merged.values()];
    } else {
      app.state.recipes = cachedRecipes;
    }
    app.state.plans = cached.plans && typeof cached.plans === 'object' ? cached.plans : {};
    app.state.items = Array.isArray(cached.items) ? cached.items : [];
    app.state.dayEvents = Array.isArray(cached.dayEvents) ? cached.dayEvents : [];
    app.weekOffset = Number(cached.weekOffset) || 0;
    app.state.recipeImporterUrl = String(cached.recipeImporterUrl || '');
  } else if (previousUid && previousUid !== uid) {
    app.state.recipes = [];
    app.state.plans = {};
    app.state.items = [];
    app.state.dayEvents = [];
    app.weekOffset = 0;
    app.state.recipeImporterUrl = '';
  }
  ensureShoppingItemIds();
  localStorage.setItem(lastPersonalUserKey, uid);
  app.save();
}

function cachePersonalData() {
  if (!currentUser || !app?.state) return;
  ensureShoppingItemIds();
  const state = app.state;
  localStorage.setItem(personalCacheKey(currentUser.uid), JSON.stringify({
    recipes: state.recipes || [], plans: state.plans || {}, items: state.items || [], dayEvents: state.dayEvents || [],
    weekOffset: app.weekOffset || 0, recipeImporterUrl: state.recipeImporterUrl || '',
    savedAt: Number(state.localSavedAt) || Date.now()
  }));
}

function recipePayload(recipe) {
  return {
    name: String(recipe.name || ''), source: String(recipe.source || ''),
    category: String(recipe.category || ''),
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
    instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [],
    notes: String(recipe.notes || ''), emoji: String(recipe.emoji || '🍽️'),
    time: String(recipe.time || '')
  };
}

function planPayload(meals) {
  return (Array.isArray(meals) ? meals : []).map(meal => ({
    id: String(meal.id || ''), recipe: String(meal.recipe || ''), meal: String(meal.meal || '')
  }));
}

function shoppingPayload(item, position) {
  return { name: String(item.name || ''), qty: String(item.qty || ''), checked: Boolean(item.checked), position };
}

function personalSnapshot(name, snapshot) {
  const docs = snapshot.docs;
  personalBaseline[name] = new Map(docs.map(item => [item.id, item.data()]));
  if (name === 'recipes') {
    const local = Array.isArray(app.state.recipes) ? app.state.recipes : [];
    const remote = docs.filter(item => !item.data().deleted).map(item => ({ id: item.id, ...recipePayload(item.data()) }));
    const remoteIds = new Set(docs.map(item => item.id));
    const cloudKeys = new Set(remote.map(item => `${item.name || ''}\n${item.source || ''}`.toLowerCase()));
    const localOnly = local.filter(item => item.id && !remoteIds.has(item.id) &&
      (docs.length === 0 || !seedRecipeIds.has(item.id)) &&
      !cloudKeys.has(`${item.name || ''}\n${item.source || ''}`.toLowerCase()));
    app.state.recipes = [...remote, ...localOnly];
  } else if (name === 'plans') {
    const merged = { ...(app.state.plans || {}) };
    for (const item of docs) {
      if (item.data().deleted) delete merged[item.id];
      else merged[item.id] = planPayload(item.data().meals);
    }
    app.state.plans = merged;
  } else if (name === 'shopping') {
    ensureShoppingItemIds();
    const local = Array.isArray(app.state.items) ? app.state.items : [];
    const remote = docs.filter(item => !item.data().deleted)
      .sort((a, b) => Number(a.data().position || 0) - Number(b.data().position || 0))
      .map(item => ({ id: item.id, name: String(item.data().name || ''), qty: String(item.data().qty || ''), checked: Boolean(item.data().checked) }));
    const remoteIds = new Set(docs.map(item => item.id));
    const remoteNames = new Set(remote.map(item => `${item.name}\n${item.qty}`.toLowerCase()));
    const localOnly = local.filter(item => !remoteIds.has(item.id) && !remoteNames.has(`${item.name || ''}\n${item.qty || ''}`.toLowerCase()));
    app.state.items = [...remote, ...localOnly];
  }
  personalReady[name] = !snapshot.metadata?.fromCache;
  applyingPersonalSnapshot = true;
  try { app.save(); } finally { applyingPersonalSnapshot = false; }
  if (Object.values(personalReady).every(Boolean)) schedulePersonalSync();
}

function personalSettingsSnapshot(snapshot) {
  personalBaseline.settings = snapshot.exists() ? snapshot.data() : null;
  if (snapshot.exists()) {
    const data = snapshot.data();
    app.weekOffset = Number(data.weekOffset) || 0;
    app.state.recipeImporterUrl = String(data.recipeImporterUrl || '');
    const merged = new Map((Array.isArray(data.dayEvents) ? data.dayEvents : []).map(item => [item.id, item]));
    for (const item of app.state.dayEvents || []) {
      const remote = merged.get(item.id);
      if (!remote || Number(item.updatedAt || 0) > Number(remote.updatedAt || 0)) merged.set(item.id, item);
    }
    app.state.dayEvents = [...merged.values()];
  }
  personalReady.settings = !snapshot.metadata?.fromCache;
  applyingPersonalSnapshot = true;
  try { app.save(); } finally { applyingPersonalSnapshot = false; }
  if (Object.values(personalReady).every(Boolean)) schedulePersonalSync();
}

function subscribeToPersonalData() {
  stopPersonalData.forEach(stop => stop?.());
  personalReady = { recipes: false, plans: false, shopping: false, settings: false };
  personalBaseline = { recipes: new Map(), plans: new Map(), shopping: new Map(), settings: null };
  stopPersonalData = [
    onSnapshot(personalCollection('recipes'), snapshot => personalSnapshot('recipes', snapshot), error => reportListenerError('saved recipes', error)),
    onSnapshot(personalCollection('plans'), snapshot => personalSnapshot('plans', snapshot), error => reportListenerError('meal plans', error)),
    onSnapshot(personalCollection('shopping'), snapshot => personalSnapshot('shopping', snapshot), error => reportListenerError('shopping list', error)),
    onSnapshot(personalSettingsDocument(), snapshot => personalSettingsSnapshot(snapshot), error => reportListenerError('app settings', error))
  ];
}

function schedulePersonalSync() {
  if (!currentUser || !Object.values(personalReady).every(Boolean) || applyingPersonalSnapshot) return;
  clearTimeout(personalSyncTimer);
  personalSyncTimer = setTimeout(() => syncPersonalData().catch(error => {
    console.error('Could not sync personal app data to Firebase.', error);
    toast(`Your changes are saved on this device, but Firebase sync failed (${error?.code || 'error'}): ${friendlyError(error)}`, 8000);
  }), 500);
}

function activeRecipeRecords() {
  return new Map((app.state.recipes || []).filter(recipe => recipe.id).map(recipe => [String(recipe.id), recipePayload(recipe)]));
}

function activePlanRecords() {
  return new Map(Object.entries(app.state.plans || {}).map(([date, meals]) => [date, planPayload(meals)]));
}

function activeShoppingRecords() {
  ensureShoppingItemIds();
  return new Map((app.state.items || []).map((item, index) => [String(item.id), shoppingPayload(item, index)]));
}

async function writePersonalOperations(name, operations) {
  for (let start = 0; start < operations.length; start += 400) {
    const batch = writeBatch(db);
    const chunk = operations.slice(start, start + 400);
    for (const operation of chunk) batch.set(personalDocument(name, operation.id), { ...operation.data, updatedAt: serverTimestamp() });
    await batch.commit();
    for (const operation of chunk) personalBaseline[name].set(operation.id, operation.data);
  }
}

function diffPersonalRecords(name, current, baseline, payloadForCloud) {
  const operations = [];
  for (const [id, value] of current) {
    const remote = baseline.get(id);
    const data = payloadForCloud(value);
    const remotePayload = remote && !remote.deleted ? payloadForCloud(remote) : null;
    if (!remotePayload || JSON.stringify(data) !== JSON.stringify(remotePayload)) operations.push({ id, data: { ...data, deleted: false } });
  }
  for (const [id, remote] of baseline) {
    if (!remote.deleted && !current.has(id)) operations.push({ id, data: { deleted: true } });
  }
  return operations;
}

async function syncPersonalData() {
  if (!currentUser || syncingPersonalData || !Object.values(personalReady).every(Boolean)) return;
  syncingPersonalData = true;
  try {
    await writePersonalOperations('recipes', diffPersonalRecords('recipes', activeRecipeRecords(), personalBaseline.recipes, recipePayload));
    await writePersonalOperations('plans', diffPersonalRecords('plans', activePlanRecords(), personalBaseline.plans, value => ({ meals: planPayload(Array.isArray(value) ? value : value.meals) })));
    await writePersonalOperations('shopping', diffPersonalRecords('shopping', activeShoppingRecords(), personalBaseline.shopping, value => shoppingPayload(value, value.position)));
    const settings = { weekOffset: Number(app.weekOffset) || 0, recipeImporterUrl: String(app.state.recipeImporterUrl || ''), dayEvents: app.state.dayEvents || [] };
    const remoteSettings = personalBaseline.settings;
    if (!remoteSettings || remoteSettings.weekOffset !== settings.weekOffset || String(remoteSettings.recipeImporterUrl || '') !== settings.recipeImporterUrl || JSON.stringify(remoteSettings.dayEvents || []) !== JSON.stringify(settings.dayEvents)) {
      await setDoc(personalSettingsDocument(), { ...settings, updatedAt: serverTimestamp() });
      personalBaseline.settings = settings;
    }
    cachePersonalData();
  } finally {
    syncingPersonalData = false;
  }
}

async function saveRecipeToCloud(recipe) {
  if (!currentUser || !recipe?.id) return false;
  const data = recipePayload(recipe);
  await setDoc(personalDocument('recipes', String(recipe.id)), {
    ...data,
    deleted: false,
    updatedAt: serverTimestamp()
  });
  personalBaseline.recipes.set(String(recipe.id), { ...data, deleted: false });
  cachePersonalData();
  return true;
}

function scheduledEventPayload(event) {
  return {
    id: String(event.id || ''), date: String(event.date || ''),
    title: String(event.title || ''), details: String(event.details || ''),
    sharedWith: Array.isArray(event.sharedWith) ? [...new Set(event.sharedWith.map(String))] : [],
    updatedAt: Number(event.updatedAt) || Date.now(), deleted: Boolean(event.deleted)
  };
}

async function saveScheduledEvent(event) {
  if (!currentUser || !event?.id) return false;
  const privateEvent = { ...scheduledEventPayload(event), deleted: false, updatedAt: Date.now() };
  const connectedFriendUids = new Set(friendEntries.map(friend => friend.uid));
  const invalidRecipients = privateEvent.sharedWith.filter(uid => uid !== currentUser.uid && !connectedFriendUids.has(uid));
  if (invalidRecipients.length) throw new Error('A selected friend is no longer connected. Reconnect with their friend code, then share the plan again.');
  event.updatedAt = privateEvent.updatedAt;
  const visibleTo = privateEvent.sharedWith.filter(uid => uid !== currentUser.uid);
  const sharedRef = ref('sharedScheduleEvents', `${currentUser.uid}__${event.id}`);
  const batch = writeBatch(db);
  const settings = {
    weekOffset: Number(app.weekOffset) || 0,
    recipeImporterUrl: String(app.state.recipeImporterUrl || ''),
    dayEvents: app.state.dayEvents || []
  };
  batch.set(personalSettingsDocument(), { ...settings, updatedAt: serverTimestamp() });
  batch.set(sharedRef, {
    eventId: String(event.id), ownerUid: currentUser.uid,
    ownerName: currentProfile?.displayName || currentProfile?.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'A friend',
    date: privateEvent.date, title: privateEvent.title, details: privateEvent.details,
    visibleTo, deleted: false, updatedAt: serverTimestamp()
  });
  await batch.commit();
  personalBaseline.settings = settings;
  cachePersonalData();
  return true;
}

async function deleteScheduledEvent(eventId) {
  if (!currentUser || !eventId) return false;
  const event = (app.state.dayEvents || []).find(item => item.id === eventId);
  const tombstone = { id: String(eventId), date: event?.date || '', title: event?.title || '', details: '', sharedWith: [], updatedAt: Date.now(), deleted: true };
  const events = (app.state.dayEvents || []).filter(item => item.id !== eventId).concat(tombstone);
  const settings = {
    weekOffset: Number(app.weekOffset) || 0,
    recipeImporterUrl: String(app.state.recipeImporterUrl || ''), dayEvents: events
  };
  const batch = writeBatch(db);
  batch.set(personalSettingsDocument(), { ...settings, updatedAt: serverTimestamp() });
  batch.set(ref('sharedScheduleEvents', `${currentUser.uid}__${eventId}`), {
    eventId: String(eventId), ownerUid: currentUser.uid, ownerName: '',
    date: tombstone.date, title: tombstone.title, details: '', visibleTo: [],
    deleted: true, updatedAt: serverTimestamp()
  });
  await batch.commit();
  app.state.dayEvents = events;
  personalBaseline.settings = settings;
  cachePersonalData();
  app.renderWeek();
  return true;
}

function subscribeToScheduleShares() {
  stopScheduleShares?.();
  sharedScheduleEvents = [];
  if (!currentUser) return;
  stopScheduleShares = onSnapshot(
    query(collection(db, 'sharedScheduleEvents'), where('visibleTo', 'array-contains', currentUser.uid)),
    snapshot => {
      sharedScheduleEvents = snapshot.docs.filter(item => !item.data().deleted).map(item => ({ id: item.id, ...item.data() }));
      app.render();
    },
    error => reportListenerError('plans shared with you', error)
  );
}

function wrapAppSaveWithPersonalSync() {
  if (app.personalSyncWrapped) return;
  const saveLocally = app.save;
  app.save = (...args) => {
    ensureShoppingItemIds();
    const result = saveLocally(...args);
    cachePersonalData();
    if (!applyingPersonalSnapshot) schedulePersonalSync();
    return result;
  };
  app.personalSyncWrapped = true;
}

function makeFriendCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `DT-${Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')}`;
}

function setAuthMessage(message, isError = false) {
  const status = document.getElementById('firebaseAuthMessage');
  if (!status) return;
  status.textContent = message;
  status.className = `firebase-auth-message${isError ? ' error' : ''}`;
}

function renderAuthPanel() {
  const panel = document.getElementById('firebaseAuthPanel');
  if (!panel) return;
  if (!currentUser) {
    panel.innerHTML = `<div class="card firebase-auth-card">
      <div class="eyebrow">Your Dinner Table account</div>
      <h3>Sign in to collaborate</h3>
      <p class="profile-note">Accounts keep your friend code and dinner availability synced so shared menus work across devices.</p>
      <form id="firebaseEmailForm" class="firebase-email-form">
        <label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" minlength="6" required placeholder="At least 6 characters"></label>
        <div class="firebase-auth-actions"><button class="btn primary" type="submit" value="sign-in">Sign in</button><button class="btn" type="submit" value="sign-up">Create account</button></div>
      </form>
      <button class="btn firebase-google" id="firebaseGoogleSignIn" type="button">Continue with Google</button>
      <p id="firebaseAuthMessage" class="firebase-auth-message" aria-live="polite"></p>
    </div>`;
    panel.querySelector('#firebaseEmailForm').addEventListener('submit', async event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const email = String(form.get('email') || '').trim();
      const password = String(form.get('password') || '');
      const button = event.submitter;
      panel.querySelectorAll('button').forEach(item => item.disabled = true);
      try {
        if (button?.value === 'sign-up') await createUserWithEmailAndPassword(auth, email, password);
        else await signInWithEmailAndPassword(auth, email, password);
      } catch (error) { setAuthMessage(friendlyError(error), true); }
      finally { panel.querySelectorAll('button').forEach(item => item.disabled = false); }
    });
    panel.querySelector('#firebaseGoogleSignIn').addEventListener('click', async () => {
      try { await signInWithPopup(auth, googleProvider); }
      catch (error) { setAuthMessage(friendlyError(error), true); }
    });
    return;
  }

  const name = currentProfile?.displayName || currentUser.displayName || currentUser.email || 'Dinner Table member';
  panel.innerHTML = `<div class="card firebase-auth-card firebase-signed-in">
    <div class="eyebrow">Signed in</div><div class="firebase-account-row"><div><h3>${escapeHtml(name)}</h3><p class="profile-note">${escapeHtml(currentUser.email || 'Google account')}</p></div><button class="btn small" id="firebaseSignOut" type="button">Sign out</button></div>
    <p class="firebase-friend-note">Your profile, recipes, meal plans, private day plans, and shopping list are saved to Firebase and follow your account across devices. Availability is shared only with the groups you choose below.</p>
    <p id="firebaseAuthMessage" class="firebase-auth-message" aria-live="polite"></p>
  </div>`;
  panel.querySelector('#firebaseSignOut').addEventListener('click', async () => {
    try { await signOut(auth); }
    catch (error) { setAuthMessage(friendlyError(error), true); }
  });
}

function renderFriendAvailability() {
  if (!friendAvailability.length) return '<div class="profile-note">Connect by friend code to see your friends’ open evenings here.</div>';
  return friendAvailability.map(friend => `<div class="firebase-friend-row"><b>${escapeHtml(friend.displayName || friend.code)} <small>· ${escapeHtml(friend.groupName || 'Shared group')}</small></b><span>${escapeHtml(friend.days.join(', ') || 'No evenings shared')}</span></div>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function saveProfileToCloud() {
  if (!currentUser || !currentProfile) return;
  const state = app.state;
  const displayName = String(state.profile?.name || currentProfile.displayName || '').trim().slice(0, 60);
  const updated = { ...currentProfile, displayName };
  await setDoc(ref('users', currentUser.uid), { ...updated, updatedAt: serverTimestamp() }, { merge: true });
  await setDoc(ref('friendCodes', currentProfile.friendCode), {
    uid: currentUser.uid, displayName, updatedAt: serverTimestamp()
  });
  currentProfile = updated;
  renderAuthPanel();
}

async function ensureUserProfile(user) {
  const userRef = ref('users', user.uid);
  const snapshot = await getDoc(userRef);
  const localName = String(app.state.profile?.name || user.displayName || user.email?.split('@')[0] || '').trim();
  let profile;
  if (snapshot.exists()) {
    profile = snapshot.data();
  } else {
    profile = {
      displayName: localName,
      friendCode: makeFriendCode(),
      availability: Array.isArray(app.state.availability) ? app.state.availability : [true, true, true, true, true, true, true],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await setDoc(userRef, profile);
  }

  let codeDoc = await getDoc(ref('friendCodes', profile.friendCode));
  if (codeDoc.exists() && codeDoc.data().uid !== user.uid) {
    profile = { ...profile, friendCode: makeFriendCode() };
    await setDoc(userRef, { friendCode: profile.friendCode, updatedAt: Date.now() }, { merge: true });
    codeDoc = await getDoc(ref('friendCodes', profile.friendCode));
  }
  await setDoc(ref('friendCodes', profile.friendCode), {
    uid: user.uid,
    displayName: profile.displayName || localName,
    updatedAt: serverTimestamp()
  });
  currentProfile = { ...profile, displayName: profile.displayName || localName };
  app.state.profile = { name: currentProfile.displayName, code: currentProfile.friendCode, friends: [] };
  app.state.availability = Array.isArray(currentProfile.availability) ? currentProfile.availability : [true, true, true, true, true, true, true];
  app.save();
}

async function migrateLocalMenus() {
  const localMenus = app.state.events.filter(event => !event.ownerUid);
  for (const event of localMenus) {
    const menuRef = ref('menus', event.id);
    const existing = await getDoc(menuRef);
    if (existing.exists()) continue;
    const migrated = {
      id: event.id,
      name: event.name || 'Shared dinner',
      date: event.date || '',
      note: event.note || '',
      theme: event.theme || 'classic',
      accepting: event.accepting !== false,
      contributions: Array.isArray(event.contributions) ? event.contributions : [],
      collaborators: [],
      ownerUid: currentUser.uid,
      memberUids: [currentUser.uid],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };
    await setDoc(menuRef, migrated);
  }
}

function subscribeToMenus() {
  stopMenus?.();
  const menusQuery = query(collection(db, 'menus'), where('memberUids', 'array-contains', currentUser.uid));
  stopMenus = onSnapshot(menusQuery, snapshot => {
    const localMenus = app.state.events.filter(event => !event.ownerUid);
    const cloudMenus = snapshot.docs.map(item => ({
      ...item.data(), id: item.id,
      theme: item.data().theme || 'classic',
      contributions: Array.isArray(item.data().contributions) ? item.data().contributions : [],
      collaborators: Array.isArray(item.data().collaborators) ? item.data().collaborators : [],
      memberUids: Array.isArray(item.data().memberUids) ? item.data().memberUids : []
    }));
    loadingRemoteState = true;
    app.state.events = [...localMenus, ...cloudMenus];
    app.save();
    loadingRemoteState = false;

    const menuFromLink = new URLSearchParams(location.search).get('menu');
    if (!deepLinkHandled && menuFromLink) {
      const target = cloudMenus.find(event => event.id === menuFromLink);
      if (target) {
        deepLinkHandled = true;
        app.selectedEventId = target.id;
        app.guestMode = target.ownerUid !== currentUser.uid;
        document.querySelector('.tab[data-view="parties"]')?.click();
        app.render();
      }
    }
  }, error => reportListenerError('party menus', error));
}

function subscribeToFriends() {
  stopFriends?.();
  const friendsQuery = query(collection(db, 'friendships'), where('memberUids', 'array-contains', currentUser.uid));
  stopFriends = onSnapshot(friendsQuery, async snapshot => {
    const entries = snapshot.docs.map(item => item.data()).map(data => {
      const otherUid = data.memberUids.find(uid => uid !== currentUser.uid);
      return { uid: otherUid, code: data.friendCodesByUid?.[otherUid] || '' };
    }).filter(friend => friend.uid && friend.code);
    const codes = [...new Set(entries.map(friend => friend.code))];
    app.state.profile.friends = codes;
    friendEntries = await Promise.all(entries.map(async friend => {
      const code = friend.code;
      let friendDoc;
      try { friendDoc = await getDoc(ref('friendCodes', code)); }
      catch { return { ...friend, displayName: code }; }
      if (!friendDoc.exists()) return { ...friend, displayName: code };
      const data = friendDoc.data();
      return { ...friend, displayName: data.displayName || code };
    }));
    renderAuthPanel(); renderPrivacyGroups(); renderEventGroupOptions();
    app.save();
  }, error => reportListenerError('friend connections', error));
}

function subscribeToGroups() {
  stopGroups?.();
  const groupsQuery = query(collection(db, 'groups'), where('ownerUid', '==', currentUser.uid));
  stopGroups = onSnapshot(groupsQuery, snapshot => {
    myGroups = snapshot.docs.map(item => ({
      ...item.data(), id: item.id,
      memberUids: Array.isArray(item.data().memberUids) ? item.data().memberUids : [currentUser.uid],
      availability: Array.isArray(item.data().availability) ? item.data().availability : Array(7).fill(false)
    }));
    renderPrivacyGroups(); renderEventGroupOptions();
    app?.render?.();
  }, error => reportListenerError('your groups', error));
}

function subscribeToSharedAvailability() {
  stopSharedAvailability?.();
  const sharedQuery = query(collection(db, 'groupAvailability'), where('visibleTo', 'array-contains', currentUser.uid));
  stopSharedAvailability = onSnapshot(sharedQuery, snapshot => {
    friendAvailability = snapshot.docs.map(item => item.data())
      .filter(data => data.ownerUid !== currentUser.uid)
      .map(data => ({
        code: data.ownerUid,
        displayName: data.displayName || 'Dinner Table member',
        groupName: data.groupName || 'Shared group',
        availability: Array.isArray(data.availability) ? data.availability : Array(7).fill(false),
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter((_, index) => data.availability?.[index])
      }));
    renderAuthPanel(); renderPrivacyGroups(); app?.render?.();
  }, error => reportListenerError('shared dinner availability', error));
}

function subscribeToSharedMeals() {
  stopSharedMeals?.();
  const mealsQuery = query(collection(db, 'groupMeals'), where('visibleTo', 'array-contains', currentUser.uid));
  stopSharedMeals = onSnapshot(mealsQuery, snapshot => {
    sharedMeals = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    app?.render?.();
  }, error => reportListenerError('shared meal plans', error));
}

function subscribeToRecipeShares() {
  stopRecipeShares?.();
  const sharesQuery = query(collection(db, 'recipeShares'), where('visibleTo', 'array-contains', currentUser.uid));
  stopRecipeShares = onSnapshot(sharesQuery, snapshot => {
    sharedRecipeRecords = snapshot.docs.map(item => ({ ...item.data(), id: item.id }));
    renderSharedRecipes();
  }, error => reportListenerError('shared recipes', error));
}

function renderSharedRecipes() {
  const root = document.getElementById('sharedRecipesList');
  if (!root) return;
  const incoming = currentUser
    ? sharedRecipeRecords.filter(item => item.ownerUid !== currentUser.uid)
    : [];
  root.innerHTML = `<section class="shared-recipes-section"><div class="shared-recipes-heading"><div><div class="eyebrow">From your friends</div><h3>Recipes shared with you</h3></div></div>${incoming.length ? `<div class="shared-recipes-grid">${incoming.map(recipe => `<article class="card shared-recipe-card"><div class="shared-recipe-top"><span class="recipe-category">${escapeHtml(recipe.groupName || 'Shared recipe')}</span><span class="shared-recipe-by">From ${escapeHtml(recipe.ownerName || 'a friend')}</span></div><h4>${escapeHtml(recipe.recipeName || 'Shared recipe')}</h4><div class="recipe-meta"><span>${(recipe.ingredients || []).length} ingredients</span><span>${(recipe.instructions || []).length} steps</span></div>${recipe.source ? `<a class="shared-recipe-link" href="${escapeHtml(recipe.source)}" target="_blank" rel="noopener noreferrer">Open original ↗</a>` : ''}<button type="button" class="btn small" data-save-shared-recipe="${escapeHtml(recipe.id)}">Save a copy</button></article>`).join('')}</div>` : `<p class="profile-note">${currentUser ? 'When a friend shares a recipe with one of your groups, it will appear here.' : 'Sign in to see recipes your friends share with your groups.'}</p>`}</section>`;
}

function openRecipeShareDialog(recipe) {
  if (!currentUser) { toast('Sign in to share recipes with friends.'); return; }
  if (!myGroups.length) { toast('Create a private group and add friends before sharing recipes.'); return; }
  const form = document.getElementById('recipeShareForm');
  form.elements.recipeId.value = recipe.id;
  document.getElementById('recipeShareName').textContent = `Sharing “${recipe.name}”`;
  const active = new Set(sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.recipeId === recipe.id).map(item => item.groupId));
  document.getElementById('recipeShareGroups').innerHTML = myGroups.map(group => `<label class="recipe-share-group"><input type="checkbox" name="shareGroup" value="${escapeHtml(group.id)}" ${active.has(group.id) ? 'checked' : ''}><span><b>${escapeHtml(group.name)}</b><small>${Math.max(0, group.memberUids.length - 1)} friend${group.memberUids.length === 2 ? '' : 's'}</small></span></label>`).join('');
  document.getElementById('recipeShareDialog').showModal();
}

async function saveRecipeShares(form) {
  const recipeId = String(new FormData(form).get('recipeId') || '');
  const recipe = app.state.recipes.find(item => item.id === recipeId);
  if (!recipe) throw new Error('That recipe is no longer in your recipe box.');
  const selectedIds = new Set(new FormData(form).getAll('shareGroup').map(String));
  const groups = myGroups.filter(group => selectedIds.has(group.id));
  if (groups.length !== selectedIds.size) throw new Error('A selected group is no longer available. Reopen the sharing window and try again.');
  const existing = sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.recipeId === recipeId);
  const selectedGroupIds = new Set(groups.map(group => group.id));
  const batch = writeBatch(db);
  let operationCount = 0;
  for (const group of groups) {
    const shareId = `${currentUser.uid}_${recipeId}_${group.id}`;
    batch.set(ref('recipeShares', shareId), {
      ownerUid: currentUser.uid,
      ownerName: currentProfile?.displayName || currentProfile?.name || currentUser.displayName || currentUser.email?.split('@')[0] || 'Dinner Table friend',
      recipeId,
      recipeName: String(recipe.name || 'Recipe'),
      source: String(recipe.source || ''),
      category: String(recipe.category || 'Other'),
      ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [],
      notes: String(recipe.notes || ''),
      emoji: String(recipe.emoji || '🍽️'),
      time: String(recipe.time || ''),
      groupId: group.id,
      groupName: group.name,
      visibleTo: [...new Set([currentUser.uid, ...group.memberUids])],
      updatedAt: serverTimestamp()
    });
    operationCount++;
  }
  for (const share of existing) {
    if (!selectedGroupIds.has(share.groupId)) { batch.delete(ref('recipeShares', share.id)); operationCount++; }
  }
  if (operationCount) await batch.commit();
  document.getElementById('recipeShareDialog').close();
  toast(groups.length ? `Recipe shared with ${groups.length} group${groups.length === 1 ? '' : 's'}.` : 'Recipe sharing turned off.');
}

async function updateSharedRecipeSnapshot(recipe) {
  if (!currentUser) return;
  const shares = sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.recipeId === recipe.id);
  if (!shares.length) return;
  const batch = writeBatch(db);
  for (const share of shares) {
    batch.update(ref('recipeShares', share.id), {
      recipeName: String(recipe.name || 'Recipe'), source: String(recipe.source || ''),
      category: String(recipe.category || 'Other'), ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients : [],
      instructions: Array.isArray(recipe.instructions) ? recipe.instructions : [], notes: String(recipe.notes || ''),
      emoji: String(recipe.emoji || '🍽️'), time: String(recipe.time || ''), updatedAt: serverTimestamp()
    });
  }
  await batch.commit();
}

async function deleteRecipeShares(recipeId) {
  if (!currentUser) return;
  const shares = sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.recipeId === recipeId);
  if (!shares.length) return;
  const batch = writeBatch(db);
  shares.forEach(share => batch.delete(ref('recipeShares', share.id)));
  await batch.commit();
}

function saveSharedRecipeCopy(share) {
  if ((app.state.recipes || []).some(recipe => recipe.source === share.source && recipe.name === share.recipeName)) {
    toast('That recipe is already in your recipe box.');
    return;
  }
  app.state.recipes.unshift({
    id: crypto.randomUUID(), name: share.recipeName || 'Shared recipe', source: share.source || `Shared by ${share.ownerName || 'a friend'}`,
    category: share.category || 'Other', ingredients: Array.isArray(share.ingredients) ? share.ingredients : [],
    instructions: Array.isArray(share.instructions) ? share.instructions : [], notes: String(share.notes || ''),
    emoji: share.emoji || '🍽️', time: share.time || ''
  });
  app.save();
  toast('A copy was saved to your recipe box.');
}

function renderEventGroupOptions() {
  const options = document.getElementById('eventGroupOptions');
  if (!options) return;
  if (!currentUser) {
    options.innerHTML = '<span class="profile-note">Sign in to share menus with groups.</span>';
    return;
  }
  const groups = myGroups.length
    ? `<div class="party-audience-block"><b>Groups</b><div class="group-checks">${myGroups.map(group => `<label class="group-check"><input type="checkbox" name="audienceGroup" value="${escapeHtml(group.id)}"><span>${escapeHtml(group.name)}</span></label>`).join('')}</div></div>`
    : '';
  const friends = friendEntries.length
    ? `<div class="party-audience-block"><b>Specific friends</b><div class="group-checks">${friendEntries.map(friend => `<label class="group-check"><input type="checkbox" name="directInvite" value="${escapeHtml(friend.uid)}"><span>${escapeHtml(friend.displayName)}</span></label>`).join('')}</div></div>`
    : '';
  options.innerHTML = groups + friends || '<span class="profile-note">Connect with friends or create a group in My Plans to choose who can see this menu.</span>';
}

function preparePartySharing() { renderEventGroupOptions(); }

function renderPrivacyGroups() {
  const root = document.getElementById('privacyGroups');
  if (!root) return;
  if (!currentUser) {
    root.innerHTML = '<div class="card privacy-groups"><div class="eyebrow">Private groups</div><h3 class="profile-heading">Share availability with the right people.</h3><p class="profile-note">Sign in to create groups and choose which evenings each group can see.</p></div>';
    return;
  }
  const friendOptions = friendEntries.length
    ? friendEntries.map(friend => `<div class="group-member-choice"><input type="checkbox" name="memberUid" value="${escapeHtml(friend.uid)}" aria-label="Add ${escapeHtml(friend.displayName)} to the new group"><span>${escapeHtml(friend.displayName)}</span></div>`).join('')
    : '<p class="profile-note">Connect with friends by code above, then you can add them to a group.</p>';
  const renderGroup = group => `<form class="card privacy-group" data-group-form="${escapeHtml(group.id)}">
    <div class="privacy-group-head"><div><div class="eyebrow">Group</div><input class="profile-name" name="groupName" maxlength="50" required value="${escapeHtml(group.name || '')}" aria-label="Group name"></div><button class="btn small" type="submit">Save group</button></div>
    <div class="group-form-section"><b>People who belong to this group</b><p class="profile-note">Use the checkbox to add or remove someone.</p><div class="group-checks">${friendEntries.length ? friendEntries.map(friend => `<div class="group-member-choice"><input type="checkbox" name="memberUid" value="${escapeHtml(friend.uid)}" ${group.memberUids.includes(friend.uid) ? 'checked' : ''} aria-label="${group.memberUids.includes(friend.uid) ? 'Remove' : 'Add'} ${escapeHtml(friend.displayName)} ${group.memberUids.includes(friend.uid) ? 'from' : 'to'} ${escapeHtml(group.name || 'group')}"><span>${escapeHtml(friend.displayName)}</span></div>`).join('') : '<span class="profile-note">Connect friends by code above to add them here.</span>'}</div></div>
    <div class="group-form-section"><b>Evenings shared with this group</b><p class="profile-note">Only people in this group can see the days you mark open here.</p><div class="availability-days">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,index) => `<button type="button" class="availability-day ${group.availability[index] ? 'open' : ''}" data-group-day="${escapeHtml(group.id)}" data-index="${index}" aria-pressed="${Boolean(group.availability[index])}">${day}</button>`).join('')}</div></div>
    <div class="privacy-group-foot"><span class="profile-note">Members: ${group.memberUids.length} · Availability is private to this group.</span><button class="btn small danger" type="button" data-delete-group="${escapeHtml(group.id)}">Delete group</button></div>
  </form>`;
  root.innerHTML = `<div class="card privacy-groups"><div class="eyebrow">Private groups</div><h3 class="profile-heading">Choose who sees your open evenings.</h3><p class="profile-note">Availability is shared only with the groups you choose. Thursday for Family stays private from other groups.</p><form id="groupCreateForm" class="group-create-form"><label>New group name<input class="profile-name" name="groupName" maxlength="50" required placeholder="Family"></label><div class="group-form-section"><b>Add connected friends</b><p class="profile-note">Use the checkbox to choose who to include.</p><div class="group-checks">${friendOptions}</div></div><button class="btn primary small" type="submit">Create group</button></form></div>${myGroups.length ? myGroups.map(renderGroup).join('') : ''}<div class="card shared-availability"><div class="eyebrow">Shared with me</div><h3 class="profile-heading">Friends’ open evenings</h3>${friendAvailability.length ? friendAvailability.map(friend => `<div class="firebase-friend-row"><b>${escapeHtml(friend.displayName)} <small>· ${escapeHtml(friend.groupName)}</small></b><span>${escapeHtml(friend.days.join(', ') || 'No evenings shared')}</span></div>`).join('') : '<p class="profile-note">When friends share availability with one of your groups, it will appear here.</p>'}</div>`;
}

async function saveGroup(form, existingGroup = null) {
  const formData = new FormData(form);
  const name = String(formData.get('groupName') || '').trim().slice(0, 50);
  if (!name) throw new Error('Enter a name for this group.');
  const groupId = existingGroup?.id || crypto.randomUUID();
  const memberUids = [...new Set([currentUser.uid, ...formData.getAll('memberUid').map(String)])];
  const group = {
    id: groupId, name, ownerUid: currentUser.uid, memberUids,
    availability: existingGroup?.availability || Array(7).fill(false),
    ...(existingGroup?.createdAt ? { createdAt: existingGroup.createdAt } : { createdAt: serverTimestamp() }),
    updatedAt: serverTimestamp()
  };
  const availabilityShare = {
    ownerUid: currentUser.uid, groupId, groupName: name,
    displayName: currentProfile?.displayName || currentUser.displayName || currentUser.email || 'Dinner Table member',
    visibleTo: memberUids, availability: group.availability, updatedAt: serverTimestamp()
  };
  const batch = writeBatch(db);
  batch.set(ref('groups', groupId), group);
  batch.set(ref('groupAvailability', `${currentUser.uid}__${groupId}`), availabilityShare);
  for (const share of sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.groupId === groupId)) {
    batch.update(ref('recipeShares', share.id), { groupName: name, visibleTo: memberUids, updatedAt: serverTimestamp() });
  }
  await batch.commit();
  myGroups = [...myGroups.filter(item => item.id !== groupId), { ...group, createdAt: existingGroup?.createdAt || null }];
  let refreshStep = 'party menu access';
  try {
    await syncGroupMenus();
    refreshStep = 'shared meal access';
    await syncGroupMealShares();
  } catch (error) {
    renderPrivacyGroups(); renderEventGroupOptions();
    app?.render?.();
    console.error(`Group saved, but ${refreshStep} could not be refreshed.`, error);
    toast(`Group saved, but ${refreshStep} could not be refreshed. ${friendlyError(error)}`);
    return;
  }
  renderPrivacyGroups(); renderEventGroupOptions();
  app?.render?.();
  toast(existingGroup ? 'Group saved. Its party menu access is updated too.' : 'Group created. Choose its open evenings below.');
}

async function syncGroupMenus(removedUid = null) {
  const snapshot = await getDocs(query(collection(db, 'menus'), where('memberUids', 'array-contains', currentUser.uid)));
  const affected = snapshot.docs.filter(item => item.data().ownerUid === currentUser.uid && Array.isArray(item.data().audienceGroupIds));
  for (const item of affected) {
    const menu = item.data();
    const groupIds = menu.audienceGroupIds.filter(id => myGroups.some(group => group.id === id));
    const selectedGroups = myGroups.filter(group => groupIds.includes(group.id));
    const directInviteUids = (Array.isArray(menu.directInviteUids) ? menu.directInviteUids : [])
      .filter(uid => uid !== removedUid);
    const memberUids = [...new Set([currentUser.uid, ...directInviteUids, ...selectedGroups.flatMap(group => group.memberUids)])];
    await updateDoc(ref('menus', item.id), {
      audienceGroupIds: groupIds,
      audienceGroupNames: selectedGroups.map(group => group.name),
      memberUids,
      updatedAt: serverTimestamp()
    });
  }
}

async function syncGroupMealShares(deletedGroupId = null) {
  const snapshot = await getDocs(query(collection(db, 'groupMeals'), where('visibleTo', 'array-contains', currentUser.uid)));
  for (const item of snapshot.docs) {
    const share = item.data();
    if (share.ownerUid !== currentUser.uid) continue;
    const group = myGroups.find(candidate => candidate.id === share.groupId);
    if (!group || share.groupId === deletedGroupId) {
      await deleteDoc(ref('groupMeals', item.id));
    } else {
      await updateDoc(ref('groupMeals', item.id), {
        groupName: group.name,
        displayName: currentProfile?.displayName || currentUser.displayName || currentUser.email || 'Dinner Table member',
        visibleTo: group.memberUids,
        updatedAt: serverTimestamp()
      });
    }
  }
}

async function saveDayMealSharing(dayCard) {
  const date = dayCard.dataset.date;
  const planKey = dayCard.dataset.planKey;
  const selectedGroupIds = [...dayCard.querySelectorAll('[data-share-group]:checked')].map(input => input.value);
  const meals = (app.state.plans[planKey] || []).map(meal => {
    const recipe = app.state.recipes.find(item => item.id === meal.recipe);
    return recipe ? { meal: meal.meal, name: recipe.name } : null;
  }).filter(Boolean);
  const batch = writeBatch(db);
  const currentShares = sharedMeals.filter(item => item.ownerUid === currentUser.uid && item.date === date);
  const selectedGroups = myGroups.filter(group => selectedGroupIds.includes(group.id));
  if (!selectedGroups.length && !currentShares.length) {
    toast('Choose at least one group to share this day.');
    return;
  }
  for (const group of selectedGroups) {
    const shareId = `${currentUser.uid}__${group.id}__${date}`;
    batch.set(ref('groupMeals', shareId), {
      ownerUid: currentUser.uid,
      groupId: group.id,
      groupName: group.name,
      displayName: currentProfile?.displayName || currentUser.displayName || currentUser.email || 'Dinner Table member',
      visibleTo: group.memberUids,
      date,
      meals,
      updatedAt: serverTimestamp()
    });
  }
  for (const previous of currentShares) {
    if (!selectedGroupIds.includes(previous.groupId)) batch.delete(ref('groupMeals', previous.id));
  }
  await batch.commit();
  toast(selectedGroups.length ? 'Meal sharing updated for this day.' : 'This day is no longer shared.');
}

function decorateDayMealSharing() {
  document.querySelectorAll('#weekGrid .day').forEach(dayCard => {
    if (!dayCard.dataset.date || !dayCard.dataset.planKey) return;
    const date = dayCard.dataset.date;
    dayCard.querySelector('.day-share-tools')?.remove();
    let tools = null;
    if (currentUser) {
      const sharedGroupIds = new Set(sharedMeals
        .filter(item => item.ownerUid === currentUser.uid && item.date === date)
        .map(item => item.groupId));
      const choices = myGroups.length
        ? myGroups.map(group => `<label class="day-share-choice"><input type="checkbox" data-share-group value="${escapeHtml(group.id)}" ${sharedGroupIds.has(group.id) ? 'checked' : ''}> ${escapeHtml(group.name)}</label>`).join('')
        : '<span class="profile-note">Create a group in Settings to share with friends.</span>';
      tools = document.createElement('details');
      tools.className = 'day-share-tools';
      tools.innerHTML = `<summary>Share meal plans</summary><p class="profile-note">Choose who can see what you’re cooking on this day.</p><div class="day-share-choices">${choices}</div><button class="btn small" type="button" data-save-day-share>Save sharing</button>`;
      dayCard.querySelector('.day-head')?.after(tools);
    }
    let incoming = dayCard.querySelector('.shared-day-info');
    if (incoming) incoming.remove();
    const weekdayIndex = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
    const availableFriends = currentUser ? friendAvailability.filter(friend => friend.availability[weekdayIndex]) : [];
    const receivedMeals = currentUser ? sharedMeals.filter(item => item.ownerUid !== currentUser.uid && item.date === date) : [];
    if (availableFriends.length || receivedMeals.length) {
      incoming = document.createElement('div');
      incoming.className = 'shared-day-info';
      incoming.innerHTML = `${availableFriends.length ? `<div class="shared-day-section"><div class="shared-meal-heading">Friends available</div>${availableFriends.map(friend => `<div class="shared-meal-item"><span>${escapeHtml(friend.displayName)} · ${escapeHtml(friend.groupName)}</span></div>`).join('')}</div>` : ''}${receivedMeals.length ? `<div class="shared-day-section"><div class="shared-meal-heading">What friends are cooking</div>${receivedMeals.map(item => `<div class="shared-meal-group"><div class="shared-meal-heading">${escapeHtml(item.displayName || 'Friend')} · ${escapeHtml(item.groupName || 'Shared group')}</div>${(item.meals || []).length ? item.meals.map(meal => `<div class="shared-meal-item"><span>${escapeHtml(meal.meal || 'Meal')}</span>${escapeHtml(meal.name || '')}</div>`).join('') : '<div class="shared-meal-item">No meal planned yet</div>'}</div>`).join('')}</div>` : ''}`;
      if (tools) tools.after(incoming);
      else dayCard.querySelector('.day-head')?.after(incoming);
    }
  });
  document.querySelectorAll('[data-save-day-share]').forEach(button => {
    button.onclick = async () => {
      try { await saveDayMealSharing(button.closest('.day')); }
      catch (error) { toast(friendlyError(error)); }
    };
  });
}

async function handleAuthState(user) {
  const signedOutFromAccount = Boolean(currentUser && !user);
  const switchingAccounts = Boolean(currentUser && user && currentUser.uid !== user.uid);
  if (signedOutFromAccount || switchingAccounts) cachePersonalData();
  if (switchingAccounts) {
    stopMenus?.(); stopMenus = null;
    stopFriends?.(); stopFriends = null;
    stopGroups?.(); stopGroups = null;
    stopSharedAvailability?.(); stopSharedAvailability = null;
    stopSharedMeals?.(); stopSharedMeals = null;
    stopRecipeShares?.(); stopRecipeShares = null;
    friendAvailability = [];
    sharedMeals = [];
    sharedRecipeRecords = [];
    friendEntries = [];
    myGroups = [];
    currentProfile = null;
    app.state.events = (app.state.events || []).filter(event => !event.ownerUid || event.ownerUid === user.uid);
    delete app.state.profile;
    delete app.state.availability;
  }
  stopPersonalData.forEach(stop => stop?.());
  stopPersonalData = [];
  stopScheduleShares?.(); stopScheduleShares = null; sharedScheduleEvents = [];
  clearTimeout(personalSyncTimer);
  personalReady = { recipes: false, plans: false, shopping: false, settings: false };
  personalBaseline = { recipes: new Map(), plans: new Map(), shopping: new Map(), settings: null };
  currentUser = user;
  if (user) {
    activatePersonalAccount(user);
    subscribeToPersonalData();
    try {
      await ensureUserProfile(user);
      await migrateLocalMenus();
      subscribeToMenus();
      subscribeToFriends();
      subscribeToGroups();
      subscribeToSharedAvailability();
      subscribeToSharedMeals();
      subscribeToRecipeShares();
      subscribeToScheduleShares();
      renderAuthPanel();
    } catch (error) {
      renderAuthPanel();
      setAuthMessage(friendlyError(error), true);
    }
  } else {
    stopMenus?.(); stopMenus = null;
    stopFriends?.(); stopFriends = null;
    stopGroups?.(); stopGroups = null;
    stopSharedAvailability?.(); stopSharedAvailability = null;
    stopSharedMeals?.(); stopSharedMeals = null;
    stopRecipeShares?.(); stopRecipeShares = null;
    stopScheduleShares?.(); stopScheduleShares = null; sharedScheduleEvents = [];
    friendAvailability = [];
    sharedMeals = [];
    sharedRecipeRecords = [];
    friendEntries = [];
    myGroups = [];
    currentProfile = null;
    if (signedOutFromAccount) {
      app.state.events = app.state.events.filter(event => !event.ownerUid);
      delete app.state.profile;
      delete app.state.availability;
      app.save();
    }
    renderAuthPanel();
    renderPrivacyGroups(); renderEventGroupOptions();
    renderSharedRecipes();
  }
}

function requireHost(event) {
  if (!currentUser || event.ownerUid !== currentUser.uid) {
    toast('Only the menu host can change that setting.');
    return false;
  }
  return true;
}

async function handleSubmit(event) {
  const form = event.target;
  const formId = form?.id;
  const isGroupForm = formId === 'groupCreateForm' || form.matches('[data-group-form]');
  const isRecipeShareForm = formId === 'recipeShareForm';
  if (!['profileForm', 'friendForm', 'eventForm', 'collabEventForm', 'contributionForm'].includes(formId) && !isGroupForm && !isRecipeShareForm) return;
  if (event.submitter?.value === 'cancel') return;
  if (!currentUser) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  try {
    const formData = new FormData(form);
    if (formId === 'profileForm') {
      app.state.profile.name = String(formData.get('name') || '').trim();
      await saveProfileToCloud();
      app.save();
      toast('Your profile is saved to Firebase.');
    } else if (formId === 'friendForm') {
      await connectFriend(String(formData.get('code') || '').trim().toUpperCase());
      form.reset();
    } else if (isGroupForm) {
      const groupId = form.dataset.groupForm;
      const existingGroup = groupId ? myGroups.find(group => group.id === groupId) : null;
      if (groupId && !existingGroup) throw new Error('That group could not be found. Refresh and try again.');
      await saveGroup(form, existingGroup);
    } else if (isRecipeShareForm) {
      await saveRecipeShares(form);
    } else if (formId === 'eventForm') {
      const id = crypto.randomUUID();
      const selectedGroupIds = formData.getAll('audienceGroup').map(String);
      const selectedGroups = myGroups.filter(group => selectedGroupIds.includes(group.id));
      if (selectedGroups.length !== selectedGroupIds.length) throw new Error('One of the selected groups is no longer available. Please reopen the menu form.');
      const directInviteUids = [...new Set(formData.getAll('directInvite').map(String))];
      if (directInviteUids.some(uid => !friendEntries.some(friend => friend.uid === uid))) throw new Error('A selected friend is no longer connected. Reopen the form and try again.');
      const memberUids = [...new Set([currentUser.uid, ...directInviteUids, ...selectedGroups.flatMap(group => group.memberUids)])];
      const menu = {
        id, name: String(formData.get('name') || '').trim(), date: String(formData.get('date') || ''),
        note: String(formData.get('note') || '').trim(), theme: String(formData.get('theme') || 'classic'), accepting: true, contributions: [], collaborators: [],
        ownerUid: currentUser.uid, memberUids,
        audienceGroupIds: selectedGroups.map(group => group.id),
        audienceGroupNames: selectedGroups.map(group => group.name),
        directInviteUids
      };
      await setDoc(ref('menus', id), { ...menu, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      app.state.events.unshift(menu);
      app.selectedEventId = id;
      app.guestMode = false;
      form.reset(); form.closest('dialog')?.close(); app.save();
      toast('Your shared party menu is ready.');
    } else if (formId === 'collabEventForm') {
      const code = String(formData.get('code') || '').trim().toUpperCase();
      const eventId = app.selectedEventId;
      const menu = app.state.events.find(item => item.id === eventId);
      if (!menu || !requireHost(menu)) return;
      const friendDoc = await getDoc(ref('friendCodes', code));
      if (!friendDoc.exists()) throw new Error('We couldn’t find an account with that friend code. Check the code and try again.');
      const friend = friendDoc.data();
      if (friend.uid === currentUser.uid) throw new Error('That is your own friend code.');
      await updateDoc(ref('menus', eventId), {
        memberUids: arrayUnion(friend.uid),
        directInviteUids: arrayUnion(friend.uid),
        collaborators: arrayUnion(code),
        updatedAt: serverTimestamp()
      });
      menu.memberUids = [...new Set([...(menu.memberUids || []), friend.uid])];
      menu.collaborators = [...new Set([...(menu.collaborators || []), code])];
      form.reset(); app.save();
      toast(`${friend.displayName || 'Your friend'} can now open this menu.`);
    } else if (formId === 'contributionForm') {
      const eventId = String(formData.get('event') || '');
      const menu = app.state.events.find(item => item.id === eventId);
      if (!menu || !(menu.memberUids || []).includes(currentUser.uid)) throw new Error('You don’t have access to this shared menu yet. Ask the host to add your friend code.');
      const isHost = menu.ownerUid === currentUser.uid;
      if (!menu.accepting && !isHost) throw new Error('The host has closed contributions for this menu.');
      const contribution = {
        id: crypto.randomUUID(),
        person: String(formData.get('person') || currentProfile?.displayName || currentUser.email || 'Guest').trim(),
        item: String(formData.get('item') || '').trim(),
        category: String(formData.get('category') || 'Other'),
        note: String(formData.get('note') || '').trim(),
        createdBy: currentUser.uid,
        createdAt: Date.now()
      };
      await updateDoc(ref('menus', eventId), { contributions: arrayUnion(contribution), updatedAt: serverTimestamp() });
      menu.contributions = [...(menu.contributions || []), contribution];
      form.reset(); form.closest('dialog')?.close(); app.guestMode = !isHost; app.save();
      toast(isHost ? 'Food added to your party menu.' : 'Your contribution is on the shared menu.');
    }
  } catch (error) {
    toast(friendlyError(error));
  }
}

async function connectFriend(code) {
  if (!code) throw new Error('Enter a friend code first.');
  if (code === currentProfile.friendCode) throw new Error('That is your own friend code.');
  const friendDoc = await getDoc(ref('friendCodes', code));
  if (!friendDoc.exists()) throw new Error('We couldn’t find an account with that friend code. Check the code and try again.');
  const friend = friendDoc.data();
  if (friend.uid === currentUser.uid) throw new Error('That is your own friend code.');
  const id = pairId(currentUser.uid, friend.uid);
  const friendshipRef = ref('friendships', id);
  const existing = await getDoc(friendshipRef);
  if (existing.exists()) { toast('You’re already connected.'); return; }
  const uids = [currentUser.uid, friend.uid].sort();
  const friendCodesByUid = { [currentUser.uid]: currentProfile.friendCode, [friend.uid]: code };
  await setDoc(friendshipRef, {
    memberUids: uids,
    friendCodesByUid,
    friendCode: code,
    createdBy: currentUser.uid,
    createdAt: serverTimestamp()
  });
  toast(`Connected with ${friend.displayName || code}.`);
}

async function removeFriend(friend) {
  if (!currentUser || !friend?.uid) return;
  const displayName = friend.displayName || 'this friend';
  const confirmed = confirm(`Disconnect ${displayName}? They will be removed from groups and party menus you manage. Groups or menus they manage may still include you until they update them.`);
  if (!confirmed) return;

  const updatedGroups = myGroups.map(group => ({
    ...group,
    memberUids: group.memberUids.filter(uid => uid !== friend.uid)
  }));
  const changedGroups = updatedGroups.filter((group, index) => group.memberUids.length !== myGroups[index].memberUids.length);
  try {
    if (changedGroups.length) {
      const batch = writeBatch(db);
      for (const group of changedGroups) {
        batch.update(ref('groups', group.id), { memberUids: group.memberUids, updatedAt: serverTimestamp() });
        batch.set(ref('groupAvailability', `${currentUser.uid}__${group.id}`), {
          ownerUid: currentUser.uid,
          groupId: group.id,
          groupName: group.name,
          displayName: currentProfile?.displayName || currentUser.displayName || currentUser.email || 'Dinner Table member',
          visibleTo: group.memberUids,
          availability: group.availability,
          updatedAt: serverTimestamp()
        });
        for (const share of sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.groupId === group.id)) {
          batch.update(ref('recipeShares', share.id), { visibleTo: group.memberUids, updatedAt: serverTimestamp() });
        }
      }
      await batch.commit();
    }
    myGroups = updatedGroups;
    await syncGroupMenus(friend.uid);
    await syncGroupMealShares();
    const newlyPrivatePlans = (app.state.dayEvents || []).filter(event => (event.sharedWith || []).includes(friend.uid));
    for (const event of newlyPrivatePlans) event.sharedWith = event.sharedWith.filter(uid => uid !== friend.uid);
    if (newlyPrivatePlans.length) await Promise.all(newlyPrivatePlans.map(saveScheduledEvent));
    await deleteDoc(ref('friendships', pairId(currentUser.uid, friend.uid)));
    friendEntries = friendEntries.filter(item => item.uid !== friend.uid);
    app.state.profile.friends = (app.state.profile.friends || []).filter(code => code !== friend.code);
    friendAvailability = friendAvailability.filter(item => item.code !== friend.uid);
    sharedMeals = sharedMeals.filter(item => item.ownerUid !== friend.uid);
    renderAuthPanel(); renderPrivacyGroups(); renderEventGroupOptions(); app.save();
    toast(`${displayName} was removed from your groups and menus.`);
  } catch (error) {
    console.error('Could not remove this friend and update shared access.', error);
    toast(friendlyError(error));
  }
}

async function handleClick(event) {
  const target = event.target;
  const shareRecipeButton = target.closest('[data-share-recipe]');
  if (shareRecipeButton) {
    event.preventDefault(); event.stopImmediatePropagation();
    const recipe = app?.state?.recipes?.find(item => item.id === shareRecipeButton.dataset.shareRecipe);
    if (recipe) openRecipeShareDialog(recipe);
    return;
  }
  const saveSharedRecipeButton = target.closest('[data-save-shared-recipe]');
  if (saveSharedRecipeButton && currentUser) {
    event.preventDefault(); event.stopImmediatePropagation();
    const recipe = sharedRecipeRecords.find(item => item.id === saveSharedRecipeButton.dataset.saveSharedRecipe);
    if (recipe) saveSharedRecipeCopy(recipe);
    return;
  }
  if (target.closest('#newEvent')) { renderEventGroupOptions(); return; }
  const groupDayButton = target.closest('[data-group-day]');
  if (groupDayButton && currentUser) {
    event.preventDefault(); event.stopImmediatePropagation();
    const group = myGroups.find(item => item.id === groupDayButton.dataset.groupDay);
    const dayIndex = Number(groupDayButton.dataset.index);
    if (group && dayIndex >= 0 && dayIndex < 7) {
      group.availability[dayIndex] = !group.availability[dayIndex];
      groupDayButton.classList.toggle('open', group.availability[dayIndex]);
      groupDayButton.setAttribute('aria-pressed', String(group.availability[dayIndex]));
    }
    return;
  }
  const deleteGroupButton = target.closest('[data-delete-group]');
  if (deleteGroupButton && currentUser) {
    event.preventDefault(); event.stopImmediatePropagation();
    const groupId = deleteGroupButton.dataset.deleteGroup;
    if (!confirm('Delete this group? People will stop seeing its availability, and access to its group-shared party menus will be removed.')) return;
    const oldGroups = myGroups;
    myGroups = myGroups.filter(group => group.id !== groupId);
    let deleteStep = 'party menu access';
    try {
      await syncGroupMenus();
      deleteStep = 'shared meal access';
      await syncGroupMealShares(groupId);
      deleteStep = 'group record';
      const batch = writeBatch(db);
      batch.delete(ref('groupAvailability', `${currentUser.uid}__${groupId}`));
      batch.delete(ref('groups', groupId));
      for (const share of sharedRecipeRecords.filter(item => item.ownerUid === currentUser.uid && item.groupId === groupId)) {
        batch.delete(ref('recipeShares', share.id));
      }
      await batch.commit();
      renderPrivacyGroups(); renderEventGroupOptions();
      app?.render?.();
      toast('Group deleted and its shared menu access updated.');
    } catch (error) {
      myGroups = oldGroups;
      renderPrivacyGroups();
      console.error(`Group deletion stopped while updating ${deleteStep}.`, error);
      toast(`Could not finish updating ${deleteStep}. ${friendlyError(error)}`);
    }
    return;
  }
  const removeFriendButton = target.closest('[data-remove-friend]');
  if (removeFriendButton && currentUser) {
    event.preventDefault(); event.stopImmediatePropagation();
    const friend = friendEntries.find(item => item.uid === removeFriendButton.dataset.removeFriend);
    if (friend) await removeFriend(friend);
    return;
  }
  const cancelButton = target.closest('button[value="cancel"]');
  if (cancelButton?.form?.method === 'dialog') {
    event.preventDefault(); event.stopImmediatePropagation();
    cancelButton.form.closest('dialog')?.close('cancel');
    return;
  }

  const openButton = target.closest('[data-open-event], [data-open-party]');
  if (openButton && currentUser) {
    const id = openButton.dataset.openEvent || openButton.dataset.openParty;
    const menu = app.state.events.find(item => item.id === id);
    app.guestMode = Boolean(menu && menu.ownerUid !== currentUser.uid);
    return;
  }

  const availabilityButton = target.closest('[data-availability]');
  if (availabilityButton && currentUser) {
    event.preventDefault(); event.stopImmediatePropagation();
    const index = Number(availabilityButton.dataset.availability);
    app.state.availability[index] = !app.state.availability[index];
    try { await saveProfileToCloud(); app.save(); }
    catch (error) { toast(friendlyError(error)); }
    return;
  }

  if (target.closest('#toggleAccept')) {
    event.preventDefault(); event.stopImmediatePropagation();
    const menu = app.state.events.find(item => item.id === app.selectedEventId);
    if (!menu || !requireHost(menu)) return;
    menu.accepting = !menu.accepting;
    try { await updateDoc(ref('menus', menu.id), { accepting: menu.accepting, updatedAt: serverTimestamp() }); app.save(); }
    catch (error) { menu.accepting = !menu.accepting; toast(friendlyError(error)); app.save(); }
    return;
  }

  if (target.closest('#deleteEvent')) {
    event.preventDefault(); event.stopImmediatePropagation();
    const menu = app.state.events.find(item => item.id === app.selectedEventId);
    if (!menu || !requireHost(menu) || !confirm('Delete this shared menu for everyone?')) return;
    try { await deleteDoc(ref('menus', menu.id)); app.state.events = app.state.events.filter(item => item.id !== menu.id); app.selectedEventId = null; app.save(); toast('Shared menu deleted.'); }
    catch (error) { toast(friendlyError(error)); }
    return;
  }

  const removeButton = target.closest('[data-remove-contribution]');
  if (removeButton && currentUser) {
    const menu = app.state.events.find(item => item.id === app.selectedEventId);
    if (!menu || menu.ownerUid !== currentUser.uid) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const remaining = (menu.contributions || []).filter(item => item.id !== removeButton.dataset.removeContribution);
    try { await updateDoc(ref('menus', menu.id), { contributions: remaining, updatedAt: serverTimestamp() }); menu.contributions = remaining; app.save(); }
    catch (error) { toast(friendlyError(error)); }
    return;
  }

  if (target.closest('#inviteLater') && currentUser) {
    event.preventDefault(); event.stopImmediatePropagation();
    const menu = app.state.events.find(item => item.id === app.selectedEventId);
    if (!menu || !requireHost(menu)) return;
    const url = new URL(location.href);
    url.searchParams.set('menu', menu.id);
    try { await navigator.clipboard.writeText(url.href); toast('Menu link copied. Only people you add by friend code can open it.'); }
    catch { toast('Add collaborators by friend code, then send them the app link.'); }
  }
}

function decorateRenderedApp() {
  decorateDayMealSharing();
  const connectedFriends = document.querySelector('#collabProfile .friend-pills');
  if (currentUser && connectedFriends) {
    connectedFriends.classList.add('connected-friend-list');
    connectedFriends.innerHTML = friendEntries.length
      ? friendEntries.map(friend => `<div class="connected-friend"><span>${escapeHtml(friend.displayName || 'Dinner Table friend')}</span><button class="btn small danger" type="button" data-remove-friend="${escapeHtml(friend.uid)}">Remove</button></div>`).join('')
      : '<span class="profile-note">No connected friends yet.</span>';
  }
  const oldAvailability = document.querySelector('#collabProfile .collab-profile > div:nth-child(2)');
  if (currentUser && oldAvailability) {
    oldAvailability.innerHTML = '<div class="eyebrow">Dinner availability</div><h3 class="profile-heading">Shared by group only</h3><p class="profile-note">Your open evenings are now managed separately for each group below. People outside a group cannot see its availability.</p>';
  }
  const profileNote = document.querySelector('#collabProfile .profile-note');
  if (currentUser && profileNote) profileNote.textContent = 'Your account and friend code are synced through Firebase. Availability is shared only with selected groups.';
  const localNote = document.querySelector('#eventDetail .local-note');
  if (currentUser && localNote) localNote.innerHTML = '<b>Shared menu:</b> changes appear for everyone added by the host.';
  const inviteButton = document.getElementById('inviteLater');
  if (currentUser && inviteButton) inviteButton.textContent = 'Copy menu link';
  const activeMenu = app?.state?.events?.find(event => event.id === app.selectedEventId);
  if (currentUser && activeMenu && activeMenu.ownerUid !== currentUser.uid) {
    document.querySelector('.guest-toggle')?.remove();
    app.guestMode = true;
  }
  const personInput = document.querySelector('#contributionForm input[name="person"]');
  if (currentUser && personInput && !personInput.value) personInput.value = currentProfile?.displayName || currentUser.email?.split('@')[0] || '';
  const collabNote = document.querySelector('#eventDetail .host-panel > p:last-child');
  if (currentUser && collabNote) collabNote.textContent = 'Add friends by code. They can sign in and open this menu from their Party menus tab.';
  if (currentUser) {
    const formInput = document.querySelector('#collabEventForm input[name="code"]');
    if (formInput) formInput.placeholder = 'Friend code (DT-...)';
  }
  renderPrivacyGroups();
}

function startFirebaseBridge() {
  app = window.DinnerTableApp;
  const panel = document.getElementById('firebaseAuthPanel');
  if (!app || !panel) return;
  wrapAppSaveWithPersonalSync();
  window.addEventListener('online', schedulePersonalSync);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('click', handleClick, true);
  window.DinnerTableFirebase = {
    afterRender: decorateRenderedApp,
    afterSave: () => {
      cachePersonalData();
      if (!applyingPersonalSnapshot) schedulePersonalSync();
    },
    saveRecipe: saveRecipeToCloud,
    saveScheduledEvent,
    deleteScheduledEvent,
    updateSharedRecipeSnapshot,
    deleteRecipeShares,
    preparePartySharing,
    get displayName() { return currentProfile?.displayName || currentProfile?.name || currentUser?.displayName || currentUser?.email?.split('@')[0] || ''; },
    get friends() { return friendEntries.map(friend => ({ uid: friend.uid, displayName: friend.displayName || 'Dinner Table friend' })); },
    get sharedScheduleEvents() { return sharedScheduleEvents; },
    get sharedMeals() { return sharedMeals; },
    get uid() { return currentUser?.uid || ''; },
    get signedIn() { return Boolean(currentUser); }
  };
  onAuthStateChanged(auth, user => handleAuthState(user).catch(error => {
    renderAuthPanel(); setAuthMessage(friendlyError(error), true);
  }));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startFirebaseBridge, { once: true });
else startFirebaseBridge();
