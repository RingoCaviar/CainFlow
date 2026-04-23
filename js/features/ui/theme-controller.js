/**
 * 负责主题模式的标准化、DOM 应用与主题切换按钮状态同步。
 */
export function createThemeControllerApi({
    state,
    documentRef = document,
    saveState = () => {}
}) {
    const THEME_ATTRIBUTE = 'data-app-theme';
    const THEME_MODES = Object.freeze({
        DARK: 'dark',
        LIGHT: 'light'
    });

    function normalizeThemeMode(value) {
        return value === THEME_MODES.LIGHT ? THEME_MODES.LIGHT : THEME_MODES.DARK;
    }

    function getThemeToggleButton() {
        return documentRef.getElementById('btn-theme-toggle');
    }

    function bindThemeToggleButton() {
        const button = getThemeToggleButton();
        if (!button || button.dataset.themeBound === 'true') return;

        button.addEventListener('click', () => {
            toggleTheme();
        });
        button.dataset.themeBound = 'true';
    }

    function syncThemeToggleUi(mode) {
        const button = getThemeToggleButton();
        if (!button) return;

        const normalizedMode = normalizeThemeMode(mode);
        const isLight = normalizedMode === THEME_MODES.LIGHT;
        const currentLabel = isLight ? '浅色' : '深色';
        const nextLabel = isLight ? '深色' : '浅色';
        const buttonLabel = button.querySelector('[data-role="theme-toggle-label"]');

        button.dataset.themeMode = normalizedMode;
        button.setAttribute('aria-pressed', String(isLight));
        button.setAttribute('aria-label', `当前${currentLabel}主题，点击切换到${nextLabel}主题`);
        button.title = `当前${currentLabel}主题，点击切换到${nextLabel}主题`;

        if (buttonLabel) {
            buttonLabel.textContent = `主题：${currentLabel}`;
        }
    }

    function applyTheme(mode) {
        const normalizedMode = normalizeThemeMode(mode);

        state.themeMode = normalizedMode;
        documentRef.documentElement.setAttribute(THEME_ATTRIBUTE, normalizedMode);
        documentRef.documentElement.style.colorScheme = normalizedMode;
        syncThemeToggleUi(normalizedMode);

        return normalizedMode;
    }

    function toggleTheme() {
        const nextMode = normalizeThemeMode(state.themeMode) === THEME_MODES.LIGHT
            ? THEME_MODES.DARK
            : THEME_MODES.LIGHT;

        const appliedMode = applyTheme(nextMode);
        saveState();
        return appliedMode;
    }

    function initTheme() {
        bindThemeToggleButton();
        const bootstrappedTheme = documentRef.documentElement.getAttribute(THEME_ATTRIBUTE);
        return applyTheme(bootstrappedTheme || state.themeMode);
    }

    return {
        THEME_ATTRIBUTE,
        THEME_MODES,
        normalizeThemeMode,
        bindThemeToggleButton,
        applyTheme,
        syncThemeToggleUi,
        toggleTheme,
        initTheme
    };
}
