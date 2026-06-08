/**
 * 管理版本更新检查、刷新提示与更新前备份导出等流程。
 */
export function createUpdateManager({
    appVersion,
    githubRepo,
    getProxyHeaders,
    showToast,
    renderGeneralSettings,
    exportWorkflow,
    floatingNoticesApi = null,
    autoUpdateCheckDisabled = false,
    documentRef = document,
    windowRef = window,
    localStorageRef = localStorage,
    fetchImpl = fetch,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
}) {
    let autoCheckCountdownTimer = null;
    let autoCheckCountdownToast = null;
    let latestReleaseData = null;
    let updateDownloadInProgress = false;
    let updateDownloadPollTimer = null;
    let updateDownloadToast = null;
    let updateCheckProgressToast = null;
    let activeUpdateJobId = '';
    let handledTerminalUpdateJobId = '';
    const refreshNoticeDismissStorageKey = 'cainflow_refresh_notice_dismissed';
    const updateDownloadTextKey = 'cainflow_update_download_text';
    const updateDownloadSnapshotKey = 'cainflow_update_download_snapshot';
    const activeDownloadStatuses = new Set(['starting', 'resolving', 'downloading', 'proxy_testing', 'proxy_switching', 'extracting', 'replacing', 'canceling']);
    const updateDownloadPollIntervalMs = 250;
    const updateDownloadTerminalToastDelayMs = 1200;
    const updateDownloadCompletionPromptDelayMs = 450;

    function isAutoUpdateCheckDisabled() {
        if (typeof autoUpdateCheckDisabled === 'function') {
            return autoUpdateCheckDisabled() === true;
        }
        return autoUpdateCheckDisabled === true;
    }

    function dismissUpdateCheckProgressToast() {
        if (!updateCheckProgressToast) return;
        const toast = updateCheckProgressToast;
        updateCheckProgressToast = null;
        toast.dismiss?.();
    }

    function compareVersions(v1, v2) {
        const parse = (value) => {
            const match = String(value || '').trim().match(/\d+(?:\.\d+)*/);
            if (!match) return [0];
            return match[0].split('.').map((part) => {
                const num = Number.parseInt(part, 10);
                return Number.isFinite(num) ? num : 0;
            });
        };
        const a = parse(v1);
        const b = parse(v2);
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const numA = a[i] || 0;
            const numB = b[i] || 0;
            if (numA > numB) return 1;
            if (numA < numB) return -1;
        }
        return 0;
    }

    function escapeHtml(value = '') {
        return String(value).replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    }

    function formatReleaseDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '未知日期';
        return date.toLocaleDateString();
    }

    function getReleaseTagName(release = {}) {
        return release.tag_name || release.tagName || release.name || '未知版本';
    }

    function normalizeReleaseList(releaseData = null) {
        const rawList = Array.isArray(releaseData?.releaseHistory)
            ? releaseData.releaseHistory
            : (releaseData ? [releaseData] : []);
        const seen = new Set();
        const releases = [];

        rawList.forEach((release) => {
            if (!release) return;
            const tagName = getReleaseTagName(release);
            if (!tagName || seen.has(tagName)) return;
            seen.add(tagName);
            releases.push(release);
        });

        return releases.length > 0 ? releases : [];
    }

    function decodeHtmlEntities(value = '') {
        const textarea = documentRef.createElement('textarea');
        textarea.innerHTML = String(value || '');
        return textarea.value;
    }

    function sanitizeReleaseUrl(value = '') {
        const raw = String(value || '').trim();
        if (!raw) return '';

        try {
            const baseUrl = windowRef.location?.href || 'https://example.com/';
            const parsed = new URL(raw, baseUrl);
            const protocol = String(parsed.protocol || '').toLowerCase();
            if (protocol !== 'http:' && protocol !== 'https:') return '';
            return parsed.href;
        } catch {
            return '';
        }
    }

    function hasEncodedReleaseHtml(value = '') {
        return /&lt;\s*\/?\s*(?:p|br|ul|ol|li|h[1-6]|pre|code|blockquote|div|a|strong|em|b|i|hr)\b/i.test(String(value || ''));
    }

    function hasRenderableReleaseHtml(value = '') {
        return /<\/?\s*(?:p|ul|ol|li|h[1-6]|pre|code|blockquote|div|a|strong|em|b|i|hr)\b/i.test(String(value || ''));
    }

    function sanitizeReleaseHtml(html = '') {
        const source = documentRef.createElement('template');
        source.innerHTML = String(html || '');

        const output = documentRef.createElement('template');
        const allowedTags = new Set([
            'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            'HR', 'I', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'B', 'UL', 'DEL'
        ]);
        const normalizedTagMap = {
            B: 'strong',
            DIV: 'p',
            I: 'em'
        };

        const appendSanitizedNode = (node, parent) => {
            if (!node) return;

            if (node.nodeType === 3) {
                parent.appendChild(documentRef.createTextNode(node.textContent || ''));
                return;
            }

            if (node.nodeType !== 1) return;

            const sourceTag = String(node.tagName || '').toUpperCase();
            if (!allowedTags.has(sourceTag)) {
                Array.from(node.childNodes || []).forEach((childNode) => appendSanitizedNode(childNode, parent));
                return;
            }

            const normalizedTag = normalizedTagMap[sourceTag] || sourceTag.toLowerCase();
            const element = documentRef.createElement(normalizedTag);

            if (sourceTag === 'A') {
                const safeHref = sanitizeReleaseUrl(node.getAttribute('href') || '');
                if (!safeHref) {
                    Array.from(node.childNodes || []).forEach((childNode) => appendSanitizedNode(childNode, parent));
                    return;
                }
                element.setAttribute('href', safeHref);
                element.setAttribute('target', '_blank');
                element.setAttribute('rel', 'noreferrer noopener');

                const title = String(node.getAttribute('title') || '').trim();
                if (title) {
                    element.setAttribute('title', title);
                }
            }

            Array.from(node.childNodes || []).forEach((childNode) => appendSanitizedNode(childNode, element));

            const textContent = element.textContent?.trim() || '';
            const hasMeaningfulChild = element.querySelector('br, hr, ul, ol, li, pre, blockquote, h1, h2, h3, h4, h5, h6');
            if (!textContent && !hasMeaningfulChild && normalizedTag !== 'br' && normalizedTag !== 'hr') {
                return;
            }

            parent.appendChild(element);
        };

        Array.from(source.content.childNodes || []).forEach((childNode) => appendSanitizedNode(childNode, output.content));

        const sanitizedHtml = output.innerHTML.trim();
        return sanitizedHtml || '<p>暂无更新日志详情</p>';
    }

    function renderMarkdownInline(text = '') {
        const raw = String(text || '');
        const tokens = [];
        const createToken = (html) => {
            const token = `@@CF_MD_${tokens.length}@@`;
            tokens.push({ token, html });
            return token;
        };

        let content = raw.replace(/`([^`\n]+)`/g, (_, code) => createToken(`<code>${escapeHtml(code)}</code>`));

        content = content.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title = '') => {
            const safeUrl = sanitizeReleaseUrl(url);
            if (!safeUrl) return label;
            const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
            return createToken(
                `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer noopener"${titleAttr}>${escapeHtml(label)}</a>`
            );
        });

        content = escapeHtml(content);
        content = content.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        content = content.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        content = content.replace(/(^|[^\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
        content = content.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
        content = content.replace(/~~([^~]+)~~/g, '<del>$1</del>');

        tokens.forEach(({ token, html }) => {
            content = content.replaceAll(token, html);
        });

        return content;
    }

    function renderBasicMarkdownReleaseBody(body = '') {
        const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
        const html = [];
        let paragraphLines = [];
        let listType = '';
        let listItems = [];
        let quoteLines = [];
        let codeFenceOpen = false;
        let codeFenceLines = [];
        let codeFenceLanguage = '';

        const flushParagraph = () => {
            if (paragraphLines.length === 0) return;
            html.push(`<p>${paragraphLines.map((line) => renderMarkdownInline(line)).join('<br>')}</p>`);
            paragraphLines = [];
        };

        const flushList = () => {
            if (!listType || listItems.length === 0) return;
            html.push(`<${listType}>${listItems.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join('')}</${listType}>`);
            listType = '';
            listItems = [];
        };

        const flushQuote = () => {
            if (quoteLines.length === 0) return;
            html.push(`<blockquote>${renderBasicMarkdownReleaseBody(quoteLines.join('\n'))}</blockquote>`);
            quoteLines = [];
        };

        const flushCodeFence = () => {
            if (!codeFenceOpen) return;
            const safeLanguage = codeFenceLanguage.replace(/[^\w-]/g, '');
            const languageClass = safeLanguage ? ` class="language-${escapeHtml(safeLanguage)}"` : '';
            html.push(`<pre><code${languageClass}>${escapeHtml(codeFenceLines.join('\n'))}</code></pre>`);
            codeFenceOpen = false;
            codeFenceLines = [];
            codeFenceLanguage = '';
        };

        lines.forEach((line) => {
            const trimmed = line.trim();

            if (codeFenceOpen) {
                if (/^```/.test(trimmed)) {
                    flushCodeFence();
                } else {
                    codeFenceLines.push(line);
                }
                return;
            }

            if (/^```/.test(trimmed)) {
                flushParagraph();
                flushList();
                flushQuote();
                codeFenceOpen = true;
                codeFenceLanguage = trimmed.slice(3).trim();
                return;
            }

            if (!trimmed) {
                flushParagraph();
                flushList();
                flushQuote();
                return;
            }

            if (/^>\s?/.test(trimmed)) {
                flushParagraph();
                flushList();
                quoteLines.push(trimmed.replace(/^>\s?/, ''));
                return;
            }

            flushQuote();

            const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (heading) {
                flushParagraph();
                flushList();
                const level = Math.max(1, Math.min(6, heading[1].length));
                html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
                return;
            }

            const unorderedItem = trimmed.match(/^[-*+]\s+(.+)$/);
            if (unorderedItem) {
                flushParagraph();
                if (listType && listType !== 'ul') flushList();
                listType = 'ul';
                listItems.push(unorderedItem[1]);
                return;
            }

            const orderedItem = trimmed.match(/^\d+\.\s+(.+)$/);
            if (orderedItem) {
                flushParagraph();
                if (listType && listType !== 'ol') flushList();
                listType = 'ol';
                listItems.push(orderedItem[1]);
                return;
            }

            flushList();
            paragraphLines.push(trimmed);
        });

        flushParagraph();
        flushList();
        flushQuote();
        flushCodeFence();

        return html.join('');
    }

    function renderMarkdownReleaseBody(body = '') {
        const source = String(body || '').trim();
        if (!source) return '<p>暂无更新日志详情</p>';

        if (windowRef.marked && typeof windowRef.marked.parse === 'function') {
            try {
                return sanitizeReleaseHtml(windowRef.marked.parse(source, {
                    breaks: true,
                    gfm: true
                }));
            } catch (error) {
                console.warn('Failed to render release body with marked, falling back to basic markdown renderer:', error);
            }
        }

        return sanitizeReleaseHtml(renderBasicMarkdownReleaseBody(source));
    }

    function getReleaseBodyHtml(release = {}) {
        const rawBody = String(release.body || '').trim();
        if (!rawBody) return '<p>暂无更新日志详情</p>';

        const decodedBody = hasEncodedReleaseHtml(rawBody) ? decodeHtmlEntities(rawBody) : rawBody;
        if (hasRenderableReleaseHtml(decodedBody)) {
            return sanitizeReleaseHtml(decodedBody);
        }

        const markdownSource = decodedBody.replace(/<br\s*\/?>/gi, '\n');
        return renderMarkdownReleaseBody(markdownSource);
    }

    function renderReleaseChangelogs(container, releaseData) {
        const releases = normalizeReleaseList(releaseData);
        container.textContent = '';

        if (releases.length === 0) {
            container.innerHTML = '<p>暂无更新日志详情</p>';
            return;
        }

        releases.forEach((release, index) => {
            const tagName = getReleaseTagName(release);
            const item = documentRef.createElement('details');
            item.className = 'update-release-item';
            item.open = index === 0;

            const summary = documentRef.createElement('summary');
            summary.className = 'update-release-summary';

            const title = documentRef.createElement('span');
            title.className = 'update-release-title';
            title.textContent = index === 0 ? `${tagName} 最新版本` : tagName;
            summary.appendChild(title);

            const meta = documentRef.createElement('span');
            meta.className = 'update-release-date';
            meta.textContent = formatReleaseDate(release.published_at);
            summary.appendChild(meta);
            item.appendChild(summary);

            const body = documentRef.createElement('div');
            body.className = 'update-release-body';
            body.innerHTML = getReleaseBodyHtml(release);
            item.appendChild(body);

            container.appendChild(item);
        });
    }

    function showUpdateModal(releaseData) {
        if (releaseData) latestReleaseData = releaseData;
        const modal = documentRef.getElementById('modal-update');
        const tag = documentRef.getElementById('update-tag');
        const date = documentRef.getElementById('update-date');
        const changelog = documentRef.getElementById('update-changelog-content');
        const settingsBtn = documentRef.getElementById('btn-settings');
        const releases = normalizeReleaseList(releaseData);
        const latestRelease = releases[0] || releaseData;

        if (tag) tag.textContent = getReleaseTagName(latestRelease);
        if (date) date.textContent = formatReleaseDate(latestRelease?.published_at);

        if (changelog) {
            renderReleaseChangelogs(changelog, releaseData);
        }

        if (settingsBtn) settingsBtn.classList.add('has-update');
        modal?.classList.remove('hidden');
        modal?.classList.add('active');

        const btnDownload = documentRef.getElementById('btn-update-download');
        const btnBackup = documentRef.getElementById('btn-update-backup');
        const btnCancel = documentRef.getElementById('btn-update-cancel');

        if (btnDownload) {
            btnDownload.onclick = () => {
                downloadLatestUpdate(releaseData);
            };
        }
        if (btnCancel) {
            btnCancel.onclick = () => {
                cancelUpdateDownload();
            };
        }
        syncUpdateDownloadControls();

        if (btnBackup) {
            btnBackup.onclick = () => {
                exportWorkflow();
                showToast('当前工作流备份已导出，请仍手动备份 workflows 文件夹', 'success', 5000);
            };
        }
    }

    function showUpdateCanvasNotice(releaseData) {
        if (releaseData) latestReleaseData = releaseData;
        const settingsBtn = documentRef.getElementById('btn-settings');

        if (settingsBtn) settingsBtn.classList.add('has-update');
        floatingNoticesApi?.upsertNotice({
            id: 'update-canvas',
            elementId: 'update-canvas-notice',
            priority: 30,
            className: 'update-canvas-notice',
            role: 'alert',
            icon: '↑',
            title: ['发现新版本 ', { tag: 'span', text: releaseData.tag_name || '' }],
            meta: ['当前版本 ', { tag: 'span', text: appVersion }],
            actions: [
                {
                    id: 'btn-update-canvas-details',
                    label: '更新通知',
                    onClick: () => showUpdateModal(releaseData)
                },
                {
                    id: 'btn-update-canvas-download',
                    label: '下载更新',
                    onClick: () => {
                        downloadLatestUpdate(releaseData);
                    }
                }
            ]
        });
    }

    function hideUpdateCanvasNotice() {
        floatingNoticesApi?.hideNotice('update-canvas');
        documentRef.getElementById('btn-settings')?.classList.remove('has-update');
    }

    function setUpdateError(message) {
        localStorageRef.setItem('cainflow_update_status', 'error');
        localStorageRef.setItem('cainflow_update_error', message || '检查更新失败');
    }

    function clearUpdateError() {
        localStorageRef.removeItem('cainflow_update_error');
    }

    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
        if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
        if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${value} B`;
    }

    function formatSpeed(bytesPerSecond) {
        return `${formatBytes(bytesPerSecond)}/s`;
    }

    function clampPercent(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return null;
        return Math.max(0, Math.min(100, number));
    }

    function getDownloadProgressPercent(snapshot) {
        const explicitPercent = clampPercent(snapshot?.percent);
        if (explicitPercent !== null) return explicitPercent;

        const downloaded = Number(snapshot?.downloadedBytes) || 0;
        const total = Number(snapshot?.totalBytes) || 0;
        if (downloaded >= 0 && total > 0) {
            return Math.max(0, Math.min(100, (downloaded / total) * 100));
        }
        return null;
    }

    function getStoredDownloadSnapshotPayload(snapshot) {
        if (!snapshot) return null;
        return {
            status: snapshot.status || '',
            message: snapshot.message || '',
            downloadedBytes: Number(snapshot.downloadedBytes) || 0,
            totalBytes: Number(snapshot.totalBytes) || 0,
            speedBytesPerSecond: Number(snapshot.speedBytesPerSecond) || 0,
            percent: getDownloadProgressPercent(snapshot)
        };
    }

    function getDownloadSnapshotText(snapshot) {
        if (!snapshot) return '';
        const message = snapshot.message || '';
        if (snapshot.status === 'downloading') {
            const downloaded = formatBytes(snapshot.downloadedBytes || 0);
            const total = snapshot.totalBytes ? formatBytes(snapshot.totalBytes) : '未知大小';
            const speed = formatSpeed(snapshot.speedBytesPerSecond || 0);
            const percent = Number.isFinite(snapshot.percent) ? `${snapshot.percent}%` : '';
            return `正在下载更新：${percent ? `${percent}，` : ''}${downloaded} / ${total}，${speed}`;
        }
        if (snapshot.status === 'canceling') return message || '正在取消下载并清理临时文件...';
        return message || '';
    }

    function getDownloadProgressTitle(status, message = '') {
        if (status === 'completed') return '下载完成';
        if (status === 'downloading') return '正在下载更新';
        if (status === 'proxy_testing') return '正在测试代理';
        if (status === 'proxy_switching') return '正在切换代理';
        return message || '正在准备更新';
    }

    function setStoredDownloadText(message = '') {
        if (message) localStorageRef.setItem(updateDownloadTextKey, message);
        else localStorageRef.removeItem(updateDownloadTextKey);
    }

    function setStoredDownloadSnapshot(snapshot = null) {
        const payload = getStoredDownloadSnapshotPayload(snapshot);
        if (payload) localStorageRef.setItem(updateDownloadSnapshotKey, JSON.stringify(payload));
        else localStorageRef.removeItem(updateDownloadSnapshotKey);
    }

    function createUpdateDownloadProgressElement(snapshot, message) {
        const wrapper = documentRef.createElement('div');
        wrapper.className = 'update-download-progress';
        const status = snapshot?.status || '';
        const isDownloadLike = status === 'downloading' || status === 'completed';

        const topRow = documentRef.createElement('div');
        topRow.className = 'update-download-progress__row';

        const title = documentRef.createElement('span');
        title.className = 'update-download-progress__title';
        title.textContent = getDownloadProgressTitle(status, message);
        topRow.appendChild(title);

        const percent = getDownloadProgressPercent(snapshot);
        const percentText = documentRef.createElement('span');
        percentText.className = 'update-download-progress__percent';
        percentText.textContent = percent === null ? '计算中' : `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
        topRow.appendChild(percentText);
        wrapper.appendChild(topRow);

        const track = documentRef.createElement('div');
        track.className = 'update-download-progress__track';
        const bar = documentRef.createElement('div');
        bar.className = 'update-download-progress__bar';
        if (percent === null) {
            track.classList.add('is-indeterminate');
        } else {
            bar.style.width = `${percent}%`;
        }
        track.appendChild(bar);
        wrapper.appendChild(track);

        const detailRow = documentRef.createElement('div');
        detailRow.className = 'update-download-progress__detail';

        const downloaded = formatBytes(snapshot?.downloadedBytes || 0);
        const total = snapshot?.totalBytes ? formatBytes(snapshot.totalBytes) : '未知大小';
        const sizeText = documentRef.createElement('span');
        sizeText.textContent = isDownloadLike ? `${downloaded} / ${total}` : (message || '');
        detailRow.appendChild(sizeText);

        const speedText = documentRef.createElement('span');
        const speed = Number(snapshot?.speedBytesPerSecond) || 0;
        speedText.textContent = status === 'completed'
            ? '已完成'
            : (status === 'downloading'
            ? `速度：${speed > 0 ? formatSpeed(speed) : '等待数据'}`
            : '');
        detailRow.appendChild(speedText);
        wrapper.appendChild(detailRow);

        return wrapper;
    }

    function shouldRenderDownloadProgress(snapshot) {
        return snapshot && activeDownloadStatuses.has(snapshot.status || '');
    }

    function removeUpdateDownloadToast() {
        if (!updateDownloadToast) return;
        updateDownloadToast.remove();
        updateDownloadToast = null;
    }

    function renderUpdateDownloadToast(snapshot, message) {
        if (!shouldRenderDownloadProgress(snapshot)) {
            if (!updateDownloadInProgress) removeUpdateDownloadToast();
            return;
        }

        const container = getToastContainer();
        if (!container) return;

        if (!updateDownloadToast || !container.contains(updateDownloadToast)) {
            updateDownloadToast = documentRef.createElement('div');
            updateDownloadToast.className = 'toast info update-download-toast';
            updateDownloadToast.setAttribute('role', 'status');
            updateDownloadToast.setAttribute('aria-live', 'polite');
            container.appendChild(updateDownloadToast);
        }

        updateDownloadToast.textContent = '';
        updateDownloadToast.classList.toggle('is-canceling', snapshot.status === 'canceling');

        const header = documentRef.createElement('div');
        header.className = 'update-download-toast__header';

        const titleWrap = documentRef.createElement('div');
        titleWrap.className = 'update-download-toast__title-wrap';

        const title = documentRef.createElement('div');
        title.className = 'update-download-toast__title';
        title.textContent = 'CainFlow 在线更新';
        titleWrap.appendChild(title);

        const subtitle = documentRef.createElement('div');
        subtitle.className = 'update-download-toast__subtitle';
        subtitle.textContent = message || '正在下载更新...';
        titleWrap.appendChild(subtitle);

        header.appendChild(titleWrap);

        const cancelButton = documentRef.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'update-download-toast__cancel';
        cancelButton.textContent = snapshot.status === 'canceling' ? '取消中' : '取消';
        cancelButton.disabled = snapshot.status === 'canceling';
        cancelButton.onclick = () => {
            cancelUpdateDownload();
        };
        header.appendChild(cancelButton);

        updateDownloadToast.appendChild(header);

        const progress = createUpdateDownloadProgressElement(snapshot, message);
        progress.classList.add('update-download-progress--toast');
        updateDownloadToast.appendChild(progress);
    }

    function getCompletedDownloadSnapshot(snapshot = {}, message = '') {
        const result = snapshot.result || {};
        const downloadedBytes = Number(snapshot.downloadedBytes || result.downloadedBytes || 0);
        const totalBytes = Number(snapshot.totalBytes || result.totalBytes || downloadedBytes || 0);
        return {
            ...snapshot,
            status: 'completed',
            message,
            downloadedBytes,
            totalBytes: totalBytes || downloadedBytes,
            speedBytesPerSecond: 0,
            percent: 100
        };
    }

    function renderCompletedUpdateDownloadToast(snapshot, message) {
        const container = getToastContainer();
        if (!container) return;
        const finalSnapshot = getCompletedDownloadSnapshot(snapshot, message);

        if (!updateDownloadToast || !container.contains(updateDownloadToast)) {
            updateDownloadToast = documentRef.createElement('div');
            container.appendChild(updateDownloadToast);
        }

        updateDownloadToast.className = 'toast success update-download-toast is-completed';
        updateDownloadToast.setAttribute('role', 'status');
        updateDownloadToast.setAttribute('aria-live', 'polite');
        updateDownloadToast.textContent = '';

        const header = documentRef.createElement('div');
        header.className = 'update-download-toast__header';

        const titleWrap = documentRef.createElement('div');
        titleWrap.className = 'update-download-toast__title-wrap';

        const title = documentRef.createElement('div');
        title.className = 'update-download-toast__title';
        title.textContent = 'CainFlow 在线更新';
        titleWrap.appendChild(title);

        const subtitle = documentRef.createElement('div');
        subtitle.className = 'update-download-toast__subtitle';
        subtitle.textContent = message || '下载完成，请重启 CainFlow 主程序。';
        titleWrap.appendChild(subtitle);

        header.appendChild(titleWrap);
        updateDownloadToast.appendChild(header);

        const progress = createUpdateDownloadProgressElement(finalSnapshot, message);
        progress.classList.add('update-download-progress--toast');
        updateDownloadToast.appendChild(progress);

        setTimeoutImpl(removeUpdateDownloadToast, updateDownloadTerminalToastDelayMs);
    }

    function removeUpdateResultDialog() {
        documentRef.getElementById('modal-update-result')?.remove();
    }

    function showUpdateResultDialog({ title, message, type = 'success' }) {
        removeUpdateResultDialog();

        const overlay = documentRef.createElement('div');
        overlay.id = 'modal-update-result';
        overlay.className = 'modal-overlay active';

        const panel = documentRef.createElement('div');
        panel.className = 'modal-panel update-modal-panel';
        panel.style.maxWidth = '520px';

        const header = documentRef.createElement('div');
        header.className = 'modal-header';

        const heading = documentRef.createElement('h2');
        heading.textContent = title || '在线更新';
        header.appendChild(heading);

        const closeButton = documentRef.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-close-btn';
        closeButton.textContent = '×';
        closeButton.onclick = removeUpdateResultDialog;
        header.appendChild(closeButton);
        panel.appendChild(header);

        const body = documentRef.createElement('div');
        body.className = 'modal-body';

        const status = documentRef.createElement('div');
        status.className = `update-download-status ${type}`;
        status.style.marginTop = '0';
        status.textContent = message || '';
        body.appendChild(status);
        panel.appendChild(body);

        const footer = documentRef.createElement('div');
        footer.className = 'modal-footer';
        footer.style.cssText = 'padding: 16px 24px; display: flex; gap: 12px; justify-content: flex-end;';

        const okButton = documentRef.createElement('button');
        okButton.type = 'button';
        okButton.className = 'btn btn-primary';
        okButton.textContent = '我知道了';
        okButton.onclick = removeUpdateResultDialog;
        footer.appendChild(okButton);
        panel.appendChild(footer);

        overlay.appendChild(panel);
        documentRef.body?.appendChild(overlay);
        okButton.focus?.();
    }

    function getUpdateCompletionDialog(snapshot = {}, fallbackMessage = '') {
        const result = snapshot.result || {};
        if (result.applied === true) {
            return {
                title: '更新已覆盖成功',
                message: result.message || fallbackMessage || 'CainFlow 主程序已覆盖成功，请重启 CainFlow 主程序以使用新版本。',
                type: 'success'
            };
        }
        if (result.replacementPending) {
            return {
                title: '更新已下载，等待覆盖',
                message: result.message || fallbackMessage || '当前 CainFlow 主程序仍在运行，关闭当前程序后会自动覆盖；请随后重新启动 CainFlow 主程序。',
                type: 'info'
            };
        }
        return {
            title: '更新已完成',
            message: fallbackMessage || '更新已完成，请重启 CainFlow 主程序。',
            type: 'success'
        };
    }

    function notifyUpdateDownloadCompleted(jobId, snapshot, message) {
        if (handledTerminalUpdateJobId === jobId) return;
        handledTerminalUpdateJobId = jobId;

        setTimeoutImpl(() => {
            const dialog = getUpdateCompletionDialog(snapshot, message);
            showToast(dialog.message, dialog.type === 'info' ? 'info' : 'success', 12000);
            showUpdateResultDialog(dialog);
        }, updateDownloadCompletionPromptDelayMs);
    }

    function notifyUpdateDownloadFailed(jobId, message) {
        if (handledTerminalUpdateJobId === jobId) return;
        handledTerminalUpdateJobId = jobId;

        const failureMessage = message || '下载或覆盖更新失败，请稍后重试。';
        showToast(failureMessage, 'error', 9000);
        showUpdateResultDialog({
            title: '更新失败',
            message: failureMessage,
            type: 'error'
        });
    }

    function setUpdateDownloadStatus(message = '', type = 'info', snapshot = null) {
        if (snapshot) {
            renderUpdateDownloadToast(snapshot, message);
        } else if (!message && !updateDownloadInProgress) {
            removeUpdateDownloadToast();
        }

        const status = documentRef.getElementById('update-download-status');
        if (!status) return;

        if (!message) {
            status.textContent = '';
            status.className = 'update-download-status hidden';
            return;
        }

        status.textContent = '';
        status.className = `update-download-status ${type}`;
        if (shouldRenderDownloadProgress(snapshot)) {
            status.appendChild(createUpdateDownloadProgressElement(snapshot, message));
        } else {
            status.textContent = message;
        }
    }

    function syncUpdateDownloadControls() {
        const buttons = Array.from(documentRef.querySelectorAll('#btn-update-download, [data-action="download-update"]'));
        buttons.forEach((button) => {
            button.disabled = updateDownloadInProgress;
            button.textContent = updateDownloadInProgress ? '正在下载更新...' : '下载并更新';
        });

        const cancelButtons = Array.from(documentRef.querySelectorAll('#btn-update-cancel, [data-action="cancel-update"]'));
        cancelButtons.forEach((button) => {
            button.classList.toggle('hidden', !updateDownloadInProgress);
            button.disabled = localStorageRef.getItem('cainflow_update_status') === 'canceling';
            button.textContent = button.disabled ? '正在取消...' : '取消下载';
        });
    }

    async function readUpdateDownloadError(response) {
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            if (data?.detail) return `${data.error || '下载更新失败'}：${data.detail}`;
            if (data?.error) return data.error;
        } catch {
            // Ignore non-JSON error bodies.
        }
        return text || `下载更新失败：HTTP ${response.status}`;
    }

    function confirmUpdateDownload(releaseData = null) {
        const tagName = releaseData?.tag_name || localStorageRef.getItem('cainflow_update_version') || '最新版';
        const message = `即将从 GitHub 下载 ${tagName} 的 Release ZIP，并只覆盖 CainFlow 主程序。\n\n由于网络环境问题，下载速度可能不稳定；下载和替换期间请不要关闭 CainFlow。\n\n是否继续？`;
        if (typeof windowRef.confirm === 'function') {
            return windowRef.confirm(message);
        }
        return true;
    }

    async function downloadLatestUpdate(releaseData = null) {
        if (releaseData) latestReleaseData = releaseData;
        const activeRelease = releaseData || latestReleaseData;

        if (updateDownloadInProgress) {
            showToast('更新正在下载中，请稍候...', 'info', 4000);
            return;
        }

        if (!confirmUpdateDownload(activeRelease)) return;

        updateDownloadInProgress = true;
        activeUpdateJobId = '';
        handledTerminalUpdateJobId = '';
        localStorageRef.setItem('cainflow_update_status', 'downloading');
        clearUpdateError();
        const initialSnapshot = {
            status: 'starting',
            message: '正在连接 GitHub，下载速度会在开始传输后显示...',
            downloadedBytes: 0,
            totalBytes: 0,
            speedBytesPerSecond: 0,
            percent: null
        };
        setStoredDownloadText(initialSnapshot.message);
        setStoredDownloadSnapshot(initialSnapshot);
        setUpdateDownloadStatus(initialSnapshot.message, 'info', initialSnapshot);
        syncUpdateDownloadControls();
        renderGeneralSettings();
        showToast('正在从 GitHub 下载更新，网络环境不同速度可能不稳定...', 'info', 8000);

        try {
            const response = await fetchImpl('/api/update/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repo: githubRepo,
                    tagName: activeRelease?.tag_name || ''
                })
            });

            if (!response.ok) {
                throw new Error(await readUpdateDownloadError(response));
            }

            const snapshot = await response.json();
            if (snapshot?.id) activeUpdateJobId = snapshot.id;
            applyUpdateDownloadSnapshot(snapshot);
            scheduleUpdateDownloadPoll();
        } catch (error) {
            const message = error?.message || '下载更新失败，请稍后重试';
            updateDownloadInProgress = false;
            setUpdateError(message);
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            removeUpdateDownloadToast();
            setUpdateDownloadStatus(message, 'error');
            showToast(message, 'error', 9000);
            renderGeneralSettings();
            syncUpdateDownloadControls();
        }
    }

    async function cancelUpdateDownload() {
        if (!updateDownloadInProgress) {
            showToast('当前没有正在下载的更新', 'info', 3000);
            return;
        }

        localStorageRef.setItem('cainflow_update_status', 'canceling');
        const cancelSnapshot = {
            status: 'canceling',
            message: '正在取消下载并清理临时文件...',
            downloadedBytes: 0,
            totalBytes: 0,
            speedBytesPerSecond: 0,
            percent: null
        };
        setStoredDownloadText(cancelSnapshot.message);
        setStoredDownloadSnapshot(cancelSnapshot);
        setUpdateDownloadStatus(cancelSnapshot.message, 'info', cancelSnapshot);
        renderGeneralSettings();
        syncUpdateDownloadControls();

        try {
            const response = await fetchImpl('/api/update/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: activeUpdateJobId })
            });
            const snapshot = await response.json();
            if (!response.ok) throw new Error(snapshot?.error || '取消更新下载失败');
            applyUpdateDownloadSnapshot(snapshot);
            scheduleUpdateDownloadPoll(400);
        } catch (error) {
            const message = error?.message || '取消更新下载失败';
            showToast(message, 'error', 6000);
            setUpdateDownloadStatus(message, 'error');
        }
    }

    function sendCancelUpdateDownloadOnPageLeave() {
        if (!updateDownloadInProgress) return false;

        const payload = JSON.stringify({
            jobId: activeUpdateJobId,
            reason: 'page_leave'
        });

        try {
            const navigatorRef = windowRef.navigator;
            if (navigatorRef?.sendBeacon) {
                const body = typeof windowRef.Blob === 'function'
                    ? new windowRef.Blob([payload], { type: 'application/json' })
                    : payload;
                if (navigatorRef.sendBeacon('/api/update/cancel', body)) {
                    return true;
                }
            }
        } catch {
            // Fall through to keepalive fetch.
        }

        try {
            fetchImpl('/api/update/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).catch(() => {});
            return true;
        } catch {
            return false;
        }
    }

    function handleUpdateBeforeUnload(event) {
        if (!updateDownloadInProgress) return undefined;
        event.preventDefault();
        event.returnValue = '';
        return '';
    }

    function handleUpdatePageHide() {
        if (!updateDownloadInProgress) return;
        localStorageRef.setItem('cainflow_update_status', 'canceling');
        setStoredDownloadText('页面已关闭，正在取消下载并清理临时文件...');
        setStoredDownloadSnapshot({
            status: 'canceling',
            message: '页面已关闭，正在取消下载并清理临时文件...',
            downloadedBytes: 0,
            totalBytes: 0,
            speedBytesPerSecond: 0,
            percent: null
        });
        sendCancelUpdateDownloadOnPageLeave();
        clearUpdateDownloadPollTimer();
    }

    function initUpdateDownloadWindowGuards() {
        if (!windowRef?.addEventListener) return;
        windowRef.addEventListener('beforeunload', handleUpdateBeforeUnload);
        windowRef.addEventListener('pagehide', handleUpdatePageHide);
    }

    async function syncExistingUpdateDownloadJob() {
        const storedStatus = localStorageRef.getItem('cainflow_update_status') || '';
        if (storedStatus !== 'downloading' && storedStatus !== 'canceling') return;

        try {
            const response = await fetchImpl('/api/update/status');
            const snapshot = await response.json();
            if (!response.ok) throw new Error(snapshot?.error || '读取更新下载状态失败');

            if (snapshot?.id) activeUpdateJobId = snapshot.id;
            applyUpdateDownloadSnapshot(snapshot);
            if (activeDownloadStatuses.has(snapshot?.status)) {
                scheduleUpdateDownloadPoll();
            }
        } catch {
            updateDownloadInProgress = false;
            activeUpdateJobId = '';
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            const latestVersion = localStorageRef.getItem('cainflow_update_version');
            localStorageRef.setItem('cainflow_update_status', latestVersion ? 'new_version' : 'unknown');
            renderGeneralSettings();
            syncUpdateDownloadControls();
        }
    }

    function clearUpdateDownloadPollTimer() {
        if (updateDownloadPollTimer !== null) {
            clearTimeoutImpl(updateDownloadPollTimer);
            updateDownloadPollTimer = null;
        }
    }

    function scheduleUpdateDownloadPoll(delayMs = updateDownloadPollIntervalMs) {
        clearUpdateDownloadPollTimer();
        if (!updateDownloadInProgress || !activeUpdateJobId) return;
        updateDownloadPollTimer = setTimeoutImpl(pollUpdateDownloadStatus, delayMs);
    }

    async function pollUpdateDownloadStatus() {
        if (!activeUpdateJobId) return;
        try {
            const response = await fetchImpl(`/api/update/status?jobId=${encodeURIComponent(activeUpdateJobId)}`);
            const snapshot = await response.json();
            if (!response.ok) throw new Error(snapshot?.error || '读取更新下载状态失败');
            applyUpdateDownloadSnapshot(snapshot);
            scheduleUpdateDownloadPoll();
        } catch (error) {
            const message = error?.message || '读取更新下载状态失败';
            updateDownloadInProgress = false;
            setUpdateError(message);
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            removeUpdateDownloadToast();
            setUpdateDownloadStatus(message, 'error');
            showToast(message, 'error', 7000);
            renderGeneralSettings();
            syncUpdateDownloadControls();
        }
    }

    function applyUpdateDownloadSnapshot(snapshot = {}) {
        const status = snapshot.status || 'idle';
        const jobId = snapshot.id || activeUpdateJobId || '';
        if (jobId) activeUpdateJobId = jobId;

        if (activeDownloadStatuses.has(status)) {
            updateDownloadInProgress = true;
            localStorageRef.setItem('cainflow_update_status', status === 'canceling' ? 'canceling' : 'downloading');
            const text = getDownloadSnapshotText(snapshot) || '正在下载更新...';
            setStoredDownloadText(text);
            setStoredDownloadSnapshot(snapshot);
            setUpdateDownloadStatus(text, 'info', snapshot);
            renderGeneralSettings();
            syncUpdateDownloadControls();
            return;
        }

        updateDownloadInProgress = false;
        clearUpdateDownloadPollTimer();
        syncUpdateDownloadControls();

        if (status === 'completed') {
            const result = snapshot.result || {};
            const successMessage = snapshot.message || result.message || '更新已完成，请重启 CainFlow 主程序。';
            renderCompletedUpdateDownloadToast(snapshot, successMessage);
            if (result.tagName) localStorageRef.setItem('cainflow_update_version', result.tagName);
            localStorageRef.setItem('cainflow_update_status', 'downloaded');
            clearUpdateError();
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(successMessage, 'success');
            renderGeneralSettings();
            notifyUpdateDownloadCompleted(jobId, snapshot, successMessage);
            return;
        }

        if (status === 'canceled') {
            removeUpdateDownloadToast();
            const message = snapshot.message || '下载已取消，未完成的临时文件已删除。';
            const latestVersion = localStorageRef.getItem('cainflow_update_version');
            localStorageRef.setItem('cainflow_update_status', latestVersion ? 'new_version' : 'unknown');
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(message, 'info');
            renderGeneralSettings();
            if (handledTerminalUpdateJobId !== jobId) {
                handledTerminalUpdateJobId = jobId;
                showToast(message, 'info', 6000);
            }
            return;
        }

        if (status === 'error') {
            removeUpdateDownloadToast();
            const message = snapshot.message || snapshot.error || '下载更新失败，请稍后重试';
            setUpdateError(message);
            setStoredDownloadText('');
            setStoredDownloadSnapshot(null);
            setUpdateDownloadStatus(message, 'error');
            renderGeneralSettings();
            notifyUpdateDownloadFailed(jobId, message);
            return;
        }

        removeUpdateDownloadToast();
        setStoredDownloadText('');
        setStoredDownloadSnapshot(null);
        if (localStorageRef.getItem('cainflow_update_status') === 'downloading' || localStorageRef.getItem('cainflow_update_status') === 'canceling') {
            const latestVersion = localStorageRef.getItem('cainflow_update_version');
            localStorageRef.setItem('cainflow_update_status', latestVersion ? 'new_version' : 'unknown');
        }
        renderGeneralSettings();
    }

    function getUpdateFailureMessage(error, response = null) {
        if (error?.name === 'AbortError') {
            return '检查更新超时，请稍后重试';
        }
        if (response) {
            const sourceName = response.updateSourceName || 'GitHub 更新源';
            return `检查更新失败：${sourceName} 返回 ${response.status} ${response.statusText || '响应异常'}`;
        }
        if (error?.message) {
            return `检查更新失败：${error.message}`;
        }
        return '检查更新失败，请检查网络连接或代理设置';
    }

    function parseUpdateErrorBody(text) {
        if (!text) return {};
        try {
            const json = JSON.parse(text);
            return {
                message: json?.message || json?.error?.message || '',
                documentationUrl: json?.documentation_url || ''
            };
        } catch {
            return { message: text.trim() };
        }
    }

    function formatGithubUpdateErrorMessage(status, body, response = null) {
        const text = typeof body === 'string' ? body.trim() : '';
        const { message, documentationUrl } = parseUpdateErrorBody(text);
        const normalized = `${message}\n${text}`.toLowerCase();
        const statusText = response?.statusText || '响应异常';
        const sourceName = response?.updateSourceName || 'GitHub 更新源';
        const prefix = `检查更新失败：${sourceName} 返回 ${status} ${statusText}`;

        if (
            status === 429 ||
            normalized.includes('rate limit') ||
            normalized.includes('too many requests') ||
            normalized.includes('secondary rate limit') ||
            normalized.includes('api rate limit exceeded')
        ) {
            return '检查更新失败：GitHub API 访问频率受限，请稍后再试，或在设置中启用可访问 GitHub 的代理后重试。';
        }

        if (status === 404) {
            return `检查更新失败：未找到 GitHub Release 信息，请确认仓库 ${githubRepo} 是否可访问。`;
        }

        if (status === 401 || status === 403) {
            return `${prefix}。当前可能无法访问该仓库或请求被 GitHub 拒绝，请检查网络、代理或仓库访问权限。`;
        }

        if (status >= 500) {
            return `${prefix}。GitHub 或当前代理服务暂时不可用，请稍后重试。`;
        }

        const detail = message || text.substring(0, 100);
        const docHint = documentationUrl ? ` (${documentationUrl})` : '';
        return detail ? `${prefix}: ${detail}${docHint}` : prefix;
    }

    function getXmlText(parent, selector) {
        const node = parent?.querySelector?.(selector);
        return node?.textContent?.trim() || '';
    }

    function parseGithubReleaseFeed(xmlText) {
        if (!xmlText || typeof windowRef.DOMParser !== 'function') return null;
        const doc = new windowRef.DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.querySelector('parsererror')) return null;

        const entries = Array.from(doc.querySelectorAll('entry'));
        if (entries.length === 0) return null;

        const releases = entries.map((entry) => {
            const title = getXmlText(entry, 'title');
            const id = getXmlText(entry, 'id');
            const link = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link[href]');
            const href = link?.getAttribute('href') || '';
            const tagFromUrl = href.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
            const tagFromId = id.match(/\/releases\/tag\/([^/?#]+)/)?.[1];
            const tagName = decodeURIComponent(tagFromUrl || tagFromId || title || '').trim();

            if (!tagName) return null;

            return {
                tag_name: tagName,
                published_at: getXmlText(entry, 'published') || getXmlText(entry, 'updated') || new Date().toISOString(),
                body: getXmlText(entry, 'content') || getXmlText(entry, 'summary') || '',
                html_url: href || `https://github.com/${githubRepo}/releases/tag/${encodeURIComponent(tagName)}`,
                source: 'github_releases_feed'
            };
        }).filter(Boolean);

        if (releases.length === 0) return null;
        return {
            ...releases[0],
            releaseHistory: releases
        };
    }

    function parseGithubReleasePage(htmlText) {
        const text = String(htmlText || '');
        if (!text) return null;

        const releaseLinks = [];
        const linkPattern = new RegExp(`href=["']/${githubRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/tag/([^"'?#]+)`, 'gi');
        let match;
        while ((match = linkPattern.exec(text)) !== null) {
            const tagName = decodeURIComponent(match[1] || '').trim();
            if (tagName && !releaseLinks.includes(tagName)) {
                releaseLinks.push(tagName);
            }
        }

        if (releaseLinks.length === 0) {
            const metaMatch = text.match(/<meta[^>]+property=["']og:url["'][^>]+content=["'][^"']+\/releases\/tag\/([^"'?#]+)["']/i);
            const tagName = decodeURIComponent(metaMatch?.[1] || '').trim();
            if (tagName) releaseLinks.push(tagName);
        }

        if (releaseLinks.length === 0) return null;

        const releases = releaseLinks.map((tagName) => ({
            tag_name: tagName,
            name: tagName,
            published_at: new Date().toISOString(),
            body: '',
            html_url: `https://github.com/${githubRepo}/releases/tag/${encodeURIComponent(tagName)}`,
            source: 'github_releases_page'
        }));

        return {
            ...releases[0],
            releaseHistory: releases
        };
    }

    function applyProxyOverrideHeaders(headers, proxyOverride = null) {
        if (!proxyOverride) return headers;
        return {
            ...headers,
            'x-proxy-enabled': 'true',
            'x-proxy-host': proxyOverride.ip || proxyOverride.host || '127.0.0.1',
            'x-proxy-port': proxyOverride.port || '7890'
        };
    }

    function getConfiguredProxyFromHeaders() {
        const headers = getProxyHeaders('https://www.google.com/generate_204', 'HEAD');
        const host = headers['x-proxy-host'] || '127.0.0.1';
        const port = headers['x-proxy-port'] || '';
        return port ? { ip: host, port, source: '当前代理设置' } : null;
    }

    async function testUpdateCheckProxy(proxy) {
        if (!proxy?.port) return null;
        try {
            const response = await fetchImpl('/api/test_proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip: proxy.ip || proxy.host || '127.0.0.1', port: proxy.port })
            });
            if (!response.ok) return null;
            const data = await response.json().catch(() => ({}));
            return {
                ip: proxy.ip || proxy.host || '127.0.0.1',
                port: proxy.port,
                source: proxy.source || '代理',
                latency: Number(data?.latency) || 0
            };
        } catch {
            return null;
        }
    }

    async function resolveUpdateCheckProxy() {
        const configuredProxy = await testUpdateCheckProxy(getConfiguredProxyFromHeaders());
        if (configuredProxy) return configuredProxy;

        try {
            const response = await fetchImpl('/api/detect_proxy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}'
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data?.success || !data?.proxy) return null;
            const detectedProxy = {
                ip: data.proxy.ip || '127.0.0.1',
                port: data.proxy.port || '',
                source: data.source || '自动检测代理',
                latency: Number(data.latency) || 0
            };
            return testUpdateCheckProxy(detectedProxy);
        } catch {
            return null;
        }
    }

    function isUpdateCheckTimeoutError(error) {
        if (error?.name === 'AbortError') return true;
        if (error?.isUpdateHttpError && error.status === 504) return true;
        const message = String(error?.message || error?.body || error || '').toLowerCase();
        return message.includes('timeout') || message.includes('timed out') || message.includes('超时');
    }

    async function fetchProxyText(url, signal, accept = '', proxyOverride = null, sourceName = '') {
        const extraHeaders = accept ? { Accept: accept } : {};
        const response = await fetchImpl('/proxy', {
            method: 'POST',
            headers: applyProxyOverrideHeaders(getProxyHeaders(url, 'GET', extraHeaders), proxyOverride),
            signal
        });
        const text = await response.text();
        if (!response.ok) {
            response.updateSourceName = sourceName;
            throw {
                isUpdateHttpError: true,
                status: response.status,
                response,
                body: text
            };
        }
        return text;
    }

    async function fetchLatestReleaseFromFeed(signal, proxyOverride = null) {
        const url = `https://github.com/${githubRepo}/releases.atom`;
        const text = await fetchProxyText(url, signal, 'application/atom+xml, application/xml, text/xml', proxyOverride, 'GitHub Releases Feed');
        const releaseData = parseGithubReleaseFeed(text);
        if (!releaseData) {
            throw new Error('GitHub Releases Feed 响应解析失败');
        }
        return releaseData;
    }

    async function fetchLatestReleaseFromPage(signal, proxyOverride = null) {
        const url = `https://github.com/${githubRepo}/releases`;
        const text = await fetchProxyText(url, signal, 'text/html,application/xhtml+xml', proxyOverride, 'GitHub Releases 页面');
        const releaseData = parseGithubReleasePage(text);
        if (!releaseData) {
            throw new Error('GitHub Releases 页面解析失败');
        }
        return releaseData;
    }

    async function fetchLatestReleaseFromApi(signal, proxyOverride = null) {
        const url = `https://api.github.com/repos/${githubRepo}/releases?per_page=20`;
        const text = await fetchProxyText(url, signal, 'application/vnd.github+json', proxyOverride, 'GitHub API');
        const data = JSON.parse(text);
        if (Array.isArray(data)) {
            if (data.length === 0) throw new Error('GitHub Release 列表为空');
            return {
                ...data[0],
                releaseHistory: data,
                source: 'github_api'
            };
        }
        return {
            ...data,
            source: data?.source || 'github_api'
        };
    }

    async function fetchLatestRelease(signal, proxyOverride = null) {
        const errors = [];
        try {
            return await fetchLatestReleaseFromFeed(signal, proxyOverride);
        } catch (feedError) {
            errors.push(feedError);
            console.warn('GitHub release feed check failed, falling back to releases page:', feedError);
        }

        try {
            return await fetchLatestReleaseFromPage(signal, proxyOverride);
        } catch (pageError) {
            errors.push(pageError);
            console.warn('GitHub release page check failed, falling back to API:', pageError);
        }

        try {
            return await fetchLatestReleaseFromApi(signal, proxyOverride);
        } catch (apiError) {
            apiError.updateCheckErrors = errors;
            throw apiError;
        }
    }

    function getToastContainer() {
        return documentRef.getElementById('toast-container');
    }

    function renderAutoCheckCountdownToast(secondsRemaining) {
        const container = getToastContainer();
        if (!container) return;

        if (!autoCheckCountdownToast || !documentRef.body?.contains(autoCheckCountdownToast)) {
            const toast = documentRef.createElement('div');
            toast.className = 'toast info';

            const icon = documentRef.createElement('span');
            icon.textContent = '[i]';

            const message = documentRef.createElement('span');
            message.className = 'update-auto-check-countdown-message';

            toast.appendChild(icon);
            toast.appendChild(message);
            container.appendChild(toast);
            autoCheckCountdownToast = toast;
        }

        const message = autoCheckCountdownToast.querySelector('.update-auto-check-countdown-message');
        if (message) {
            message.textContent = `将在 ${secondsRemaining} 秒后自动检查更新`;
        }
    }

    function dismissAutoCheckCountdownToast(delay = 0) {
        if (!autoCheckCountdownToast) return;

        const toast = autoCheckCountdownToast;
        autoCheckCountdownToast = null;

        setTimeoutImpl(() => {
            toast.style.animation = 'toast-out 0.3s ease-out forwards';
            setTimeoutImpl(() => toast.remove(), 300);
        }, delay);
    }

    function scheduleAutoUpdateCheck(options = {}) {
        const {
            delayMs = 5000,
            force = true,
            showModal = false,
            showCanvasNotification = true
        } = options;

        if (autoCheckCountdownTimer !== null) {
            clearTimeoutImpl(autoCheckCountdownTimer);
            autoCheckCountdownTimer = null;
        }
        dismissAutoCheckCountdownToast();

        if (isAutoUpdateCheckDisabled()) {
            return false;
        }

        const targetTime = Date.now() + delayMs;

        const tick = () => {
            if (isAutoUpdateCheckDisabled()) {
                autoCheckCountdownTimer = null;
                dismissAutoCheckCountdownToast();
                return;
            }

            const remainingMs = targetTime - Date.now();
            const secondsRemaining = Math.ceil(remainingMs / 1000);

            if (secondsRemaining > 0) {
                renderAutoCheckCountdownToast(secondsRemaining);
                autoCheckCountdownTimer = setTimeoutImpl(tick, Math.min(1000, Math.max(remainingMs, 0)));
                return;
            }

            autoCheckCountdownTimer = null;
            if (autoCheckCountdownToast) {
                const message = autoCheckCountdownToast.querySelector('.update-auto-check-countdown-message');
                if (message) message.textContent = '正在自动检查更新...';
            }
            Promise.resolve(checkUpdate(false, {
                force,
                showModal,
                showCanvasNotification,
                showProgressToast: false
            })).finally(() => dismissAutoCheckCountdownToast(1200));
        };

        tick();
        return true;
    }

    async function checkUpdate(isManual = false, options = {}) {
        const {
            force = false,
            showModal = isManual,
            showCanvasNotification = true,
            showProgressToast = true
        } = options;

        const checkInterval = 6 * 60 * 60 * 1000;
        const now = Date.now();
        const lastCheck = localStorageRef.getItem('cainflow_last_update_check');

        if (!force && !isManual && lastCheck && (now - parseInt(lastCheck, 10)) < checkInterval) {
            return;
        }

        dismissUpdateCheckProgressToast();
        if (showProgressToast) {
            updateCheckProgressToast = showToast(isManual ? '正在检查更新...' : '系统正在自动检查更新...', 'info', 0) || null;
        }
        localStorageRef.setItem('cainflow_update_status', 'checking');
        clearUpdateError();
        renderGeneralSettings();

        localStorageRef.setItem('cainflow_last_update_check', now.toString());

        const applyUpdateCheckResult = (data) => {
            latestReleaseData = data;
            const latestVersion = data.tag_name;
            localStorageRef.setItem('cainflow_update_version', latestVersion || '');
            const comparison = compareVersions(latestVersion, appVersion);

            if (comparison > 0) {
                localStorageRef.setItem('cainflow_update_status', 'new_version');
                clearUpdateError();
                if (showCanvasNotification) showUpdateCanvasNotice(data);
                if (showModal) showUpdateModal(data);
                dismissUpdateCheckProgressToast();
                showToast(`发现新版本 ${latestVersion || ''}`, 'success', 6000);
            } else {
                localStorageRef.setItem('cainflow_update_status', 'latest');
                clearUpdateError();
                hideUpdateCanvasNotice();
                dismissUpdateCheckProgressToast();
                showToast(`当前已是最新版本 (${appVersion})`, 'success', isManual ? 3000 : 4500);
            }

            renderGeneralSettings();
        };

        let timeoutId = null;
        try {
            const controller = new AbortController();
            timeoutId = setTimeoutImpl(() => controller.abort(), 10000);

            const data = await fetchLatestRelease(controller.signal);
            clearTimeoutImpl(timeoutId);
            timeoutId = null;
            applyUpdateCheckResult(data);
        } catch (e) {
            if (timeoutId !== null) clearTimeoutImpl(timeoutId);
            if (isUpdateCheckTimeoutError(e)) {
                try {
                    if (updateCheckProgressToast) {
                        updateCheckProgressToast.update('检查更新超时，正在尝试使用代理重新检查...', 'info');
                    } else {
                        updateCheckProgressToast = showToast('检查更新超时，正在尝试使用代理重新检查...', 'info', 0) || null;
                    }
                    const proxyOverride = await resolveUpdateCheckProxy();
                    if (proxyOverride) {
                        const retryController = new AbortController();
                        timeoutId = setTimeoutImpl(() => retryController.abort(), 15000);
                        const retryData = await fetchLatestRelease(retryController.signal, proxyOverride);
                        clearTimeoutImpl(timeoutId);
                        timeoutId = null;
                        applyUpdateCheckResult(retryData);
                        return;
                    }
                    dismissUpdateCheckProgressToast();
                    showToast('未找到可用代理，继续使用原检查结果。', 'warning', 5000);
                } catch (retryError) {
                    if (timeoutId !== null) {
                        clearTimeoutImpl(timeoutId);
                        timeoutId = null;
                    }
                    console.warn('Update proxy retry failed:', retryError);
                }
            }
            console.warn('Update check failed:', e);
            const msg = e?.isUpdateHttpError
                ? formatGithubUpdateErrorMessage(e.status, e.body, e.response)
                : getUpdateFailureMessage(e);
            setUpdateError(msg);
            dismissUpdateCheckProgressToast();
            showToast(msg, 'error', 6000);
            renderGeneralSettings();
        }
    }

    function checkRefreshNotice() {
        return localStorageRef.getItem(refreshNoticeDismissStorageKey) !== 'true';
    }

    function initRefreshNotice() {
        return checkRefreshNotice();
    }

    initUpdateDownloadWindowGuards();
    setTimeoutImpl(syncExistingUpdateDownloadJob, 0);

    return {
        checkUpdate,
        downloadLatestUpdate,
        cancelUpdateDownload,
        scheduleAutoUpdateCheck,
        checkRefreshNotice,
        initRefreshNotice
    };
}
