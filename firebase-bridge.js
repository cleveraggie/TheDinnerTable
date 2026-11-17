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
    <p class="firebase-friend-note">Your friend code is saved to Firebase. Availability is shared only with the groups you choose below.</p>
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

function renderEventGroupOptions() {
  const options = document.getElementById('eventGroupOptions');
  if (!options) return;
  if (!currentUser) {
    options.innerHTML = '<span class="profile-note">Sign in to share menus with groups.</span>';
    return;
  }
  options.innerHTML = myGroups.length
    ? myGroups.map(group => `<label class="group-check"><input type="checkbox" name="audienceGroup" value="${escapeHtml(group.id)}"><span>${escapeHtml(group.name)}</span></label>`).join('')
    : '<span class="profile-note">Create a group in Settings first. You can also invite people to a private menu later.</span>';
}

function renderPrivacyGroups() {
  const root = document.getElementById('privacyGroups');
  if (!root) return;
  if (!currentUser) {
    root.innerHTML = '<div class="card privacy-groups"><div class="eyebrow">Private groups</div><h3 class="profile-heading">Share availability with the right people.</h3><p class="profile-note">Sign in to create groups and choose which evenings each group can see.</p></div>';
    return;
  }
  const friendOptions = friendEntries.length
    ? friendEntries.map(friend => `<label class="group-check"><input type="checkbox" name="memberUid" value="${escapeHtml(friend.uid)}"><span>${escapeHtml(friend.displayName)} <small>${escapeHtml(friend.code)}</small></span></label>`).join('')
    : '<p class="profile-note">Connect with friends by code above, then you can add them to a group.</p>';
  const renderGroup = group => `<form class="card privacy-group" data-group-form="${escapeHtml(group.id)}">
    <div class="privacy-group-head"><div><div class="eyebrow">Group</div><input class="profile-name" name="groupName" maxlength="50" required value="${escapeHtml(group.name || '')}" aria-label="Group name"></div><button class="btn small" type="submit">Save group</button></div>
    <div class="group-form-section"><b>People who belong to this group</b><div class="group-checks">${friendEntries.length ? friendEntries.map(friend => `<label class="group-check"><input type="checkbox" name="memberUid" value="${escapeHtml(friend.uid)}" ${group.memberUids.includes(friend.uid) ? 'checked' : ''}><span>${escapeHtml(friend.displayName)} <small>${escapeHtml(friend.code)}</small></span></label>`).join('') : '<span class="profile-note">Connect friends by code above to add them here.</span>'}</div></div>
    <div class="group-form-section"><b>Evenings shared with this group</b><p class="profile-note">Only people in this group can see the days you mark open here.</p><div class="availability-days">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((day,index) => `<button type="button" class="availability-day ${group.availability[index] ? 'open' : ''}" data-group-day="${escapeHtml(group.id)}" data-index="${index}" aria-pressed="${Boolean(group.availability[index])}">${day}</button>`).join('')}</div></div>
    <div class="privacy-group-foot"><span class="profile-note">Members: ${group.memberUids.length} · Availability is private to this group.</span><button class="btn small danger" type="button" data-delete-group="${escapeHtml(group.id)}">Delete group</button></div>
  </form>`;
  root.innerHTML = `<div class="card privacy-groups"><div class="eyebrow">Private groups</div><h3 class="profile-heading">Choose who sees your open evenings.</h3><p class="profile-note">Availability is shared only with the groups you choose. Thursday for Family stays private from other groups.</p><form id="groupCreateForm" class="group-create-form"><label>New group name<input class="profile-name" name="groupName" maxlength="50" required placeholder="Family"></label><div class="group-form-section"><b>Add connected friends</b><div class="group-checks">${friendOptions}</div></div><button class="btn primary small" type="submit">Create group</button></form></div>${myGroups.length ? myGroups.map(renderGroup).join('') : ''}<div class="card shared-availability"><div class="eyebrow">Shared with me</div><h3 class="profile-heading">Friends’ open evenings</h3>${friendAvailability.length ? friendAvailability.map(friend => `<div class="firebase-friend-row"><b>${escapeHtml(friend.displayName)} <small>· ${escapeHtml(friend.groupName)}</small></b><span>${escapeHtml(friend.days.join(', ') || 'No evenings shared')}</span></div>`).join('') : '<p class="profile-note">When friends share availability with one of your groups, it will appear here.</p>'}</div>`;
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
  await batch.commit();
  myGroups = [...myGroups.filter(item => item.id !== groupId), { ...group, createdAt: existingGroup?.createdAt || null }];
  try {
    await syncGroupMenus();
    await syncGroupMealShares();
  } catch (error) {
    renderPrivacyGroups(); renderEventGroupOptions();
    app?.render?.();
    toast(`Group saved, but shared access could not be refreshed. ${friendlyError(error)}`);
    return;
  }
  renderPrivacyGroups(); renderEventGroupOptions();
  app?.render?.();
  toast(existingGroup ? 'Group saved. Its party menu access is updated too.' : 'Group created. Choose its open evenings below.');
}

