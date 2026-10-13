import { useEffect, useId, useState, type CSSProperties } from 'react';
import { CheckCircle2, Moon, Plus, RotateCcw, Settings2, Sun, Trash2, TriangleAlert } from 'lucide-react';
import type { ColorPalette, Settings, ThemeColors } from '../../shared/types';
import { contrastRatio, createDefaultPalettes, DEFAULT_PALETTE_COLORS, getColorPalettes, getSelectedPalette, normalizeColorHex, resolveAccentColor, themeVariables } from '../../shared/appearance';
import { getLocale, t } from '../i18n';
import './AppearanceSettings.css';

interface AppearanceSettingsProps {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}

function PaletteEditor({ palette, initialMode, onChange }: {
  palette: ColorPalette;
  initialMode: 'light' | 'dark';
  onChange: (palette: ColorPalette) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const inputPrefix = useId();
  const fields = [
    { key: 'primary', label: t('按钮底色') },
    { key: 'accent', label: t('强调色') },
    { key: 'background', label: t('页面背景') },
    { key: 'surface', label: t('卡片背景') },
    { key: 'text', label: t('正文文字') },
  ] as const;
  const colors = palette[mode];
  const fallback = DEFAULT_PALETTE_COLORS[mode];
  const validColors: Required<ThemeColors> = {
    primary: normalizeColorHex(colors.primary) ?? fallback.primary,
    accent: resolveAccentColor(colors),
    background: normalizeColorHex(colors.background) ?? fallback.background,
    surface: normalizeColorHex(colors.surface) ?? fallback.surface,
    text: normalizeColorHex(colors.text) ?? fallback.text,
  };
  const minimumContrast = Math.min(contrastRatio(validColors.text, validColors.background), contrastRatio(validColors.text, validColors.surface));
  const variables = themeVariables(validColors, mode);

  function changeColor(key: keyof ThemeColors, value: string) {
    onChange({ ...palette, [mode]: { ...colors, [key]: value } });
  }

  return <div className="palette-editor">
    <label className="field palette-name">
      <span>{t('方案名称')}</span>
      <input value={palette.name} onChange={event => onChange({ ...palette, name: event.target.value })} maxLength={80} placeholder={t('为配色方案命名')} aria-invalid={!palette.name.trim()} aria-describedby={!palette.name.trim() ? `${inputPrefix}-name-error` : undefined} />
      {!palette.name.trim() && <small className="palette-color-error" id={`${inputPrefix}-name-error`}>{t('请输入方案名称。')}</small>}
    </label>
    <div className="palette-modes" role="group" aria-label={t('编辑明暗配色')}>
      <button type="button" aria-pressed={mode === 'light'} className={mode === 'light' ? 'active' : ''} onClick={() => setMode('light')}><Sun size={14} />{t('浅色配色')}</button>
      <button type="button" aria-pressed={mode === 'dark'} className={mode === 'dark' ? 'active' : ''} onClick={() => setMode('dark')}><Moon size={14} />{t('深色配色')}</button>
    </div>
    <p className="palette-help">{t('分别设置浅色和深色配色，边框、悬停等样式会自动搭配。')}</p>
    <div className="palette-layout">
      <div className="palette-fields">
        {fields.map(({ key, label }) => {
          const value = key === 'accent' ? colors.accent ?? resolveAccentColor(colors) : colors[key];
          const valid = normalizeColorHex(value) !== null;
          const id = `${inputPrefix}-${key}`;
          const descriptionId = key === 'accent' ? `${id}-description` : undefined;
          return <div className="palette-color-field" key={key}>
            <label htmlFor={id}>{label}</label>
            {key === 'accent' && <small className="palette-color-description" id={descriptionId}>{t('链接、操作文字和选中状态')}</small>}
            <div className="palette-color-inputs">
              <input type="color" value={validColors[key]} onChange={event => changeColor(key, event.target.value)} aria-label={t('{{label}}选色器', { label })} aria-describedby={descriptionId} />
              <input id={id} type="text" value={value} onChange={event => changeColor(key, event.target.value)} placeholder="#RRGGBB" maxLength={7} spellCheck={false} autoComplete="off" aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : descriptionId} />
            </div>
            {!valid && <small className="palette-color-error" id={`${id}-error`}>{t('请输入 #RGB 或 #RRGGBB 格式的颜色。')}</small>}
          </div>;
        })}
      </div>
      <div className="palette-preview" style={variables as CSSProperties} aria-label={t('配色预览')}>
        <span className="palette-preview-mode">{mode === 'light' ? t('浅色配色') : t('深色配色')}</span>
        <div className="palette-preview-card">
          <strong>{t('配色预览')}</strong>
          <p>{t('正文文字会以这个颜色显示。')}</p>
          <span className="palette-preview-meta">{t('辅助文字')}</span>
          <span className="palette-preview-link">{t('查看题目')}</span>
          <span className="palette-preview-button">{t('主按钮')}</span>
        </div>
      </div>
    </div>
    {minimumContrast < 4.5 && <p className="palette-contrast-notice" role="status"><TriangleAlert size={15} /><span>{t('正文文字与背景的对比度为 {{ratio}}:1，建议至少 4.5:1。', { ratio: minimumContrast.toFixed(2) })}</span></p>}
  </div>;
}

