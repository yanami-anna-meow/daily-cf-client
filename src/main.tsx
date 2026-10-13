import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource/jetbrains-mono/latin-400.css';
import './styles.css';
import { setLocale } from './i18n';

setLocale('system', navigator.languages?.length ? navigator.languages : [navigator.language]);
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
