import type { ColorPalette, PaletteColors, Settings, ThemeColors } from './types';
import { getLocale, type AppLocale } from './i18n';

export const DEFAULT_PALETTE_COLORS: PaletteColors = {
  light: { primary: '#c4e3cc', accent: '#287950', background: '#f8faf8', surface: '#ffffff', text: '#29372e' },
  dark: { primary: '#c5e6ce', accent: '#91cba3', background: '#1c221e', surface: '#252e27', text: '#e9f4ec' },
};

export function createDefaultPalettes(locale: AppLocale = getLocale()): ColorPalette[] {
  const names = locale === 'en' ? ['Green', 'Pink', 'Blue', 'Black & white'] : ['绿色', '粉色', '蓝色', '黑白'];
  return [
    { id: 'green', name: names[0], light: { ...DEFAULT_PALETTE_COLORS.light }, dark: { ...DEFAULT_PALETTE_COLORS.dark } },
    { id: 'pink', name: names[1],
      light: { primary: '#f8bed0', accent: '#fb7299', background: '#fff8fa', surface: '#ffffff', text: '#3b2e32' },
      dark: { primary: '#ffc4d4', accent: '#ffa8c0', background: '#211e20', surface: '#2b2729', text: '#f7ecef' } },
    { id: 'blue', name: names[2],
      light: { primary: '#c3dcff', accent: '#3068ad', background: '#f7faff', surface: '#ffffff', text: '#2c3442' },
      dark: { primary: '#c4ddff', accent: '#9dc5ff', background: '#1c2026', surface: '#242b34', text: '#eaf1fc' } },
    { id: 'mono', name: names[3],
      light: { primary: '#e5e5e5', accent: '#606060', background: '#fafafa', surface: '#ffffff', text: '#303030' },
      dark: { primary: '#dedede', accent: '#dedede', background: '#191919', surface: '#242424', text: '#f2f2f2' } },
  ];
}

export function getColorPalettes(settings: Pick<Settings, 'palettes' | 'uiLanguage'>): ColorPalette[] {
  return settings.palettes?.length ? settings.palettes : createDefaultPalettes(settings.uiLanguage === 'en' || settings.uiLanguage === 'zh-CN' ? settings.uiLanguage : getLocale());
}

export function getSelectedPalette(settings: Pick<Settings, 'palettes' | 'paletteId' | 'uiLanguage'>): ColorPalette {
  const palettes = getColorPalettes(settings);
  return palettes.find(palette => palette.id === settings.paletteId) ?? palettes[0];
}

export function appearanceEqual(left: Settings, right: Settings): boolean {
  const normalized = (settings: Settings) => ({
    paletteId: getSelectedPalette(settings).id,
    palettes: getColorPalettes(settings).map(palette => ({
      id: palette.id, name: palette.name,
      ...Object.fromEntries((['light', 'dark'] as const).map(mode => [mode,
        Object.fromEntries((['primary', 'accent', 'background', 'surface', 'text'] as const).map(field => [field, field === 'accent' && palette[mode].accent === undefined ? resolveAccentColor(palette[mode]) : normalizeColorHex(palette[mode][field]) ?? palette[mode][field]])),
      ])),
    })),
  });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

export function appearanceBackground(settings: Settings, systemDark: boolean): string {
  const mode = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  return normalizeColorHex(getSelectedPalette(settings)[mode].background) ?? DEFAULT_PALETTE_COLORS[mode].background;
}

export function normalizeColorHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) return `#${[...color.slice(1)].map(character => character.repeat(2)).join('')}`;
  return null;
}

function rgb(color: string): number[] {
  const hex = normalizeColorHex(color);
  if (!hex) throw new Error('Invalid hex color');
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
}

