import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';

// Poppins self-hosted via Fontsource (never the Google Fonts CDN, for GDPR).
import '@fontsource/poppins/400.css';
import '@fontsource/poppins/500.css';
import '@fontsource/poppins/600.css';
import '@fontsource/poppins/700.css';
import './styles.css';

createApp(App).use(router).mount('#app');
