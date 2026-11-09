# 供应商与模型卡片视觉方案

生成方式：内置 image_gen；2026-11-09。四版为供用户选择的概念图，尚未修改产品代码。
参考：.scratch/settings-clarity/implementation-002/visuals/paper-collapsed.png。

## 公共提示词

Use case: ui-mockup. Create one high-fidelity desktop software settings design concept for CainFlow, focused on provider/model CARD NAME editing. Image 1 is a reference for the existing product identity, actual content, warm paper palette and arrangement; redesign the card/name region according to the specific concept below. This is a visual proposal, not a browser screenshot to preserve pixel-for-pixel.
Composition: landscape 3:2 clean straight-on flat 2D product UI board, no device mockup, perspective, photography, marketing art or decorative effects. Main content is a close view of settings provider and model sections, with much less surrounding whitespace than the reference. Use a warm-white paper theme throughout ALL variants for fair comparison: charcoal text, warm gray boundaries, muted dark sage green primary actions. Crisp antialiased type, plausible Chinese system sans, readable at 100%, aligned 8px rhythm, compact yet comfortable rows. Distinguish the supplied layout/name treatment, not colors.
Keep functional content: section heading "供应商", upper-right "+ 添加供应商"; two rows named exactly "openai" and "6789", each with separate left six-dot reorder grip, right "获取模型列表" button and small "×" delete. Second section heading "模型", upper-right "+ 添加模型"; three rows named exactly "gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "创作模型 · 精细修图版", each with reorder grip and right "×". All names remain single-line and directly editable; title blank area collapses/expands, grip sorts, right buttons remain distinct. Do not add renamed labels, providers, status badges, model logos, nested cards, extra menus or extra rename steps.
At bottom a small well-aligned demonstration strip with three enlarged name-area examples labeled exactly "常态", "悬停", "编辑中". These examples must use THE SAME name styling as this variant, demonstrate genuine distinct state feedback, and show a text caret only in editing. The name in each sample is exactly "openai". Small state labels are outside the hit area. This is a consistent comparison board, not a collage of different design directions.
Top of board outside the UI put only the provided version number and Chinese concept title. No long explanatory copy, watermark or invented claims. Keep every control realistically scaled: 14px body type, 30px names, 30px small actions, normal 50-56px row height; the board may be rendered at 2x scale for clarity. Do not use oversized 3D panels, heavy borders, glow, gradients, neon or big empty white margins.


## 1 · 浅底名签

输出：v01.png

NAME UI: A soft tonal name field. The name sits in a quiet warm gray-beige filled rectangle, only slightly darker than the card, 6px corners, absolutely no resting stroke or underline. Content-sensitive width with room for long model names, not a full-row slab; max about 55% of row. Name typography 14px/600, comfortable compact padding and 30px hit height. On hover the fill deepens slightly; on editing a very fine dark-sage edge and caret appear. Make the field look intentionally writable, calm and integrated. Card itself is a simple 56px-high warm off-white row with a faint outer edge and 12px radius, no shadow.

## 2 · 标题直编

输出：v02.png

NAME UI: Editorial title-style inline editing. Resting name has no box, fill, or underline at all. A tiny low-contrast 12px outlined pencil immediately AFTER the full name is an always-visible editing affordance, aligned optically to the baseline, not a separate button. The text and cue form one directly editable hit area, no extra click. On hover a very faint warm-gray background wraps ONLY the title area; on editing the title gets a fine sage focus outline, with a text caret. Name looks like the card's identity first. Card is a compact 56px row with paper-white surface, a subtle hairline perimeter and 12px corners. Keep excellent alignment and minimal framing; no fancy icons except reorder and small editing cue.

## 3 · 整合编辑区

输出：v03.png

NAME UI: An integrated two-zone card header. The entire LEFT roughly 55% of each compact card is the directly editable title zone, subtly tinted warm beige edge-to-edge inside the card, with the reorder handle at its far left and name text centrally aligned vertically. The right zone stays paper-white with row actions right-aligned. Separate the zones with a very subtle 1px neutral vertical hairline, not a thick accent stripe. No nested input rectangle, no underline, no rounded name pill. At the right end of the left title zone a small permanent outline pencil indicates editing; on hover only this left region slightly deepens; on edit the left region receives a fine sage inset focus boundary and caret. 12px overall card corners, 56px overall row height. It should feel like one thoughtfully divided card, not boxes inside boxes.

## 4 · 紧凑清单

输出：v04.png

CARD AND NAME UI: Replace individually rounded cards with one flat rounded group container PER section, holding compact 50px rows, separated by subtle inset horizontal hairlines. This is a tidy editable list, not a data table with many columns. Each row has a separate reorder handle, then the name and a tiny permanent edit pencil immediately after the name, and right-aligned actions. NAME is rendered as 14px/600 readable identity text, with a discreet almost-white 30px-high editable title hit area; NO long underline and NO full input outline at rest. Hover lightly tints just the name hit area; editing reveals a short fine sage rectangular outline and caret around the name. Smooth shared 12px group corners, no per-row card nesting, no shadows. Distinctly more compact and aligned than the other concepts.

