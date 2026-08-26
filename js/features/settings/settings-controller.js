/**
 * Thin facade that assembles settings submodules while preserving the public API.
 */
import { getModelProviderIds } from '../execution/provider-request-utils.js';
import { createSettingsContext } from './settings-context.js';
import { createSettingsDialogs } from './settings-dialogs.js';
import { createProviderSettings } from './provider-settings.js';
import { createModelSettings } from './model-settings.js';
import { createProxyNetworkSettings } from './proxy-network-settings.js';
import { createGeneralSettings } from './general-settings.js';
import { createBackdropDismissalGuard } from './backdrop-dismissal.js';
import { isKnownModelProtocol } from '../execution/model-protocol-registry.js';
import { createSettingsCloseCoordinator } from './settings-close-coordinator.js';

export function createSettingsControllerApi(options) {
    const { ctx, store } = createSettingsContext(options);

    let providerSettingsApi = null;
    let modelSettingsApi = null;
    let proxyNetworkSettingsApi = null;
    let generalSettingsApi = null;

    const getDeps = () => ({
        getModelProviderIds,
        getVisibleSettingsProviders: (...args) => providerSettingsApi.getVisibleSettingsProviders(...args),
        getSafeProviderName: (...args) => providerSettingsApi.getSafeProviderName(...args),
        getModelFetchProtocol: (...args) => providerSettingsApi.getModelFetchProtocol(...args),
        inferFetchedModelProtocol: (...args) => modelSettingsApi.inferFetchedModelProtocol(...args),
        modelAlreadyExists: (...args) => modelSettingsApi.modelAlreadyExists(...args),
        getFetchedModelTaskTypeLabel: (...args) => modelSettingsApi.getFetchedModelTaskTypeLabel(...args),
        getModelCompatibilityFormatLabel: (...args) => modelSettingsApi.getModelCompatibilityFormatLabel(...args),
        addFetchedModel: (...args) => modelSettingsApi.addFetchedModel(...args),
        fetchProviderModels: (...args) => modelSettingsApi.fetchProviderModels(...args),
        renderModels: (...args) => modelSettingsApi.renderModels(...args),
        updateAllNodeModelDropdowns: (...args) => modelSettingsApi.updateAllNodeModelDropdowns(...args)
    });

    const dialogs = createSettingsDialogs({ ctx, store, getDeps });
    providerSettingsApi = createProviderSettings({ ctx, store, dialogs, getDeps });
    modelSettingsApi = createModelSettings({ ctx, store, dialogs, providerSettings: providerSettingsApi, getDeps });
    proxyNetworkSettingsApi = createProxyNetworkSettings({ ctx, store, dialogs });
    generalSettingsApi = createGeneralSettings({ ctx, dialogs });

    function collapseAllConfigCards() {
        providerSettingsApi.collapseAllProviderConfigCards();
        modelSettingsApi.collapseAllModelConfigCards();
    }

    function initSettingsUI({ settingsModalApi, protocolDeveloperPanelApi }) {
        const { documentRef, settingsModal, modelsList, state, showToast, saveState, windowRef } = ctx;
        const backdropDismissal = createBackdropDismissalGuard({
            overlay: settingsModal,
            panel: settingsModal.querySelector('.modal-panel')
        });

        function activateSettingsTab(targetTab) {
            documentRef.querySelectorAll('.modal-tab-btn').forEach((button) => {
                button.classList.toggle('active', button.dataset.tab === targetTab);
            });
            documentRef.querySelectorAll('.settings-tab-pane').forEach((pane) => {
                const isTargetPane = pane.id === `settings-tab-${targetTab}`;
                pane.classList.toggle('active', isTargetPane);
                pane.hidden = !isTargetPane;
            });
        }

        const closeCoordinator = createSettingsCloseCoordinator({
            getModels: () => state.models,
            isKnownModelProtocol,
            guideIncompleteModel: (model, count) => {
                activateSettingsTab('api');
                modelSettingsApi.collapseAllModelConfigCards();
                store.modelCollapseState.set(model.id, false);
                modelSettingsApi.renderModels();
                showToast(`还有 ${count} 个模型未选择兼容格式，请完成后再关闭设置。`, 'warning', 8000);
                windowRef.requestAnimationFrame(() => {
                    const card = modelsList.querySelector(`[data-model-id="${model.id}"]`);
                    card?.scrollIntoView?.({ block: 'center' });
                    card?.querySelector?.('select[data-field="protocol"]')?.focus?.();
                });
            },
            closeTopSettingsOverlay: dialogs.closeTopSettingsOverlay,
            closeSettingsOverlays: dialogs.closeAllSettingsOverlays,
            closeSettingsModal: () => settingsModalApi.closeSettingsModal(),
            pauseNotificationAudio: () => state.notificationAudio?.pause()
        });
        const requestCloseSettings = (options) => closeCoordinator.requestCloseSettings(options);
        const handleEscape = () => closeCoordinator.handleEscape();
        windowRef.__cainflowSettingsModalApi = {
            ...settingsModalApi,
            closeSettingsModal: requestCloseSettings,
            requestCloseSettings,
            handleEscape
        };

        // 协议编辑按钮
        let protocolEditButton = null;

        documentRef.getElementById('btn-settings').addEventListener('click', (event) => {
            settingsModalApi.openSettingsModal();

            // 按住 Ctrl 键时，在设置面板底部显示协议编辑按钮
            if (event.ctrlKey && protocolDeveloperPanelApi) {
                if (!protocolEditButton) {
                    const footer = settingsModal.querySelector('.modal-footer .footer-right');
                    if (footer) {
                        protocolEditButton = documentRef.createElement('button');
                        protocolEditButton.id = 'btn-open-protocol-dev';
                        protocolEditButton.className = 'btn btn-primary btn-sm';
                        protocolEditButton.textContent = '🛠️ 协议编辑';
                        protocolEditButton.style.marginLeft = '8px';
                        protocolEditButton.addEventListener('click', () => {
                            protocolDeveloperPanelApi.openPanel();
                        });
                        footer.appendChild(protocolEditButton);
                    }
                }
                if (protocolEditButton) {
                    protocolEditButton.style.display = 'inline-block';
                }
            } else if (protocolEditButton) {
                protocolEditButton.style.display = 'none';
            }
        });
        documentRef.getElementById('settings-close').addEventListener('click', () => {
            requestCloseSettings();
        });
        settingsModal.addEventListener('pointerdown', backdropDismissal.recordPointerDown);
        settingsModal.addEventListener('click', (event) => {
            if (backdropDismissal.shouldDismiss(event)) {
                requestCloseSettings();
            }
        });

        documentRef.getElementById('btn-api-settings-help')?.addEventListener('click', dialogs.renderApiSettingsHelpDialog);
        documentRef.getElementById('settings-body')?.addEventListener('scroll', dialogs.refreshGeneralSettingsHelpPopoverPosition, { passive: true });

        documentRef.querySelectorAll('.modal-tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.classList.contains('active')) return;
                dialogs.closeAllSettingsOverlays();
                activateSettingsTab(btn.dataset.tab);
            });
        });

        documentRef.getElementById('btn-add-provider').addEventListener('click', () => {
            providerSettingsApi.addProvider();
        });

        documentRef.getElementById('btn-add-model').addEventListener('click', () => {
            modelSettingsApi.addModel();
        });
    }

    return {
        initProxyPanel: proxyNetworkSettingsApi.initProxyPanel,
        checkNetworkConnectivity: proxyNetworkSettingsApi.checkNetworkConnectivity,
        checkNetworkProxyMismatch: proxyNetworkSettingsApi.checkNetworkProxyMismatch,
        syncProxyToServer: proxyNetworkSettingsApi.syncProxyToServer,
        collapseAllConfigCards,
        renderProviders: providerSettingsApi.renderProviders,
        renderModels: modelSettingsApi.renderModels,
        playNotificationSound: generalSettingsApi.playNotificationSound,
        renderGeneralSettings: generalSettingsApi.renderGeneralSettings,
        updateImageSaveWarnings: generalSettingsApi.updateImageSaveWarnings,
        updateAllNodeModelDropdowns: modelSettingsApi.updateAllNodeModelDropdowns,
        updateCacheUsage: generalSettingsApi.updateCacheUsage,
        initSettingsUI
    };
}
