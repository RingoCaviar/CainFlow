const colors = Object.freeze({ background: '#f7f5f0', foreground: '#272523', accent: '#615349', surface: '#eae4da' });
const layouts = { hero: '通栏商品主视觉', 'image-left': '图左文右', 'image-right': '图右文左', feature: '主图配局部特写', grid: '步骤或细节网格' };
const anchors = { 'top-left': '左上', 'top-center': '上方居中', 'top-right': '右上', 'center-left': '左侧居中', center: '居中',
    'center-right': '右侧居中', 'bottom-left': '左下', 'bottom-center': '下方居中', 'bottom-right': '右下' };
const transitions = { flat: '用相同底色平接', curve: '沿共用曲线留出衔接', shared: '延续同一场景背景' };
const tones = { base: '主背景色', accent: '强调色', surface: '辅助底色' };
const heights = { short: '紧凑的信息节奏', medium: '均衡的信息节奏', tall: '主视觉有充分留白' };
const guideDefaults = Object.freeze({
    typography: '整页统一使用清晰无衬线标题和正文，标题字重较高，正文保持统一字号、行距和对齐基线。',
    motif: '在所有屏沿用相同的边距、圆角、图标线条和点缀色。',
    lighting: '同一摄影质感、光线方向、色温和阴影软硬，场景用色承接整页。',
    productConsistency: '每屏按商品参考图保持同一型号的真实结构、颜色、比例、商标和包装文字。',
    readingFlow: '先展示商品与用途，再解释核心卖点，用细节和场景佐证；沿用共同背景、版心和图文节奏。'
});
const hexColor = /^#[0-9a-f]{6}$/i;

export function getCommerceOutputAssetKey(row) {
    if (row?.detailAssetKind === 'clean') return row.detailOutputKey || null;
    return row?.assetKey;
}

export function orderCommerceOutputRows(settings) {
    const results = settings?.results || [];
    const sections = settings?.plan?.detailPage?.sections;
    if (!sections?.length) return results;
    const byShot = new Map(results.map(row => [row.shotId, row]));
    const detailOrder = new Set(sections.map(section => section.shotId));
    return [...results.filter(row => !detailOrder.has(row.shotId)), ...sections.flatMap(({ shotId }) => byShot.has(shotId) ? [byShot.get(shotId)] : [])];
}

export const COMMERCE_DETAIL_PAGE_PLAN_INSTRUCTIONS = [
    '如有详情图位，先规划一张连续阅读的详情长图，再给每屏写完整的图文设计。每屏由生图模型直接绘制成品，包含商品、场景、排版、允许的图标及已确认文案。综合商品、设计参考和整套美术风格，参考中的商品、商标和文案不属于本商品。',
    'detailPage 包含 version: 2、theme、guide 和 sections。theme 的 background、foreground、accent、surface 使用 #RRGGBB，保证文字对比度。',
    'guide 写清整页统一的 typography（标题字重、字形、字号相对层级、正文、对齐和行距）、motif（跨屏重复的图形、圆角、版心和图标）、lighting（场景、色温、材质、光线方向和阴影）、productConsistency（保持商品颜色、结构、比例和可核实视角）、readingFlow（每屏承担的叙事任务和节奏）。为本商品给出具体可复用描述。',
    'sections 按阅读顺序列出，每个已选详情图位恰好一次。每项包含 shotId、layout、anchor、transition、tone、height、composition、topEdge、bottomEdge。composition 写明商品视角、位置、大小、图文分区、局部标注和背景。topEdge 和 bottomEdge 分别写清边缘的背景色、渐变或曲线方向和版心边距。相邻屏的交界应遵循同一组颜色与形状，视线可从上一屏自然进入下一屏。首尾边缘有完整的开场和收束。',
    `layout 取 ${Object.keys(layouts).join(' / ')}，anchor 取 ${Object.keys(anchors).join(' / ')}，transition 取 ${Object.keys(transitions).join(' / ')}，tone 取 ${Object.keys(tones).join(' / ')}，height 取 ${Object.keys(heights).join(' / ')}。height 表示信息密度和留白，图位实际宽高比以输入为准。不同商品及参考图可使用不同布局组合和节奏。`,
    '图位 prompt 根据整页设计与本屏任务写场景、构图和文案位置。详情屏的 copy 是要渲染的完整准确文案，用换行组织标题、正文、卖点或步骤。生图模型按原语言绘制，勿在 prompt 中重复文字。只使用经过确认的规格与卖点。'
].join('\n');

function choice(value, allowed, fallback) {
    return typeof value === 'string' && Object.hasOwn(allowed, value) ? value : fallback;
}