export default function AppearanceSettings({ settings, onChange }: AppearanceSettingsProps) {
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const resetButtonId = useId();
  const [systemDark, setSystemDark] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const palettes = getColorPalettes(settings);
  const selected = getSelectedPalette(settings);
  const deleting = palettes.find(palette => palette.id === deleteId);
  const previewMode = settings.theme === 'system' ? (systemDark ? 'dark' : 'light') : settings.theme;
  const themes = [
    { value: 'light', label: t('浅色'), icon: Sun },
    { value: 'dark', label: t('深色'), icon: Moon },
    { value: 'system', label: t('跟随系统'), icon: Settings2 },
  ] as const;

  function addPalette() {
    if (palettes.length >= 100) return;
    const baseName = t('{{name}}副本', { name: selected.name || t('未命名方案') }).slice(0, 76);
    let name = baseName;
    for (let suffix = 2; palettes.some(palette => palette.name === name); suffix++) name = `${baseName} ${suffix}`;
    const palette: ColorPalette = { id: crypto.randomUUID(), name, light: { ...selected.light }, dark: { ...selected.dark } };
    onChange({ palettes: [...palettes, palette], paletteId: palette.id });
  }

  function deletePalette() {
    if (!deleting || palettes.length <= 1) { setDeleteId(null); return; }
    const index = palettes.findIndex(palette => palette.id === deleting.id);
    const remaining = palettes.filter(palette => palette.id !== deleting.id);
    onChange({ palettes: remaining, paletteId: selected.id === deleting.id ? remaining[Math.min(index, remaining.length - 1)].id : selected.id });
    setDeleteId(null);
  }

  function closeReset() {
    setResetOpen(false);
    if (typeof document !== 'undefined') document.getElementById(resetButtonId)?.focus();
  }

  function resetPalettes() {
    const defaults = createDefaultPalettes(getLocale());
    onChange({ palettes: defaults, paletteId: defaults[0].id });
    setDeleteId(null);
    closeReset();
  }

  return <section className="panel settings-section appearance-settings">
    <h2><Sun size={20} />{t('外观')}</h2>
    <label className="field interface-language">
      <span>{t('界面语言')}</span>
      <select value={settings.uiLanguage ?? 'system'} onChange={event => onChange({ uiLanguage: event.target.value as Settings['uiLanguage'] })}>
        <option value="system">{t('跟随系统')}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
      <small>{t('语言更改将在保存设置后生效。')}</small>
    </label>
    <div className="appearance-group">
      <div className="appearance-group-heading">
        <h3 className="appearance-group-label">{t('配色方案')}</h3>
        <div className="appearance-scheme-actions">
          <button type="button" className="text-button muted" id={resetButtonId} aria-expanded={resetOpen} onClick={() => { setDeleteId(null); setResetOpen(true); }}><RotateCcw size={14} />{t('恢复默认方案集')}</button>
          <button type="button" className="text-button" onClick={addPalette} disabled={palettes.length >= 100} title={t('复制当前配色，创建新方案')}><Plus size={14} />{t('添加方案')}</button>
        </div>
      </div>
      {resetOpen && <div className="palette-reset-confirm" role="group" aria-label={t('恢复默认方案集？')} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeReset(); } }}>
        <strong>{t('恢复默认方案集？')}</strong>
        <p>{t('将用绿色、粉色、蓝色和黑白四套方案替换当前列表，并选中绿色。自行添加的方案和对原方案的修改都会移除。')}</p>
        <p>{t('保存设置后生效。明暗模式和其他设置保持不变。')}</p>
        <div className="confirm-actions"><button type="button" className="button" autoFocus onClick={closeReset}>{t('取消')}</button><button type="button" className="button button-danger" onClick={resetPalettes}>{t('确认恢复')}</button></div>
      </div>}
      <div className="appearance-schemes" role="group" aria-label={t('配色方案')}>
        {palettes.map(palette => {
          const variables = themeVariables(palette[previewMode], previewMode);
          const style = {
            '--preview-bg': variables['--bg'], '--preview-panel': variables['--panel'],
            '--preview-sidebar': variables['--sidebar'], '--preview-line': variables['--line'],
            '--preview-accent': variables['--accent'], '--preview-hero': variables['--hero'],
          } as CSSProperties;
          return <button
            type="button" key={palette.id} data-palette-id={palette.id} style={style}
            aria-pressed={selected.id === palette.id} title={palette.name || t('未命名方案')}
            className={`appearance-scheme${selected.id === palette.id ? ' active' : ''}`}
            onClick={() => onChange({ paletteId: palette.id })}
          >
            <span className="appearance-preview" aria-hidden="true">
              <span className="appearance-preview-sidebar"><i /><i /><i /></span>
              <span className="appearance-preview-content"><i /><span><i /><i /></span></span>
            </span>
            <span className="appearance-scheme-label"><i aria-hidden="true" /><span>{palette.name || t('未命名方案')}</span><CheckCircle2 size={16} className={selected.id === palette.id ? 'scheme-check' : 'scheme-check scheme-check-hidden'} aria-hidden="true" /></span>
          </button>;
        })}
      </div>
      <PaletteEditor palette={selected} initialMode={previewMode} onChange={palette => onChange({ palettes: palettes.map(current => current.id === palette.id ? palette : current) })} />
      <div className="palette-actions"><button type="button" className="text-button" onClick={() => { setResetOpen(false); setDeleteId(selected.id); }} disabled={palettes.length <= 1}><Trash2 size={13} />{t('删除方案')}</button>{palettes.length <= 1 && <small>{t('至少保留一个配色方案。')}</small>}</div>
      {deleting && <div className="palette-delete-confirm" role="group" aria-label={t('删除配色方案？')}>
        <p className="confirm-description">{t('将移除「{{name}}」，保存设置后生效。', { name: deleting.name || t('未命名方案') })}</p>
        <div className="confirm-actions"><button type="button" className="button button-secondary" autoFocus onClick={() => setDeleteId(null)}>{t('取消')}</button><button type="button" className="button button-danger" onClick={deletePalette}>{t('确认删除方案')}</button></div>
      </div>}
    </div>
    <div className="appearance-group">
      <h3 className="appearance-group-label">{t('明暗模式')}</h3>
      <div className="theme-options" role="group" aria-label={t('外观主题')}>
        {themes.map(({ value, label, icon: Icon }) => <button
          type="button" key={value} aria-pressed={settings.theme === value}
          className={settings.theme === value ? 'active' : ''} onClick={() => onChange({ theme: value })}
        ><Icon size={21} /><span>{label}</span><CheckCircle2 size={16} className={settings.theme === value ? 'theme-check' : 'theme-check theme-check-hidden'} aria-hidden="true" /></button>)}
      </div>
    </div>
    <p className="appearance-hint">{t('所有配色均支持浅色、深色和跟随系统，保存设置后生效。')}</p>
  </section>;
}

