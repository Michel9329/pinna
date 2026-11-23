<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, type User, type ProjectCard } from '../api';

const router = useRouter();
const user = ref<User | null>(null);
const projects = ref<ProjectCard[]>([]);
const loading = ref(true);
const loadError = ref('');

const showNew = ref(false);
const newName = ref('');
const newUrl = ref('');
const creating = ref(false);
const createError = ref('');

const isAdmin = computed(() => user.value?.role === 'admin');
// A collaborator is admin ONLY on the sites where their membership has the
// collab role (p.can_admin from the server): there they can invite clients.
// The "Add collaborator" button stays reserved for the global admin (isAdmin).

onMounted(load);

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    user.value = await api.me();
    projects.value = await api.projects();
  } catch (e) {
    loadError.value = (e as Error).message || 'Could not load your sites. Please try again in a moment.';
  } finally {
    loading.value = false;
  }
}

async function create() {
  const name = newName.value.trim();
  if (!name) {
    createError.value = 'The site name is required.';
    return;
  }
  creating.value = true;
  createError.value = '';
  try {
    const p = await api.createProject(name, newUrl.value.trim());
    // Defensive: if the worker does not return counts (stale deploy / partial response)
    // the template would crash on p.counts.open and show a blank screen. Hydrate here.
    projects.value = [{ ...p, counts: p.counts ?? { open: 0, done: 0 } }, ...projects.value];
    newName.value = '';
    newUrl.value = '';
    showNew.value = false;
  } catch (e) {
    createError.value = (e as Error).message || 'Could not create the site. Please try again.';
  } finally {
    creating.value = false;
  }
}

async function logout() {
  // Server-side logout clears the cookies. If the call fails (network down)
  // the cookie stays alive: the ?logout=1 flag tells LoginView NOT to sign back in
  // automatically, so "Sign out" always leaves the user on the sign-in screen.
  await api.logout().catch(() => {});
  router.replace({ name: 'login', query: { logout: '1' } });
}

function openProject(p: ProjectCard) {
  router.push({ name: 'project', params: { slug: p.slug } });
}

// Invite: adds an email to a project as a client (reviewer) or as a
// collaborator (site admin). Collaborator invites are global-admin only.
const inviteFor = ref<string | null>(null);
const inviteEmail = ref('');
const inviteRole = ref<'client' | 'collab'>('client');
const inviting = ref(false);
const inviteMsg = ref<Record<string, string>>({});

function openInvite(projectId: string, role: 'client' | 'collab' = 'client') {
  inviteFor.value = projectId;
  inviteEmail.value = '';
  inviteRole.value = role;
}

async function sendInvite(p: ProjectCard) {
  const email = inviteEmail.value.trim();
  if (!email) return;
  inviting.value = true;
  try {
    await api.invite(p.id, email, inviteRole.value);
    const what = inviteRole.value === 'collab' ? 'Collaborator added:' : 'Invited';
    inviteMsg.value = {
      ...inviteMsg.value,
      [p.id]: what + ' ' + email + '. Tell them to sign in at ' + window.location.host + ' with this email.',
    };
    inviteFor.value = null;
  } catch (e) {
    inviteMsg.value = {
      ...inviteMsg.value,
      [p.id]: (e as Error).message || 'Invite failed.',
    };
  } finally {
    inviting.value = false;
  }
}
</script>

<template>
  <div>
    <header class="topbar">
      <div class="brand">
        <span class="wordmark" role="img" aria-label="Pinna"></span>
      </div>
      <div class="account">
        <span v-if="user" class="email">{{ user.email }}</span>
        <button class="ghost" type="button" @click="logout">Sign out</button>
      </div>
    </header>

    <main class="main">
      <div class="head">
        <div>
          <h1>Your sites</h1>
          <p class="lead">The sites we are working on together. Open one to see the comments so far.</p>
        </div>
        <button v-if="isAdmin" class="primary" type="button" @click="showNew = !showNew">
          {{ showNew ? 'Close' : 'Add a site' }}
        </button>
      </div>

      <form v-if="showNew && isAdmin" class="newform" @submit.prevent="create">
        <div class="field">
          <label for="np-name">Name</label>
          <input id="np-name" v-model="newName" placeholder="e.g. Acme Studio" />
        </div>
        <div class="field">
          <label for="np-url">Site URL</label>
          <input id="np-url" v-model="newUrl" placeholder="https://..." />
        </div>
        <button class="primary" type="submit" :disabled="creating">
          {{ creating ? 'Creating...' : 'Create site' }}
        </button>
        <p v-if="createError" class="err" role="alert">{{ createError }}</p>
      </form>

      <p v-if="loading" class="state" role="status">Loading your sites...</p>
      <p v-else-if="loadError" class="state err" role="alert">{{ loadError }}</p>

      <div v-else-if="projects.length" class="grid">
        <div v-for="p in projects" :key="p.id" class="proj">
          <button class="proj-main" type="button" @click="openProject(p)">
            <div class="proj-name">{{ p.name }}</div>
            <div class="proj-url">{{ p.staging_url || 'No site URL set yet' }}</div>
            <div class="counts">
              <span class="count open">{{ p.counts?.open ?? 0 }} open</span>
              <span class="count done">{{ p.counts?.done ?? 0 }} done</span>
            </div>
          </button>
          <div v-if="isAdmin || p.can_admin" class="proj-invite">
            <form v-if="inviteFor === p.id" class="invite-form" @submit.prevent="sendInvite(p)">
              <input
                v-model="inviteEmail" type="email" required
                :placeholder="inviteRole === 'collab' ? 'collaborator email' : 'client email'"
              />
              <button type="submit" :disabled="inviting">{{ inviting ? '...' : 'Add' }}</button>
            </form>
            <div v-else class="invite-actions">
              <button class="invite-toggle" type="button" @click="openInvite(p.id, 'client')">
                + Invite a client
              </button>
              <button v-if="isAdmin" class="invite-toggle" type="button" @click="openInvite(p.id, 'collab')">
                + Add collaborator (site admin)
              </button>
            </div>
            <p v-if="inviteMsg[p.id]" class="invite-msg">{{ inviteMsg[p.id] }}</p>
          </div>
        </div>
      </div>

      <div v-else-if="isAdmin && !showNew" class="empty">
        <p class="empty-title">Nothing here yet</p>
        <p class="empty-text">Add your first site and Pinna starts tracking its feedback.</p>
        <button class="primary" type="button" @click="showNew = true">Add a site</button>
      </div>

      <div v-else-if="!isAdmin" class="empty">
        <p class="empty-title">Almost there</p>
        <p class="empty-text">
          When a site is shared with you, it shows up here.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  height: 62px; padding: 0 26px;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; }