function defaultSection(shot, index) {
    const layout = { 'detail-overview': 'hero', 'detail-feature': 'image-left', 'detail-closeup': 'feature', 'detail-scene': 'image-right' }[shot.id]
        || (index % 2 ? 'image-left' : 'image-right');
    return { shotId: shot.id, layout, anchor: layout === 'hero' ? 'bottom-left' : 'center-left',
        transition: index ? 'curve' : 'flat', tone: index % 2 ? 'surface' : 'base', height: layout === 'hero' ? 'tall' : 'medium',
        composition: '', topEdge: '', bottomEdge: '' };
}

function designText(value) {
    return typeof value === 'string' ? value.trim().slice(0, 400) : '';
}

export function normalizeCommerceDetailPage(raw, shots, { fallback = false } = {}) {
    const detailShots = (Array.isArray(shots) ? shots : []).filter(shot => shot?.group === 'detail' && typeof shot.id === 'string');
    if (!detailShots.length || (!fallback && (![1, 2].includes(raw?.version) || !Array.isArray(raw.sections)))) return null;

    const shotMap = new Map(detailShots.map(shot => [shot.id, shot]));
    const theme = Object.fromEntries(Object.entries(colors).map(([key, color]) => {
        const value = raw?.theme?.[key];
        return [key, typeof value === 'string' && hexColor.test(value) ? value.toLowerCase() : color];
    }));
    const guide = Object.fromEntries(Object.entries(guideDefaults).map(([key, defaultValue]) => [key, designText(raw?.guide?.[key]) || defaultValue]));

    const sections = [];
    for (const section of Array.isArray(raw?.sections) ? raw.sections : []) {
        const shot = shotMap.get(section?.shotId);
        if (!shot) continue;
        const initial = defaultSection(shot, sections.length);
        sections.push({
            shotId: shot.id,
            layout: choice(section.layout, layouts, initial.layout),
            anchor: choice(section.anchor, anchors, initial.anchor),
            transition: choice(section.transition, transitions, initial.transition),
            tone: choice(section.tone, tones, initial.tone),
            height: choice(section.height, heights, initial.height),
            composition: designText(section.composition), topEdge: designText(section.topEdge), bottomEdge: designText(section.bottomEdge)
        });
        shotMap.delete(shot.id);
    }
    for (const shot of shotMap.values()) sections.push(defaultSection(shot, sections.length));
    return { version: 2, theme, guide, sections };
}

function describeBoundary(previous, next) {
    const seam = previous.bottomEdge || next.topEdge;
    return [transitions[next.transition], `${tones[previous.tone]}过渡到${tones[next.tone]}`, seam,
        '交界使用同一颜色、线条、方向和位置，铺满宽度，不加外边距或分割线'].filter(Boolean).join('。');
}

export function describeCommerceDetailPanel(page, shotId, { includePosition = true } = {}) {
    const index = page?.sections?.findIndex(section => section.shotId === shotId) ?? -1;
    if (index < 0) return '';
    const section = page.sections[index];
    const previous = page.sections[index - 1];
    const next = page.sections[index + 1];
    const { theme, guide } = page;
    const local = [layouts[section.layout], `文案位于${anchors[section.anchor]}`, `使用${tones[section.tone]}`, heights[section.height], section.composition]
        .filter(Boolean).join('。');
    const usesDefaultColors = Object.entries(colors).every(([key, value]) => theme[key] === value);
    const colorGuide = `背景 ${theme.background}、文字 ${theme.foreground}、强调 ${theme.accent}、辅助底色 ${theme.surface}。`;
    const upperEdge = previous ? describeBoundary(previous, section) : ['完整的上缘开场，留足标题安全边距', section.topEdge].filter(Boolean).join('。');
    const lowerEdge = next ? describeBoundary(section, next) : ['完整的下缘收束，商品和文字不截断', section.bottomEdge].filter(Boolean).join('。');
    return [
        ...(includePosition ? [`连续详情页第 ${index + 1} / ${page.sections.length} 屏。直接输出这一屏的成品，画面边缘用于接续上下屏。`] : []),
        `整页共用配色：${usesDefaultColors ? '优先统一沿用已确认画面风格的颜色。风格未指定颜色时可采用' : ''}${colorGuide}`,
        `整页共用字体与层级：${guide.typography}`, `整页共用图形与版心：${guide.motif}`,
        `整页共用布光与质感：${guide.lighting}`, `跨屏商品一致性：${guide.productConsistency}`, `整页阅读节奏：${guide.readingFlow}`,
        `本屏构图：${local}。`, `上边缘：${upperEdge}。`, `下边缘：${lowerEdge}。`,
        '沿用全页版心、主色、文字层级和同一个商品型号。画面铺至边缘，不加外框或额外留白，不绘制屏号、未确认参数、说明文字或水印。'
    ].join('\n');
}
