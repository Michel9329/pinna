import { createRouter, createWebHistory } from 'vue-router';
import { api } from './api';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import ProjectView from './views/ProjectView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'dashboard', component: DashboardView },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/p/:slug', name: 'project', component: ProjectView, props: true },
  ],
});

// Guard: a valid session is required everywhere except /login.
// Also, a client does not see the dashboard: after login they go straight to
// their site. The dashboard (site list) is for admins and collaborators.
router.beforeEach(async (to) => {
  if (to.name === 'login') return true;
  let user;
  try {
    user = await api.me();
  } catch {
    return { name: 'login' };
  }
  if (to.name === 'dashboard' && user.role === 'client') {
    const projects = await api.projects().catch(() => []);
    if (projects.length) {
      return { name: 'project', params: { slug: projects[0].slug } };
    }
  }
  return true;
});