.wordmark {
  width: 95px;
  height: 28px;
  background: var(--grad);
  -webkit-mask: url(/pinna-wordmark.svg) center / contain no-repeat;
  mask: url(/pinna-wordmark.svg) center / contain no-repeat;
}
.account { display: flex; align-items: center; gap: 14px; }
.email { font-size: 13px; color: var(--text-3); }
.ghost {
  height: 34px; padding: 0 13px; border-radius: 8px;
  border: 1px solid var(--line-2); background: var(--surface);
  color: var(--text-2); font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.ghost:hover { background: var(--bg-2); color: var(--text); }

.main { max-width: 1080px; margin: 0 auto; padding: 38px 26px 64px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
h1 { font-size: 27px; font-weight: 700; letter-spacing: -0.02em; }
.lead { margin-top: 5px; color: var(--text-3); font-size: 14px; max-width: 56ch; }

.primary {
  height: 40px; padding: 0 18px; border: 0; border-radius: 10px;
  background: var(--grad); color: #fff; font-size: 14px; font-weight: 600;
  cursor: pointer; white-space: nowrap; flex-shrink: 0;
  box-shadow: 0 4px 14px -3px rgba(0, 102, 204, 0.45);
  transition: transform .12s var(--ease), box-shadow .14s ease;
}
.primary:hover { box-shadow: 0 6px 18px -3px rgba(0, 102, 204, 0.55); }
.primary:active { transform: scale(0.98); }
.primary:disabled { opacity: 0.6; cursor: default; }

.newform {
  margin-top: 22px; padding: 20px;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius);
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px;
}
.field { display: flex; flex-direction: column; flex: 1; min-width: 220px; }
.field label { font-size: 12px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.field input {
  height: 42px; padding: 0 12px; border-radius: 9px;
  border: 1px solid var(--line-2); background: var(--bg-3);
  font-size: 14px; color: var(--text);
  transition: border-color .14s ease, box-shadow .14s ease;
}
.field input:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.13);
}
.err { color: var(--danger); font-size: 12.5px; }
.newform .err { width: 100%; }

.state { margin-top: 30px; color: var(--text-3); font-size: 14px; }

.grid {
  margin-top: 26px;
  display: grid; gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(264px, 1fr));
}
.proj {
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: transform .14s var(--ease), box-shadow .16s ease, border-color .14s ease;
}
.proj:hover {
  transform: translateY(-2px); border-color: var(--line-2);
  box-shadow: 0 14px 30px -16px rgba(15, 23, 42, 0.28);
}
.proj-main {
  text-align: left; cursor: pointer; font: inherit; color: inherit;
  background: transparent; border: 0;
  padding: 18px 18px 16px; border-radius: var(--radius);
}
.proj-main:focus-visible {
  outline: none; box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.2);
}
.proj-invite { padding: 0 18px 15px; }
.invite-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.invite-toggle {
  border: 0; background: transparent; cursor: pointer; padding: 3px 0;
  color: var(--accent); font-size: 12.5px; font-weight: 600;
}
.invite-toggle:hover { text-decoration: underline; }
.invite-form { display: flex; gap: 6px; }
.invite-form input {
  flex: 1; min-width: 0; height: 34px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--line-2); background: var(--bg-3);
  font-size: 13px; color: var(--text);
}
.invite-form input:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.13);
}
.invite-form button {
  flex: none; height: 34px; padding: 0 14px; border: 0; border-radius: 8px;
  background: var(--grad); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
}
.invite-form button:disabled { opacity: 0.6; cursor: default; }
.invite-msg { margin-top: 8px; font-size: 12px; color: var(--text-3); line-height: 1.45; }
.proj-name { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.proj-url {
  margin-top: 4px; font-size: 12.5px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.counts { margin-top: 16px; display: flex; gap: 8px; }
.count {
  font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
}
.count.open { background: var(--tint); color: var(--accent); }
.count.done { background: var(--tint-green); color: var(--success); }

.empty {
  margin-top: 60px; text-align: center;
}
.empty-title { font-size: 17px; font-weight: 650; }
.empty-text {
  margin-top: 6px; margin-bottom: 18px; color: var(--text-3);
  font-size: 14px; max-width: 44ch; margin-left: auto; margin-right: auto;
  line-height: 1.55;
}

@media (max-width: 560px) {
  .head { flex-direction: column; }
}
</style>