async function syncGroupMenus() {
  const snapshot = await getDocs(query(collection(db, 'menus'), where('memberUids', 'array-contains', currentUser.uid)));
  const affected = snapshot.docs.filter(item => item.data().ownerUid === currentUser.uid && Array.isArray(item.data().audienceGroupIds));
  for (const item of affected) {
    const menu = item.data();
    const groupIds = menu.audienceGroupIds.filter(id => myGroups.some(group => group.id === id));
    const selectedGroups = myGroups.filter(group => groupIds.includes(group.id));
    const directInviteUids = Array.isArray(menu.directInviteUids) ? menu.directInviteUids : [];
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
  currentUser = user;
  if (user) {
    try {
      await ensureUserProfile(user);
      await migrateLocalMenus();
      subscribeToMenus();
      subscribeToFriends();
      subscribeToGroups();
      subscribeToSharedAvailability();
      subscribeToSharedMeals();
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
    friendAvailability = [];
    sharedMeals = [];
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
  if (!['profileForm', 'friendForm', 'eventForm', 'collabEventForm', 'contributionForm'].includes(formId) && !isGroupForm) return;
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
    } else if (formId === 'eventForm') {
      const id = crypto.randomUUID();
      const selectedGroupIds = formData.getAll('audienceGroup').map(String);
      const selectedGroups = myGroups.filter(group => selectedGroupIds.includes(group.id));
      if (selectedGroups.length !== selectedGroupIds.length) throw new Error('One of the selected groups is no longer available. Please reopen the menu form.');
      const memberUids = [...new Set([currentUser.uid, ...selectedGroups.flatMap(group => group.memberUids)])];
      const menu = {
        id, name: String(formData.get('name') || '').trim(), date: String(formData.get('date') || ''),
        note: String(formData.get('note') || '').trim(), accepting: true, contributions: [], collaborators: [],
        ownerUid: currentUser.uid, memberUids,
        audienceGroupIds: selectedGroups.map(group => group.id),
        audienceGroupNames: selectedGroups.map(group => group.name),
        directInviteUids: []
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
    try {
      await syncGroupMenus();
      await syncGroupMealShares(groupId);
      const batch = writeBatch(db);
      batch.delete(ref('groupAvailability', `${currentUser.uid}__${groupId}`));
      batch.delete(ref('groups', groupId));
      await batch.commit();
      renderPrivacyGroups(); renderEventGroupOptions();
      app?.render?.();
      toast('Group deleted and its shared menu access updated.');
    } catch (error) {
      myGroups = oldGroups;
      renderPrivacyGroups();
      toast(friendlyError(error));
    }
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
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('click', handleClick, true);
  window.DinnerTableFirebase = { afterRender: decorateRenderedApp };
  onAuthStateChanged(auth, user => handleAuthState(user).catch(error => {
    renderAuthPanel(); setAuthMessage(friendlyError(error), true);
  }));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startFirebaseBridge, { once: true });
else startFirebaseBridge();
