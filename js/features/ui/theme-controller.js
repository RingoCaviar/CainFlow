/**
 * Responsible for theme normalization, DOM application, and keeping the theme
 * menu in sync with the active theme.
 */
export function createThemeControllerApi({
    state,
    documentRef = document,
    saveState = () => {}
}) {
    const THEME_ATTRIBUTE = 'data-app-theme';
    const THEME_IDS = Object.freeze({
        DARK: 'dark',
        PRO: 'pro',
        LIGHT: 'light',
        GLASS_LIGHT: 'glass-light',
        PINK: 'pink'
    });
    const THEMES = Object.freeze([
        {
            id: THEME_IDS.DARK,
            label: '\u6df1\u8272',
            colorScheme: 'dark'
        },
        {
            id: THEME_IDS.PRO,
            label: 'pro',
            colorScheme: 'dark'
        },
        {
            id: THEME_IDS.LIGHT,
            label: '\u6d45\u8272',
            colorScheme: 'light'
        },
        {
            id: THEME_IDS.GLASS_LIGHT,
            label: 'Glass Light',
            colorScheme: 'light'
        },
        {
            id: THEME_IDS.PINK,
            label: 'pink',
            colorScheme: 'light'
        }
    ]);
    const THEME_MAP = new Map(THEMES.map((theme) => [theme.id, theme]));

    function normalizeThemeId(value) {
        if (THEME_MAP.has(value)) return value;
        if (value === THEME_IDS.LIGHT) return THEME_IDS.LIGHT;
        return THEME_IDS.DARK;
    }

    function getThemeById(themeId) {
        return THEME_MAP.get(normalizeThemeId(themeId)) || THEMES[0];
    }

    function getThemeToggleButton() {
        return documentRef.getElementById('btn-theme-toggle');
    }

    function getThemeMenu() {
        return documentRef.getElementById('theme-menu');
    }

    function ensureThemeMenuLayer() {
        const menu = getThemeMenu();
        if (!menu) return null;
        if (menu.parentElement !== documentRef.body) {
            documentRef.body.appendChild(menu);
        }
        return menu;
    }

    function isMenuOpen() {
        return !getThemeMenu()?.classList.contains('hidden');
    }

    function positionThemeMenu() {
        const button = getThemeToggleButton();
        const menu = getThemeMenu();
        if (!button || !menu) return;

        const rect = button.getBoundingClientRect();
        const menuWidth = menu.offsetWidth || 180;
        const menuHeight = menu.offsetHeight || 0;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const left = Math.min(
            Math.max(12, rect.right - menuWidth),
            Math.max(12, viewportWidth - menuWidth - 12)
        );
        const top = Math.min(
            rect.bottom + 10,
            Math.max(12, viewportHeight - menuHeight - 12)
        );

        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function setMenuOpen(isOpen) {
        const button = getThemeToggleButton();
        const menu = getThemeMenu();
        if (!button || !menu) return;

        menu.classList.toggle('hidden', !isOpen);
        button.setAttribute('aria-expanded', String(isOpen));
        if (isOpen) positionThemeMenu();
    }

    function closeThemeMenu() {
        setMenuOpen(false);
    }

    function openThemeMenu() {
        setMenuOpen(true);
    }

    function toggleThemeMenu() {
        setMenuOpen(!isMenuOpen());
    }

    function buildThemeMenuMarkup() {
        return THEMES.map((theme) => `
            <button
                type="button"
                class="theme-menu-item"
                role="menuitemradio"
                data-theme-id="${theme.id}"
                aria-checked="false"
            >
                <span class="theme-menu-item-label">${theme.label}</span>
                <svg class="theme-menu-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M20 6L9 17l-5-5" />
                </svg>
            </button>
        `).join('');
    }

    function renderThemeMenu() {
        const menu = ensureThemeMenuLayer();
        if (!menu) return;

        if (menu.dataset.themeMenuReady !== 'true') {
            menu.innerHTML = buildThemeMenuMarkup();
            menu.dataset.themeMenuReady = 'true';
        }

        const currentThemeId = normalizeThemeId(state.themeId);
        menu.querySelectorAll('.theme-menu-item').forEach((item) => {
            const isActive = item.dataset.themeId === currentThemeId;
            item.classList.toggle('is-active', isActive);
            item.setAttribute('aria-checked', String(isActive));
        });
    }

    function bindThemeMenuEvents() {
        const button = getThemeToggleButton();
        const menu = ensureThemeMenuLayer();
        if (!button || !menu) return;
        if (button.dataset.themeBound === 'true') return;

        button.addEventListener('click', (event) => {
            event.stopPropagation();
            toggleThemeMenu();
        });

        menu.addEventListener('click', (event) => {
            const item = event.target.closest('.theme-menu-item');
            if (!item) return;

            const selectedThemeId = item.dataset.themeId;
            if (!selectedThemeId) return;

            applyTheme(selectedThemeId);
            saveState();
            closeThemeMenu();
        });

        documentRef.addEventListener('click', (event) => {
            const shell = event.target.closest('.theme-menu-shell');
            if (!shell) closeThemeMenu();
        });

        documentRef.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                closeThemeMenu();
            }
        });

        window.addEventListener('resize', () => {
            if (isMenuOpen()) positionThemeMenu();
        });

        window.addEventListener('scroll', () => {
            if (isMenuOpen()) positionThemeMenu();
        }, true);

        button.dataset.themeBound = 'true';
    }

    function syncThemeToggleUi(themeId) {
        const button = getThemeToggleButton();
        if (!button) return;

        const currentTheme = getThemeById(themeId);
        const buttonLabel = button.querySelector('[data-role="theme-toggle-label"]');

        button.dataset.themeId = currentTheme.id;
        button.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-label', `\u5f53\u524d\u4e3b\u9898\uff1a${currentTheme.label}\uff0c\u70b9\u51fb\u6253\u5f00\u4e3b\u9898\u83dc\u5355`);
        button.title = `\u5f53\u524d\u4e3b\u9898\uff1a${currentTheme.label}`;

        if (buttonLabel) {
            buttonLabel.textContent = `\u4e3b\u9898\uff1a${currentTheme.label}`;
        }

        renderThemeMenu();
    }

    function applyTheme(themeId) {
        const theme = getThemeById(themeId);

        state.themeId = theme.id;
        documentRef.documentElement.setAttribute(THEME_ATTRIBUTE, theme.id);
        documentRef.documentElement.style.colorScheme = theme.colorScheme || 'dark';
        syncThemeToggleUi(theme.id);

        return theme.id;
    }

    function initTheme() {
        ensureThemeMenuLayer();
        renderThemeMenu();
        bindThemeMenuEvents();
        const bootstrappedTheme = documentRef.documentElement.getAttribute(THEME_ATTRIBUTE);
        closeThemeMenu();
        return applyTheme(bootstrappedTheme || state.themeId);
    }

    return {
        THEME_ATTRIBUTE,
        THEME_IDS,
        THEMES,
        normalizeThemeId,
        getThemeById,
        renderThemeMenu,
        applyTheme,
        closeThemeMenu,
        openThemeMenu,
        toggleThemeMenu,
        initTheme
    };
}
