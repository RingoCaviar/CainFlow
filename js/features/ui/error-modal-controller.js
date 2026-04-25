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
            if (suggestions.length > 0) {
                suggestionsEl.innerHTML = suggestions.map((item) => `<li>${item}</li>`).join('');
                suggestionBoxEl.classList.remove('hidden');
            } else {
                suggestionsEl.innerHTML = '';
                suggestionBoxEl.classList.add('hidden');
            }
        }

        const detailLabelEl = documentRef.getElementById('error-detail-label');
        const detailEl = documentRef.getElementById('error-modal-detail');
        if (detailEl) {
            detailEl.textContent = detail || '无详细信息';
            detailEl.classList.toggle('hidden', !detail);
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
            const isTruncated = detail && detail.includes('... [数据过长已截断]');
            if (log && log.rawDetails && isTruncated) {
                btnFull.classList.remove('hidden');
                btnFull.onclick = (e) => {
                    e.preventDefault();
                    let fullText = log.rawDetails;
                    if (typeof fullText !== 'string') {
                        try {
                            fullText = JSON.stringify(fullText, null, 2);
                        } catch (error) {
                            fullText = String(fullText);
                        }
                    }
                    showErrorModal(title, msg, fullText, modalTitle, null);
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
