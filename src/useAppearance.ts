import { useLayoutEffect } from 'react';
import { THEME_PROPERTIES, getSelectedPalette, themeVariables } from '../shared/appearance';
import type { Settings } from '../shared/types';

export function useAppearance(settings: Settings): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const mode = settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme;
      const palette = getSelectedPalette(settings);
      root.dataset.theme = mode;
      root.dataset.paletteId = palette.id;
      for (const property of THEME_PROPERTIES) root.style.removeProperty(property);
      for (const [property, value] of Object.entries(themeVariables(palette[mode], mode))) root.style.setProperty(property, value);
    };
    update();
    if (settings.theme === 'system') media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      for (const property of THEME_PROPERTIES) root.style.removeProperty(property);
    };
  }, [settings.theme, settings.paletteId, settings.palettes, settings.uiLanguage]);
}
