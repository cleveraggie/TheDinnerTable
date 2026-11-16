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
  getDoc,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  deleteDoc
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
const toast = message => app?.toast?.(message);

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
    <p class="firebase-friend-note">Your friend code and availability are saved to Firebase. Share your code with people you want to connect with.</p>
    <div id="firebaseFriendAvailability" class="firebase-friend-availability">${renderFriendAvailability()}</div>
    <p id="firebaseAuthMessage" class="firebase-auth-message" aria-live="polite"></p>
  </div>`;
  panel.querySelector('#firebaseSignOut').addEventListener('click', async () => {
    try { await signOut(auth); }
    catch (error) { setAuthMessage(friendlyError(error), true); }
  });
}

function renderFriendAvailability() {
  if (!friendAvailability.length) return '<div class="profile-note">Connect by friend code to see your friends’ open evenings here.</div>';
  return friendAvailability.map(friend => `<div class="firebase-friend-row"><b>${escapeHtml(friend.displayName || friend.code)}</b><span>${escapeHtml(friend.days.join(', ') || 'No evenings shared')}</span></div>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function saveProfileToCloud() {
  if (!currentUser || !currentProfile) return;
  const state = app.state;
  const displayName = String(state.profile?.name || currentProfile.displayName || '').trim().slice(0, 60);
  const availability = Array.from({ length: 7 }, (_, index) => Boolean(state.availability?.[index]));
  const updated = { ...currentProfile, displayName, availability };
  await setDoc(ref('users', currentUser.uid), { ...updated, updatedAt: serverTimestamp() }, { merge: true });
  await setDoc(ref('friendCodes', currentProfile.friendCode), {
    uid: currentUser.uid, displayName, availability, updatedAt: serverTimestamp()
  }, { merge: true });
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
    availability: Array.isArray(profile.availability) ? profile.availability : [true, true, true, true, true, true, true],
    updatedAt: serverTimestamp()
  }, { merge: true });
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
  }, error => toast(friendlyError(error)));
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
    friendAvailability = await Promise.all(codes.map(async code => {
      const friendDoc = await getDoc(ref('friendCodes', code));
      if (!friendDoc.exists()) return { code, displayName: code, days: [] };
      const data = friendDoc.data();
      const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      return { code, displayName: data.displayName || code, days: weekdays.filter((_, index) => data.availability?.[index]) };
    }));
    renderAuthPanel();
    app.save();
  }, error => toast(friendlyError(error)));
}

async function handleAuthState(user) {
  const signedOutFromAccount = Boolean(currentUser && !user);
  currentUser = user;
  if (user) {
    try {
      await ensureUserProfile(user);
      await migrateLocalMenus();
      subscribeToMenus();
      subscribeToFriends();
      renderAuthPanel();
    } catch (error) {
      renderAuthPanel();
      setAuthMessage(friendlyError(error), true);
    }
  } else {
    stopMenus?.(); stopMenus = null;
    stopFriends?.(); stopFriends = null;
    friendAvailability = [];
    currentProfile = null;
    if (signedOutFromAccount) {
      app.state.events = app.state.events.filter(event => !event.ownerUid);
      delete app.state.profile;
      delete app.state.availability;
      app.save();
    }
    renderAuthPanel();
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
  if (!['profileForm', 'friendForm', 'eventForm', 'collabEventForm', 'contributionForm'].includes(formId)) return;
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
    } else if (formId === 'eventForm') {
      const id = crypto.randomUUID();
      const menu = {
        id, name: String(formData.get('name') || '').trim(), date: String(formData.get('date') || ''),
        note: String(formData.get('note') || '').trim(), accepting: true, contributions: [], collaborators: [],
        ownerUid: currentUser.uid, memberUids: [currentUser.uid]
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
      if (!menu.accepting) throw new Error('The host has closed contributions for this menu.');
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
      form.reset(); form.closest('dialog')?.close(); app.guestMode = true; app.save();
      toast('Your contribution is on the shared menu.');
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

async function handleClick(event) {
  const target = event.target;
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
  const profileNote = document.querySelector('#collabProfile .profile-note');
  if (currentUser && profileNote) profileNote.textContent = 'Your account, friend code, and dinner availability are synced through Firebase.';
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
}

function startFirebaseBridge() {
  app = window.DinnerTableApp;
  const panel = document.getElementById('firebaseAuthPanel');
  if (!app || !panel) return;
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('click', handleClick, true);
  window.DinnerTableFirebase = { afterRender: decorateRenderedApp };
  onAuthStateChanged(auth, user => handleAuthState(user).catch(error => {
    renderAuthPanel(); setAuthMessage(friendlyError(error), true);
  }));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startFirebaseBridge, { once: true });
else startFirebaseBridge();
