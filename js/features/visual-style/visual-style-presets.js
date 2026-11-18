export const VISUAL_STYLE_CATEGORIES = Object.freeze({
    "commercial": "商业与产品",
    "lifestyle": "生活与自然",
    "cinema": "电影与复古",
    "illustrated": "插画与漫画",
    "painting": "绘画与手工",
    "graphic": "平面与装饰",
    "render": "三维与材质",
    "fantasy": "未来与幻想"
});

export const ADDITIONAL_VISUAL_STYLE_PRESETS = Object.freeze({
    "luxury": {
        "label": "黑金奢雅",
        "category": "commercial",
        "description": "深黑与香槟金构成低调高对比画面，窄幅轮廓光勾勒边缘，细腻哑光背景，主体居中，留白克制。"
    },
    "highkey": {
        "label": "通透高调",
        "category": "commercial",
        "description": "白色与浅灰主调，大片柔光均匀铺开，阴影轻薄，细节干净清晰，以开放留白突出主体。"
    },
    "lowkey": {
        "label": "暗调质感",
        "category": "commercial",
        "description": "炭灰背景与局部聚光，控制高光面积，强化表面纹理和明暗过渡，构图沉稳紧凑。"
    },
    "pastelstudio": {
        "label": "奶油柔彩",
        "category": "commercial",
        "description": "奶油色搭配浅粉浅蓝，柔和散射光，低反差细腻质感，圆润背景形态，轻盈错落构图。"
    },
    "monochrome": {
        "label": "单色层次",
        "category": "commercial",
        "description": "背景和环境使用同色系深浅层次，主体固有色保持准确，柔和侧光营造体积感，几何构图简洁。"
    },
    "macro": {
        "label": "微距细节",
        "category": "commercial",
        "description": "微距视觉语言，局部放大材质纹理，浅景深与柔和侧光配合，清晰焦点与虚化区域自然衔接。"
    },
    "editorialproduct": {
        "label": "杂志产品",
        "category": "commercial",
        "description": "精致商业摄影，克制的中性色和一点强调色，清晰定向光，非对称留白，画面有编辑设计的秩序感。"
    },
    "scandinavian": {
        "label": "北欧日光",
        "category": "lifestyle",
        "description": "浅木色、米白与灰绿环境，明亮窗光与轻薄阴影，天然材质，简洁舒展构图。"
    },
    "wabisabi": {
        "label": "侘寂素雅",
        "category": "lifestyle",
        "description": "灰米色与土色，柔和漫射光，粗粝纸面与石材般环境肌理，不规则留白，安静朴素。"
    },
    "japanese": {
        "label": "日系清新",
        "category": "lifestyle",
        "description": "低饱和暖白和淡绿，轻微过曝的自然光，细小柔软阴影，空气感充足，生活化松弛构图。"
    },
    "mediterranean": {
        "label": "地中海清爽",
        "category": "lifestyle",
        "description": "石灰白与海蓝环境色，清晰日照和干净投影，通透空气感，简洁拱形与水平线组织背景。"
    },
    "forest": {
        "label": "森系静谧",
        "category": "lifestyle",
        "description": "苔绿与暖棕环境色，斑驳但柔和的透光，细腻天然纹理，前后景层次舒缓。"
    },
    "coastal": {
        "label": "海岸轻盈",
        "category": "lifestyle",
        "description": "沙米与雾蓝主调，明亮柔光，淡淡反射与轻盈纹理，低对比开放构图。"
    },
    "rustic": {
        "label": "乡野质朴",
        "category": "lifestyle",
        "description": "麦色、陶土色与暖白，温暖侧窗光，木质与织物般环境肌理，朴实稳定的构图。"
    },
    "cinematic": {
        "label": "电影青橙",
        "category": "cinema",
        "description": "青色阴影与暖色高光形成分离，定向光塑造层次，适度景深，横向叙事感构图。"
    },
    "noir": {
        "label": "黑白黑色电影",
        "category": "cinema",
        "description": "黑白高反差，斜向硬光与深暗投影，细颗粒质感，戏剧化斜线和负空间。"
    },
    "film35": {
        "label": "35毫米胶片",
        "category": "cinema",
        "description": "暖调中间色，柔和高光滚降，细微胶片颗粒与自然晕光，真实但不过度锐化。"
    },
    "polaroid": {
        "label": "即时胶片",
        "category": "cinema",
        "description": "温暖略褪色的色彩，柔软反差和轻微色偏，随性近距离构图，不自动添加相纸边框。"
    },
    "sepia": {
        "label": "棕褐怀旧",
        "category": "cinema",
        "description": "棕褐与奶油色调，温和侧光，细腻旧照片颗粒，稳定构图与缓慢的明暗层次。"
    },
    "retro70": {
        "label": "七十年代暖调",
        "category": "cinema",
        "description": "芥末黄、焦橙与棕色环境，柔和暖光，轻微胶片颗粒，圆弧与大色块构图。"
    },
    "vhs": {
        "label": "复古录像",
        "category": "cinema",
        "description": "低饱和冷暖错位色彩，轻微扫描线和模拟信号质感，柔和边缘，保留主体结构清晰。"
    },
    "flat": {
        "label": "扁平插画",
        "category": "illustrated",
        "description": "简洁几何色块，有限协调配色，少量阴影，不使用写实材质，以清晰轮廓和留白建立层次。"
    },
    "lineart": {
        "label": "极简线描",
        "category": "illustrated",
        "description": "细而流畅的单色线条，白色或浅色底，少量重点色，轮廓准确，疏密有节奏。"
    },
    "comic": {
        "label": "美式漫画",
        "category": "illustrated",
        "description": "有力墨线、高反差色块与局部网点，明确光影分区，动态构图，避免自动添加对白框。"
    },
    "anime": {
        "label": "清透动画",
        "category": "illustrated",
        "description": "清晰线稿和赛璐璐色阶，明快协调配色，通透柔光，干净背景和有层次的空间。"
    },
    "picturebook": {
        "label": "童趣绘本",
        "category": "illustrated",
        "description": "温暖柔彩、手绘轮廓与轻微纸纹，圆润概括造型，柔和光感，亲切轻松的构图。"
    },
    "isometric": {
        "label": "等距插画",
        "category": "illustrated",
        "description": "统一等距视角，清晰几何体块，有限配色与简洁投影，布局整齐，边缘利落。"
    },
    "engraving": {
        "label": "复古版画",
        "category": "illustrated",
        "description": "单色或双色交叉排线，雕刻般线纹，细密明暗层次与纸感，构图庄重紧凑。"
    },
    "watercolor": {
        "label": "透明水彩",
        "category": "painting",
        "description": "透明色层与自然晕染，纸白留光，柔软边缘与少量清晰细节，淡雅配色和轻盈留白。"
    },
    "gouache": {
        "label": "不透明水粉",
        "category": "painting",
        "description": "哑光覆盖色块，厚薄适度的手工笔触，柔和而饱满的配色，以大明暗关系塑造体积。"
    },
    "oil": {
        "label": "古典油画",
        "category": "painting",
        "description": "温暖深色底与层层罩染，丰富中间调，细腻油彩肌理，集中光线与稳重构图。"
    },
    "impasto": {
        "label": "厚涂油彩",
        "category": "painting",
        "description": "可见厚重笔触与色彩堆叠，明暗通过笔触方向组织，色彩饱满，轮廓适度概括。"
    },
    "inkwash": {
        "label": "水墨留白",
        "category": "painting",
        "description": "墨色浓淡与自然渗化，宣纸纹理，虚实相生，大面积留白，少量淡色点缀。"
    },
    "coloredpencil": {
        "label": "彩铅素描",
        "category": "painting",
        "description": "细密彩铅线条和纸张颗粒，轻柔叠色，温和明暗，保留手工线迹和清晰结构。"
    },
    "pastel": {
        "label": "粉彩柔雾",
        "category": "painting",
        "description": "柔软粉状笔触、雾面色层和轻微颗粒，低反差色彩相互融合，边缘松弛。"
    },
    "bauhaus": {
        "label": "包豪斯几何",
        "category": "graphic",
        "description": "红黄蓝与黑白的克制组合，圆形直线和矩形建立秩序，清晰层级，功能化非对称构图。"
    },
    "swiss": {
        "label": "瑞士网格",
        "category": "graphic",
        "description": "中性色与单一强调色，严谨网格、对齐和大留白；需要文字时采用清晰无衬线层级。"
    },
    "artdeco": {
        "label": "装饰艺术",
        "category": "graphic",
        "description": "深色与金属色点缀，对称几何与阶梯形节奏，细致线饰，优雅而克制。"
    },
    "memphis": {
        "label": "孟菲斯趣味",
        "category": "graphic",
        "description": "活泼撞色、波点与不规则几何图形，轻快平面光感，错落但有主次的构图。"
    },
    "collage": {
        "label": "纸张拼贴",
        "category": "graphic",
        "description": "协调异色纸块叠放，剪切边缘和轻微投影，纸面纤维可见，分层组合突出主体。"
    },
    "risograph": {
        "label": "孔版双色",
        "category": "graphic",
        "description": "双色套印、细颗粒与轻微套色偏移，有限颜色叠加，手工印刷感，简洁形状构图。"
    },
    "minimalposter": {
        "label": "极简海报",
        "category": "graphic",
        "description": "大面积纯净留白，单一视觉中心与少量强调色，轮廓干净；有文案时保持稀疏清晰的层级。"
    },
    "clay": {
        "label": "黏土定格",
        "category": "render",
        "description": "柔软哑光黏土质感，轻微手工压痕，温暖柔光，圆润环境形态与近景构图。"
    },
    "papercraft": {
        "label": "立体纸艺",
        "category": "render",
        "description": "折纸般分面与纸张纤维，分层纸片形成柔和投影，有限配色，空间关系清晰。"
    },
    "lowpoly": {
        "label": "低多边形",
        "category": "render",
        "description": "清晰多边形分面，平整色块和简洁光影，几何化环境，轮廓和结构保持可辨认。"
    },
    "soft3d": {
        "label": "柔萌三维",
        "category": "render",
        "description": "柔和漫反射材质、圆润形态和浅色环境，宽面积柔光与轻微环境遮蔽，画面轻盈。"
    },
    "glass": {
        "label": "玻璃光学",
        "category": "render",
        "description": "环境采用通透玻璃般折射和浅色光斑，背景干净，边缘高光细致，主体本身材质保持准确。"
    },
    "metal": {
        "label": "金属未来",
        "category": "render",
        "description": "环境采用拉丝金属与冷灰色，细长反射高光和精确轮廓，几何构图，主体固有材质不替换。"
    },
    "miniature": {
        "label": "微缩景观",
        "category": "render",
        "description": "微缩模型般精细环境，浅景深和柔和顶光，清晰近景层次，细节精巧但不过度拥挤。"
    },
    "cyberpunk": {
        "label": "赛博霓虹",
        "category": "fantasy",
        "description": "深蓝暗部与紫红霓虹，局部反射和清晰轮廓光，空间纵深强，控制发光面积避免淹没主体。"
    },
    "solarpunk": {
        "label": "生态未来",
        "category": "fantasy",
        "description": "明亮暖白与植物绿环境，柔和日照，自然纹理与简洁科技形态融合，开放而乐观。"
    },
    "vaporwave": {
        "label": "蒸汽波",
        "category": "fantasy",
        "description": "粉紫与青蓝渐变，柔和发光、复古几何与梦幻空间，低密度元素，保持主体清晰。"
    },
    "synthwave": {
        "label": "合成波",
        "category": "fantasy",
        "description": "紫蓝夜色与橙红光源，几何透视线和局部霓虹，高对比剪影感，不自动添加文字。"
    },
    "ethereal": {
        "label": "空灵梦境",
        "category": "fantasy",
        "description": "珠光浅色与低饱和渐变，柔雾和漫射光，虚实分层，大面积呼吸感留白。"
    },
    "surreal": {
        "label": "超现实空间",
        "category": "fantasy",
        "description": "简洁但反常的空间比例和几何关系，清晰光影、克制配色，主体身份保持真实可辨。"
    },
    "cosmic": {
        "label": "深空光感",
        "category": "fantasy",
        "description": "深靛蓝环境与少量冷暖星点，柔和辉光和深远空间层次，主体轮廓清晰，不堆满装饰。"
    }
});
