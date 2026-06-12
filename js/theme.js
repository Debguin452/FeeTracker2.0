(function() {
  const ROOT = document.documentElement;
  const mq   = window.matchMedia('(prefers-color-scheme: dark)');

  function applyTheme(isDark, save) {
    if (document.body) {
      document.body.classList.add('theme-transitioning');
      setTimeout(() => document.body.classList.remove('theme-transitioning'), 550);
    }
    isDark ? ROOT.classList.remove('light') : ROOT.classList.add('light');
    if (save) localStorage.setItem('ft_theme', isDark ? 'dark' : 'light');
    updateThemeToggleUI(isDark);
  }

  function updateThemeToggleUI(isDark) {
    const icon  = document.getElementById('themeToggleIcon');
    const label = document.getElementById('themeToggleLabel');
    const knob  = document.getElementById('themeToggleKnob');
    const sw    = document.getElementById('themeToggleSwitch');
    if (!icon || !label || !knob) return;
    icon.textContent  = isDark ? '🌙' : '☀️';
    label.textContent = isDark ? 'Dark Mode' : 'Light Mode';
    knob.style.left   = isDark ? '25px' : '3px';
    if (sw) sw.style.background = isDark ? 'var(--accent)' : 'var(--accent3)';
  }

  window.toggleTheme = function() {
    applyTheme(!ROOT.classList.contains('light'), true);
  };

  const saved  = localStorage.getItem('ft_theme');
  const isDark = saved ? saved === 'dark' : mq.matches;
  applyTheme(isDark, false);

  mq.addEventListener('change', e => {
    if (!localStorage.getItem('ft_theme')) applyTheme(e.matches, false);
  });

  document.addEventListener('DOMContentLoaded', () => {
    updateThemeToggleUI(!ROOT.classList.contains('light'));
  });

  window._refreshThemeUI = () => updateThemeToggleUI(!ROOT.classList.contains('light'));
})();
