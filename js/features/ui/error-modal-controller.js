import { sanitizeDetails } from '../../services/api-client.js';

/**
 * 负责错误弹窗的展示、关闭、图片提取预览与完整日志展开逻辑。
 */
export function createErrorModalControllerApi({
    documentRef = document
}) {
    function closeModal(id) {
        const modal = documentRef.getElementById(id);
        if (!modal) return;
        modal.classList.remove('active');
        if (modal.classList.contains('modal-overlay')) {
            modal.classList.add('hidden');
        }
    }

    function showErrorModal(title, msg, detail, modalTitle = '执行错误', log = null) {
        const modalEl = documentRef.getElementById('modal-error');
        if (!modalEl) return;

        const contentEl = modalEl.querySelector('.modal-content');
        contentEl?.classList.remove('error', 'success', 'warning', 'info');

        const type = log ? log.type : 'error';
        contentEl?.classList.add(type);

        const userFacing = log?.userFacing || null;
        documentRef.getElementById('error-modal-title').textContent = userFacing?.title || modalTitle;
        documentRef.getElementById('error-modal-msg').textContent = userFacing?.userMessage || msg;

        const suggestionBoxEl = documentRef.getElementById('error-modal-suggestion-box');
        const suggestionsEl = documentRef.getElementById('error-modal-suggestions');
        const suggestions = Array.isArray(userFacing?.suggestions)
            ? userFacing.suggestions.filter(Boolean)
            : [];
        if (suggestionBoxEl && suggestionsEl) {
            suggestionsEl.innerHTML = '';
            if (suggestions.length > 0) {
                suggestions.forEach((item) => {
                    const li = documentRef.createElement('li');
                    li.textContent = item;
                    suggestionsEl.appendChild(li);
                });
                suggestionBoxEl.classList.remove('hidden');
            } else {
                suggestionBoxEl.classList.add('hidden');
            }
        }

        const detailLabelEl = documentRef.getElementById('error-detail-label');
        const detailEl = documentRef.getElementById('error-modal-detail');
        if (detailEl) {
            detailEl.textContent = detail || '无详细信息';
            detailEl.classList.toggle('hidden', !detail);
            detailEl.scrollTop = 0;
        }
        detailLabelEl?.classList.toggle('hidden', !detail);

        const imageContainer = documentRef.getElementById('error-modal-images');
        if (imageContainer) {
            imageContainer.innerHTML = '';
            if (detail) {
                const foundImages = new Set();
                const mdImageRegex = /!\[[^\]]*\]\((data:image\/[^)]+)\)/g;
                const htmlImageRegex = /<img[^>]+src=["'](data:image\/[^"']+)["'][^>]*>/g;
                const dataUrlRegex = /(data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+)/g;

                let match;
                while ((match = mdImageRegex.exec(detail)) !== null) foundImages.add(match[1]);
                while ((match = htmlImageRegex.exec(detail)) !== null) foundImages.add(match[1]);
                while ((match = dataUrlRegex.exec(detail)) !== null) foundImages.add(match[1]);

                if (foundImages.size > 0) {
                    foundImages.forEach((src) => {
                        const img = documentRef.createElement('img');
                        img.src = src;
                        img.loading = 'lazy';
                        imageContainer.appendChild(img);
                    });
                }
            }
        }

        const btnFull = documentRef.getElementById('btn-show-full-log');
        if (btnFull) {
            const fullTextPreview = log?.rawDetails ? sanitizeDetails(log.rawDetails, { truncate: false }) : '';
            const hasExpandableDetails = Boolean(log?.rawDetails && fullTextPreview && fullTextPreview !== detail);
            if (hasExpandableDetails) {
                btnFull.classList.remove('hidden');
                btnFull.onclick = (e) => {
                    e.preventDefault();
                    const fullText = fullTextPreview || String(log.rawDetails || '');
                    showErrorModal(title, msg, fullText, modalTitle, {
                        type: log.type,
                        userFacing: log.userFacing || null,
                        rawDetails: null
                    });
                };
            } else {
                btnFull.classList.add('hidden');
                btnFull.onclick = null;
            }
        }

        modalEl.classList.add('active');
    }

    return {
        showErrorModal,
        closeModal
    };
}
