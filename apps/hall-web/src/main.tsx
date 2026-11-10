import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens-colors.css';
import './styles/tokens-typography.css';
import './styles/tokens-spacing.css';
import './styles/tokens-effects.css';
import './styles/base.css';
import './styles/app.css';
import { App } from './App.js';
import { AuthProvider } from './auth.js';
import { I18nProvider } from './i18n.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);