function luminance(color: string): number {
  const [red, green, blue] = rgb(color).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function mix(first: string, second: string, amount: number): string {
  const from = rgb(first), to = rgb(second);
  return `#${from.map((value, index) => Math.round(value + (to[index] - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function hsl(color: string): [number, number, number] {
  const [red, green, blue] = rgb(color).map(channel => channel / 255);
  const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum, lightness = (maximum + minimum) / 2;
  if (!chroma) return [0, 0, lightness];
  const hue = maximum === red ? ((green - blue) / chroma + 6) % 6 : maximum === green ? (blue - red) / chroma + 2 : (red - green) / chroma + 4;
  return [hue / 6, chroma / (1 - Math.abs(2 * lightness - 1)), lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const intermediate = chroma * (1 - Math.abs((hue * 6) % 2 - 1));
  const sector = Math.floor(hue * 6) % 6;
  const channels = [[chroma, intermediate, 0], [intermediate, chroma, 0], [0, chroma, intermediate], [0, intermediate, chroma], [intermediate, 0, chroma], [chroma, 0, intermediate]][sector];
  return `#${channels.map(channel => Math.round((channel + lightness - chroma / 2) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function readableAccent(color: string, background: string): string {
  if (contrastRatio(color, background) >= 4.8) return color;
  const [hue, saturation, lightness] = hsl(color);
  const targetLightness = readableInk(background) === '#ffffff' ? 1 : 0;
  // Change lightness without mixing away the chosen hue and saturation.
  for (let step = 1; step <= 100; step++) {
    const adjusted = fromHsl(hue, saturation, lightness + (targetLightness - lightness) * step / 100);
    if (contrastRatio(adjusted, background) >= 4.8) return adjusted;
  }
  return readableInk(background);
}

/** Upgrade four-color palettes by color values alone; IDs and names have no styling role. */
export function resolveAccentColor(colors: ThemeColors): string {
  const explicit = normalizeColorHex(colors.accent);
  if (explicit) return explicit;
  const primary = normalizeColorHex(colors.primary) ?? DEFAULT_PALETTE_COLORS.light.primary;
  const surface = normalizeColorHex(colors.surface) ?? DEFAULT_PALETTE_COLORS.light.surface;
  const [hue, saturation] = hsl(primary);
  const light = luminance(surface) > 0.35;
  return readableAccent(fromHsl(hue, light ? Math.min(saturation, 0.6) : saturation, light ? 0.445 : 0.83), surface);
}

function readableInk(background: string): string {
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#000000' : '#ffffff';
}

function readableColor(color: string, background: string): string {
  if (contrastRatio(color, background) >= 4.8) return color;
  const target = readableInk(background);
  // Keep as much of the chosen hue as possible while making UI labels readable.
  for (let step = 1; step <= 100; step++) {
    const adjusted = mix(color, target, step / 100);
    if (contrastRatio(adjusted, background) >= 4.8) return adjusted;
  }
  return target;
}

function distinguishableFill(color: string, background: string, accent: string): string {
  // Equal tint amounts look much paler for high-luminance hues such as green.
  // Strengthen only derived fills that disappear into their surrounding panel.
  const minimum = 1.1;
  if (contrastRatio(color, background) >= minimum || contrastRatio(accent, background) < minimum) return color;
  for (let step = 1; step <= 100; step++) {
    const adjusted = mix(color, accent, step / 100);
    if (contrastRatio(adjusted, background) >= minimum) return adjusted;
  }
  return color;
}

export function themeVariables(colors: ThemeColors, mode: 'light' | 'dark' = 'light'): Record<string, string> {
  const fallback = DEFAULT_PALETTE_COLORS[mode];
  const base = Object.fromEntries((['primary', 'background', 'surface', 'text'] as const).map(key => {
    const field = key as keyof ThemeColors;
    return [field, normalizeColorHex(colors?.[field]) ?? fallback[field]];
  })) as unknown as ThemeColors;
  const { primary, background, surface, text } = base;
  const chosenAccent = resolveAccentColor({ ...base, accent: colors.accent });
  const [accentHue, accentSaturation] = hsl(chosenAccent);
  const lightSurface = luminance(surface) > 0.35;
  const tint = fromHsl(accentHue, Math.min(1, accentSaturation * 2), lightSurface ? 0.5 : 0.7);
  const sidebar = mix(background, surface, 0.65);
  const softFill = mix(surface, tint, lightSurface ? 0.1 : 0.14);
  const selected = lightSurface ? distinguishableFill(softFill, sidebar, chosenAccent) : softFill;
  // Explicit palette colors are user choices. Keep the saved accent exact,
  // just as we do for button backgrounds and body text.
  const accent = chosenAccent;
  const selection = mix(surface, tint, lightSurface ? 0.2 : 0.3);
  const onPrimary = contrastRatio(text, primary) >= 4.5 ? text : readableInk(primary);
  const darkerHover = mix(primary, '#000000', 0.14);
  const lighterHover = mix(primary, '#ffffff', 0.14);
  const primaryHover = contrastRatio(onPrimary, darkerHover) >= contrastRatio(onPrimary, lighterHover) ? darkerHover : lighterHover;
  return {
    '--bg': background, '--panel': surface, '--sidebar': sidebar, '--text': text,
    '--muted': readableColor(mix(text, surface, 0.35), surface), '--soft': readableColor(mix(text, surface, 0.2), surface),
    '--line': mix(surface, chosenAccent, lightSurface ? 0.18 : 0.16), '--accent': accent, '--accent-hover': mix(accent, readableInk(surface), 0.12),
    '--accent-soft': selected, '--accent-border': mix(surface, accent, 0.48),
    '--primary-bg': primary, '--primary-hover': primaryHover,
    '--primary-border': mix(primary, onPrimary, 0.18), '--on-primary': onPrimary,
    '--focus-ring': `${accent}88`, '--focus-shadow': `${accent}24`, '--selection': selection, '--selection-text': readableColor(text, selection),
    '--hero': selected, '--input': mix(surface, background, 0.45), '--code': mix(surface, background, 0.75),
    '--scrollbar': mix(surface, text, 0.26), '--shadow': mode === 'dark' ? 'none' : `0 4px 18px ${text}06`,
    '--hover-shadow': `0 8px 24px ${text}10`,
  };
}

export const THEME_PROPERTIES = Object.keys(themeVariables(DEFAULT_PALETTE_COLORS.light));
