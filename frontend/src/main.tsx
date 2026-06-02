import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import App from './App';
import './index.css';
import { validateFrontendEnv } from './utils/envValidation';
import Misconfiguration from './components/Misconfiguration';

let error: Error | null = null;
try {
  validateFrontendEnv();
} catch (err) {
  error = err as Error;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        {error ? (
          <Misconfiguration error={error} />
        ) : (
          <App />
        )}
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);

