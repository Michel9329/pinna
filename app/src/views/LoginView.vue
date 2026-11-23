<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();
const route = useRoute();
const email = ref('');
const status = ref<'idle' | 'sending' | 'sent' | 'verifying' | 'error'>('idle');
const devLink = ref('');
const devCode = ref('');
const code = ref('');
const errorMsg = ref('');
const otpError = ref('');

// 'sent' and 'verifying' both show the screen with the code field.
const sent = computed(() => status.value === 'sent' || status.value === 'verifying');

async function submit() {
  const value = email.value.trim();
  // Client-side format validation (instant feedback). The server remains
  // the authority (code + link + neutral anti-enumeration response).
  if (!value || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    status.value = 'error';
    errorMsg.value = 'Check your email address, something looks off.';
    return;
  }
  status.value = 'sending';
  try {
    const res = await api.requestLogin(value);
    devLink.value = res.devLink || '';
    devCode.value = res.devCode || '';
    status.value = 'sent';
  } catch (e) {
    status.value = 'error';
    errorMsg.value = (e as Error).message || 'Something went wrong. Please try again in a moment.';
  }
}

async function submitCode() {
  const digits = code.value.replace(/\D/g, '');
  if (digits.length !== 6) {
    otpError.value = 'The code has 6 digits.';
    return;
  }
  otpError.value = '';
  status.value = 'verifying';
  try {
    await api.verifyCode(email.value.trim(), digits);
    // The session cookies are set by the response (Set-Cookie): go in.
    router.replace({ name: 'dashboard' });
  } catch (e) {
    status.value = 'sent';
    otpError.value = (e as Error).message || 'Invalid code. Check your email and try again.';
  }
}

// If already signed in, go straight to the dashboard. Exception: after an
// explicit logout (?logout=1) do NOT sign back in automatically (avoids bouncing
// back in when a failed server logout leaves the cookie alive).
if (!route.query.logout) {
  api.me().then(() => router.replace({ name: 'dashboard' })).catch(() => {});
}
</script>

<template>
  <div class="login">
    <aside class="brand">
      <div class="brand-head">
        <img class="wordmark" src="/pinna-wordmark.svg" alt="Pinna" />
      </div>
      <div class="brand-mid">
        <h1>Feedback on the&nbsp;site,<br />pinned to the exact&nbsp;spot.</h1>
        <p>
          Open the site, click where something is off and write your comment.
          No vague descriptions to decode: your comment stays pinned
          to the exact spot you want changed.
        </p>
      </div>
    </aside>

    <main class="panel">
      <div class="box">
        <div class="eyebrow">Welcome back</div>
        <h2>Sign in</h2>
        <p class="lead">No password to remember. We email you a 6-digit code: enter it here and you are in.</p>

        <form v-if="!sent" class="form" @submit.prevent="submit">
          <label for="email">Your email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            autocomplete="email"
            placeholder="name@example.com"
            :disabled="status === 'sending'"
          />
          <p v-if="status === 'error'" class="err" role="alert">{{ errorMsg }}</p>
          <button type="submit" class="btn" :disabled="status === 'sending'">
            {{ status === 'sending' ? 'Sending...' : 'Email me a code' }}
          </button>
        </form>

        <div v-else class="sent">
          <div class="sent-badge">{{ devCode ? 'Dev mode' : 'Check your inbox' }}</div>
          <p class="sent-text">
            <template v-if="devCode">Dev mode: no email is sent. Code: <b>{{ devCode }}</b>.</template>
            <template v-else>If <b>{{ email }}</b> is registered, you will get an email with a <b>6-digit code</b>. Enter it below (check your spam folder too). It is valid for 90 minutes.</template>
          </p>

          <form class="otp-form" @submit.prevent="submitCode">
            <label for="code">Sign-in code</label>
            <input
              id="code"
              v-model="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="000000"
              :disabled="status === 'verifying'"
            />
            <p v-if="otpError" class="err" role="alert">{{ otpError }}</p>
            <button type="submit" class="btn" :disabled="status === 'verifying'">
              {{ status === 'verifying' ? 'Verifying...' : 'Sign in' }}
            </button>
          </form>

          <p class="alt-note">
            The email also contains a link, which works too. If you sign in often,
            the code is quicker; bookmark Pinna for next time.
            <a v-if="devLink" class="alt-link" :href="devLink">Sign in with the link (dev)</a>
          </p>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.login {
  min-height: 100vh;
  display: flex;
}

/* --- Brand panel --- */
.brand {
  position: relative;
  overflow: hidden;
  flex: 1 1 46%;
  padding: 44px 48px;
  display: flex;
  flex-direction: column;
  color: #fff;
  /* Contrast: the light stop is #0a6fd0 (5.0:1 with the white body text of the
     .brand-mid p subtitle), so the whole gradient is >=5:1 for white text. A
     lighter #1287e6 would give 3.7:1. The h1 (large text) passes either way. */
  background: linear-gradient(158deg, #0a4fae 0%, #0066cc 52%, #0a6fd0 100%);
}
.brand-head,
.brand-mid { position: relative; z-index: 2; }
.brand-head { display: flex; align-items: center; }
.wordmark { height: 50px; width: auto; }
.brand-mid { margin-top: auto; margin-bottom: auto; max-width: 560px; }
.brand-mid h1 {
  font-size: 42px;
  line-height: 1.14;
  font-weight: 700;
  letter-spacing: -0.03em;
  text-wrap: balance;
}
.brand-mid p {
  margin-top: 18px;
  font-size: 16px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.82);
  max-width: 42ch;
}

/* --- Form panel --- */
.panel {
  position: relative;
  z-index: 2;
  overflow: hidden;
  flex: 1 1 54%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: var(--surface);
}

.box {
  position: relative;
  z-index: 2;
  width: 100%;
  max-width: 372px;
  animation: rise 0.5s cubic-bezier(0.23, 1, 0.32, 1) both;
}
@keyframes rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: translateY(0); }
}
.eyebrow {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent);
}
h2 {
  margin-top: 10px;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.025em;
}
.lead {
  margin-top: 8px;
  color: var(--text-3);
  font-size: 14.5px;
  line-height: 1.55;
}
.form { margin-top: 30px; display: flex; flex-direction: column; }
label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 8px;
}
input {
  height: 48px;
  padding: 0 14px;
  border-radius: 11px;
  border: 1px solid var(--line-2);
  background: var(--bg-3);
  font-size: 15px;
  color: var(--text);
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(0, 102, 204, 0.13);
}
.err { margin-top: 9px; color: var(--danger); font-size: 12.5px; }
.btn {
  margin-top: 18px;
  height: 48px;
  border: 0;
  border-radius: 11px;
  /* AA-safe blue shimmer: every stop is >=5:1 with white text (a #00aaff
     middle stop would give 2.6:1, below AA). */
  background: linear-gradient(90deg, #005bb8, #0a6fd0, #005bb8);
  background-size: 200% 100%;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  box-shadow: 0 6px 18px -5px rgba(0, 102, 204, 0.5);
  animation: btn-flow 16s ease-in-out infinite alternate;
  transition: transform 0.12s cubic-bezier(0.23, 1, 0.32, 1), box-shadow 0.14s ease;
}
@keyframes btn-flow {
  from { background-position: 0% 50%; }
  to { background-position: 100% 50%; }
}
.btn:hover { box-shadow: 0 10px 26px -5px rgba(0, 102, 204, 0.62); }
.btn:active { transform: scale(0.985); }
.btn:disabled { opacity: 0.6; cursor: default; }
.sent { margin-top: 30px; }
.sent-badge {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--tint);
  color: var(--accent);
  font-size: 12.5px;
  font-weight: 600;
}
.sent-text {
  margin-top: 13px;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.6;
}
.sent-text b { color: var(--text); }
.sent .btn { margin-top: 20px; }

/* 6-digit code field, centered monospace. */
.otp-form { margin-top: 22px; display: flex; flex-direction: column; }
.otp-form input {
  height: 54px;
  padding: 0 14px;
  border-radius: 11px;
  border: 1px solid var(--line-2);
  background: var(--bg-3);
  color: var(--text);
  font-family: 'SF Mono', ui-monospace, Menlo, Consolas, monospace;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-align: center;
  transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.otp-form input::placeholder { letter-spacing: 0.3em; color: var(--text-3); font-weight: 600; }
.otp-form input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 4px rgba(0, 102, 204, 0.13);
}
.alt-note {
  margin-top: 20px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-3);
}
.alt-link { color: var(--accent); text-decoration: none; font-weight: 600; white-space: nowrap; }

@media (max-width: 880px) {
  .login { flex-direction: column; }
  .brand { flex: none; padding: 32px 28px 56px; }
  .brand-mid { margin: 26px 0 0; }
  .brand-mid h1 { font-size: 30px; }
  .panel { flex: none; padding: 36px 28px 56px; background: var(--surface); }
}
</style>
