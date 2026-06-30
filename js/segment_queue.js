// Copyright (c) 2026 分段队列
// 作者 / Authors: B站：三层楼的小肥猴 & wuwukasi
// 空间 / Bilibili: https://space.bilibili.com/389291683
// 交流 / Contact: 微信 fx-feihou；QQ群 1091593367（请备注来意：加群、商务）
// 开源协议 / Open Source License: Apache License 2.0.
// 中文摘要：可在 Apache-2.0 条款下使用、复制、修改和分发；需保留版权、许可与声明，修改文件需标注变更。
// English summary: You may use, copy, modify, and distribute this software under Apache-2.0, retaining copyright, license, and notices, and marking changed files.
// 本软件按“现状”提供；具体条款以 LICENSE 文件为准。
// Distributed on an "AS IS" BASIS; see the LICENSE file for the full terms.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const THUMB_URL = "/sqr/image_thumb?file=";

// 分段队列最小段长（默认 61 帧，必须 4n+1）。
// 之前写死 41；固定每段帧数模式下滑条下限也可在设置面板里改到 41~361 之间。
const SQR_MIN_SEG = 61;
const SQR_TRANSITION_FRAMES = 21;
const SQR_TRIM_SPLIT = "split21";

function sqrThumbUrl(path) {
    const sep = THUMB_URL.includes("?") ? "&" : "?";
    return THUMB_URL + encodeURIComponent(path) + sep + "_ts=" + Date.now() + "_r=" + Math.random().toString(36).slice(2, 8);
}

// ═══════════════════════════════════════════════════════════════════
// ── 需求6: 猫猫扭蛋系统 ─────────────────────────────────────────────
// 触发：分段队列节点处于"预览模式 + 手动分段"组合时；
// 抽卡机会：每次"执行模式"全流程跑完一次 +3 张；
// 数据持久化：localStorage['sqr_gacha_tickets'] / ['sqr_gacha_collection']
// ═══════════════════════════════════════════════════════════════════

const SQR_GACHA_TICKETS_KEY = "sqr_gacha_tickets";
const SQR_GACHA_COLLECTION_KEY = "sqr_gacha_collection";
const SQR_GACHA_LAST_REWARD_KEY = "sqr_gacha_last_reward_stamp";

// 完整 100 只猫数据库（3 SSR + 12 SR + 30 R + 55 N）
const SQR_CAT_DB = [
    // ── SSR (3) — 节点作者命名 ──
    { id: "feihou_cat",  name: "肥猴猫",   emoji: "🐵", rarity: "SSR", desc: "你以为是猴，其实是猫，最爱吃香蕉的传说之猫。",   custom: "feihou" },
    { id: "wuwu_cat",    name: "wuwu猫",   emoji: "🚂", rarity: "SSR", desc: "呜呜——中转列车即将进站。",   custom: "wuwu" },
    { id: "xuezi_cat",   name: "雪子猫",   emoji: "❄️", rarity: "SSR", desc: "每一个片段都由雪花编织而成。",   custom: "xuezi" },

    // ── SR (12) — 职业系 ──
    { id: "wizard_cat",     name: "巫师猫",   emoji: "🔮", rarity: "SR", desc: "召唤分段，召唤稳定的拼接处。",            body: "#6B5B95", pattern: "solid",  eye: "#9C27B0", acc: "wizard_hat",  accCol: "#3F51B5", expr: "smile" },
    { id: "chef_cat",       name: "厨师猫",   emoji: "👨‍🍳", rarity: "SR", desc: "正在用 4n+1 帧炖一锅高汤。",              body: "#F5F5DC", pattern: "solid",  eye: "#8B4513", acc: "chef_hat",    accCol: "#FFFFFF", expr: "smile" },
    { id: "astronaut_cat",  name: "宇航猫",   emoji: "🚀", rarity: "SR", desc: "在 latent 空间漫游了三个月。",            body: "#E0E0E0", pattern: "solid",  eye: "#1976D2", acc: "helmet",      accCol: "#90CAF9", expr: "wink" },
    { id: "ninja_cat",      name: "忍者猫",   emoji: "🥷", rarity: "SR", desc: "悄无声息地处理了过渡帧。",                body: "#212121", pattern: "solid",  eye: "#FFEB3B", acc: "mask",        accCol: "#424242", expr: "smile" },
    { id: "samurai_cat",    name: "武士猫",   emoji: "⚔️", rarity: "SR", desc: "一刀切在 4n+1 处，干脆利落。",            body: "#5D4037", pattern: "tabby",  eye: "#FFC107", acc: "headband",    accCol: "#D32F2F", expr: "smile" },
    { id: "pirate_cat",     name: "海盗猫",   emoji: "🏴‍☠️", rarity: "SR", desc: "劫走了你 output 文件夹的最后一帧。",      body: "#3E2723", pattern: "solid",  eye: "#FF6F00", acc: "pirate_hat",  accCol: "#212121", expr: "wink" },
    { id: "detective_cat",  name: "侦探猫",   emoji: "🔍", rarity: "SR", desc: "擅长查找消失的过渡视频。",                body: "#795548", pattern: "tabby",  eye: "#33691E", acc: "magnifier",   accCol: "#FFD54F", expr: "smile" },
    { id: "dj_cat",         name: "DJ猫",     emoji: "🎧", rarity: "SR", desc: "把每一段都对齐到 16fps 节拍。",          body: "#E91E63", pattern: "solid",  eye: "#9C27B0", acc: "headphones",  accCol: "#FF4081", expr: "smile" },
    { id: "painter_cat",    name: "画家猫",   emoji: "🎨", rarity: "SR", desc: "最懂参考图的色彩分布。",                  body: "#FFB74D", pattern: "calico", eye: "#388E3C", acc: "beret",       accCol: "#5D4037", expr: "smile" },
    { id: "scientist_cat",  name: "科学猫",   emoji: "🧪", rarity: "SR", desc: "force_rate 的真正含义，只有它知道。",     body: "#FFFFFF", pattern: "solid",  eye: "#00ACC1", acc: "goggles",     accCol: "#26C6DA", expr: "surprised" },
    { id: "gamer_cat",      name: "电竞猫",   emoji: "🎮", rarity: "SR", desc: "连点 100 次「运行」也不会累。",            body: "#9C27B0", pattern: "solid",  eye: "#76FF03", acc: "headset",     accCol: "#FF1744", expr: "smile" },
    { id: "librarian_cat",  name: "图书馆猫", emoji: "📚", rarity: "SR", desc: "整个 sqr_checkpoint_history 都装在它脑子里。", body: "#6D4C41", pattern: "tabby",  eye: "#9E9D24", acc: "glasses",     accCol: "#FFD54F", expr: "sleep" },

    // ── R (30) — 物品/状态系 ──
    { id: "coffee_cat",     name: "咖啡猫",     emoji: "☕", rarity: "R", desc: "醒醒，你的渲染还在跑。",            body: "#6F4E37", pattern: "tabby",  eye: "#D2691E", acc: "scarf",   accCol: "#A0522D", expr: "sleep" },
    { id: "milk_tea_cat",   name: "奶茶猫",     emoji: "🧋", rarity: "R", desc: "三分糖，少冰，半糖人生。",          body: "#D7B48C", pattern: "solid",  eye: "#5D4037", acc: "bow",     accCol: "#8D6E63", expr: "smile" },
    { id: "yarn_cat",       name: "毛线猫",     emoji: "🧶", rarity: "R", desc: "把整个工作流卷成了一团。",          body: "#F48FB1", pattern: "solid",  eye: "#7B1FA2", acc: "yarn_ball", accCol: "#E91E63", expr: "wink" },
    { id: "box_cat",        name: "纸箱猫",     emoji: "📦", rarity: "R", desc: "猫盒，盒猫，本质相同。",            body: "#FFB74D", pattern: "tabby",  eye: "#388E3C", acc: "box",     accCol: "#8D6E63", expr: "smile" },
    { id: "space_cat",      name: "太空猫",     emoji: "🌌", rarity: "R", desc: "看见过 latent 空间的星辰。",        body: "#1A237E", pattern: "solid",  eye: "#FFEB3B", acc: "stars",   accCol: "#FFC107", expr: "wink" },
    { id: "robot_cat",      name: "机械猫",     emoji: "🤖", rarity: "R", desc: "0001 0011 0010 喵。",                body: "#90A4AE", pattern: "solid",  eye: "#F44336", acc: "antenna", accCol: "#37474F", expr: "smile" },
    { id: "sakura_cat",     name: "樱花猫",     emoji: "🌸", rarity: "R", desc: "三月的猫，三月的风。",              body: "#F8BBD0", pattern: "solid",  eye: "#AD1457", acc: "flower",  accCol: "#EC407A", expr: "smile" },
    { id: "moon_cat",       name: "月光猫",     emoji: "🌙", rarity: "R", desc: "在凌晨三点的渲染队列里出没。",      body: "#B0BEC5", pattern: "solid",  eye: "#FFEB3B", acc: "moon",    accCol: "#FFF59D", expr: "sleep" },
    { id: "sunset_cat",     name: "夕阳猫",     emoji: "🌇", rarity: "R", desc: "一天最暖的颜色都在它身上。",        body: "#FF7043", pattern: "tabby",  eye: "#FFA000", acc: "scarf",   accCol: "#D84315", expr: "smile" },
    { id: "rain_cat",       name: "雨夜猫",     emoji: "🌧️", rarity: "R", desc: "最懂雨声里的孤独感。",              body: "#455A64", pattern: "solid",  eye: "#4FC3F7", acc: "umbrella", accCol: "#0288D1", expr: "smile" },
    { id: "sunny_cat",      name: "晴天猫",     emoji: "☀️", rarity: "R", desc: "永远的好心情制造机。",              body: "#FFD54F", pattern: "solid",  eye: "#FF6F00", acc: "sun",     accCol: "#FFA000", expr: "smile" },
    { id: "cloudy_cat",     name: "阴天猫",     emoji: "☁️", rarity: "R", desc: "适合宅家跑分段队列的天气。",        body: "#CFD8DC", pattern: "solid",  eye: "#546E7A", acc: "cloud",   accCol: "#90A4AE", expr: "sleep" },
    { id: "bread_cat",      name: "面包猫",     emoji: "🍞", rarity: "R", desc: "刚出炉，外脆内软。",                body: "#D7B48C", pattern: "solid",  eye: "#5D4037", acc: "none",    accCol: "",        expr: "smile" },
    { id: "sushi_cat",      name: "寿司猫",     emoji: "🍣", rarity: "R", desc: "鱼生与猫的禁忌组合。",              body: "#FFFFFF", pattern: "tuxedo", eye: "#1976D2", acc: "fish",    accCol: "#F44336", expr: "smile" },
    { id: "burger_cat",     name: "汉堡猫",     emoji: "🍔", rarity: "R", desc: "永远饿肚子的猫。",                  body: "#A1887F", pattern: "tabby",  eye: "#5D4037", acc: "none",    accCol: "",        expr: "surprised" },
    { id: "watermelon_cat", name: "西瓜猫",     emoji: "🍉", rarity: "R", desc: "夏天和猫的标配。",                  body: "#E57373", pattern: "tabby",  eye: "#388E3C", acc: "leaf",    accCol: "#388E3C", expr: "smile" },
    { id: "grape_cat",      name: "葡萄猫",     emoji: "🍇", rarity: "R", desc: "酸甜的小心思都藏在尾巴尖。",        body: "#9C27B0", pattern: "solid",  eye: "#FFEB3B", acc: "leaf",    accCol: "#388E3C", expr: "smile" },
    { id: "strawberry_cat", name: "草莓猫",     emoji: "🍓", rarity: "R", desc: "粉嫩到舍不得吃。",                  body: "#EF5350", pattern: "solid",  eye: "#FFEB3B", acc: "leaf",    accCol: "#388E3C", expr: "wink" },
    { id: "orange_fruit_cat", name: "橘子猫",   emoji: "🍊", rarity: "R", desc: "和肥猴猫只差一根香蕉。",            body: "#FF9800", pattern: "tabby",  eye: "#388E3C", acc: "leaf",    accCol: "#388E3C", expr: "smile" },
    { id: "pudding_cat",    name: "布丁猫",     emoji: "🍮", rarity: "R", desc: "Q弹有嚼劲，但请不要吃。",          body: "#FFE082", pattern: "solid",  eye: "#6D4C41", acc: "cherry",  accCol: "#E53935", expr: "smile" },
    { id: "mint_cat",       name: "薄荷猫",     emoji: "🌿", rarity: "R", desc: "夏天的清凉感。",                    body: "#80CBC4", pattern: "solid",  eye: "#1B5E20", acc: "leaf",    accCol: "#388E3C", expr: "smile" },
    { id: "choco_cat",      name: "巧克力猫",   emoji: "🍫", rarity: "R", desc: "苦中带甜的成熟猫。",                body: "#4E342E", pattern: "solid",  eye: "#FFD54F", acc: "scarf",   accCol: "#6D4C41", expr: "wink" },
    { id: "rainbow_cat",    name: "彩虹猫",     emoji: "🌈", rarity: "R", desc: "雨后的一道光。",                    body: "#FFFFFF", pattern: "calico", eye: "#7B1FA2", acc: "rainbow", accCol: "#FF4081", expr: "smile" },
    { id: "starry_cat",     name: "星空猫",     emoji: "✨", rarity: "R", desc: "毛发里藏着银河。",                  body: "#283593", pattern: "solid",  eye: "#FFEB3B", acc: "stars",   accCol: "#FFD54F", expr: "wink" },
    { id: "lightning_cat",  name: "闪电猫",     emoji: "⚡", rarity: "R", desc: "比 KSampler 的进度条还快。",       body: "#FFEB3B", pattern: "solid",  eye: "#1A237E", acc: "bolt",    accCol: "#FF6F00", expr: "surprised" },
    { id: "fire_cat",       name: "火焰猫",     emoji: "🔥", rarity: "R", desc: "靠近它，你的 GPU 也会发热。",      body: "#E64A19", pattern: "solid",  eye: "#FFEB3B", acc: "flame",   accCol: "#FFA000", expr: "smile" },
    { id: "ice_cat",        name: "冰晶猫",     emoji: "🧊", rarity: "R", desc: "雪子猫的远房表亲。",                body: "#B3E5FC", pattern: "solid",  eye: "#0288D1", acc: "snowflake", accCol: "#FFFFFF", expr: "smile" },
    { id: "moss_cat",       name: "苔藓猫",     emoji: "🌱", rarity: "R", desc: "爱在森林里发呆的猫。",              body: "#558B2F", pattern: "solid",  eye: "#F9A825", acc: "leaf",    accCol: "#33691E", expr: "sleep" },
    { id: "mushroom_cat",   name: "蘑菇猫",     emoji: "🍄", rarity: "R", desc: "雨后冒出来的小可爱。",              body: "#D7CCC8", pattern: "solid",  eye: "#4E342E", acc: "mushroom_hat", accCol: "#D32F2F", expr: "wink" },
    { id: "candy_cat",      name: "糖果猫",     emoji: "🍬", rarity: "R", desc: "甜到分段队列都能跑顺。",            body: "#F8BBD0", pattern: "solid",  eye: "#7B1FA2", acc: "candy",   accCol: "#E91E63", expr: "smile" },

    // ── N (55) — 普通家猫变体 ──
    { id: "orange_cat",       name: "橘猫",     emoji: "🐱", rarity: "N", desc: "三斤起步的快乐源泉。",       body: "#FF8C00", pattern: "tabby",  eye: "#7CFC00", acc: "none", accCol: "", expr: "smile" },
    { id: "white_cat",        name: "白猫",     emoji: "🐈", rarity: "N", desc: "一身素白，干净利落。",       body: "#FAFAFA", pattern: "solid",  eye: "#1976D2", acc: "none", accCol: "", expr: "smile" },
    { id: "black_cat",        name: "黑猫",     emoji: "🐈‍⬛", rarity: "N", desc: "夜行动物，眼神有戏。",       body: "#212121", pattern: "solid",  eye: "#FFEB3B", acc: "none", accCol: "", expr: "wink" },
    { id: "gray_cat",         name: "灰猫",     emoji: "🐱", rarity: "N", desc: "低调中的高贵感。",           body: "#9E9E9E", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "tabby_cat",        name: "虎斑猫",   emoji: "🐱", rarity: "N", desc: "M 字额头是它的标志。",       body: "#A1887F", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "tuxedo_cat",       name: "奶牛猫",   emoji: "🐱", rarity: "N", desc: "黑白配色永不过时。",         body: "#FAFAFA", pattern: "tuxedo", eye: "#1B5E20", acc: "none", accCol: "", expr: "smile" },
    { id: "calico_cat",       name: "三花猫",   emoji: "🐱", rarity: "N", desc: "三色调色板。",               body: "#FAFAFA", pattern: "calico", eye: "#FF6F00", acc: "none", accCol: "", expr: "smile" },
    { id: "tortoiseshell_cat",name: "玳瑁猫",   emoji: "🐱", rarity: "N", desc: "复杂的花纹有复杂的脾气。",   body: "#5D4037", pattern: "calico", eye: "#FFC107", acc: "none", accCol: "", expr: "wink" },
    { id: "silver_tabby",     name: "银渐层",   emoji: "🐱", rarity: "N", desc: "银光闪闪，贵气十足。",       body: "#E0E0E0", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "golden_tabby",     name: "金渐层",   emoji: "🐱", rarity: "N", desc: "毛色像融化的金子。",         body: "#FFD54F", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "russian_blue",     name: "蓝猫",     emoji: "🐱", rarity: "N", desc: "蓝灰色的优雅。",             body: "#78909C", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "ragdoll_cat",      name: "布偶猫",   emoji: "🐱", rarity: "N", desc: "抱起来像棉花糖。",           body: "#F5F5DC", pattern: "tuxedo", eye: "#1976D2", acc: "none", accCol: "", expr: "sleep" },
    { id: "siamese_cat",      name: "暹罗猫",   emoji: "🐱", rarity: "N", desc: "蓝眼睛的话痨。",             body: "#F5DEB3", pattern: "tuxedo", eye: "#0288D1", acc: "none", accCol: "", expr: "surprised" },
    { id: "maine_coon",       name: "缅因猫",   emoji: "🐱", rarity: "N", desc: "猫中巨人，温柔大块头。",     body: "#A1887F", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "british_shorthair",name: "英短猫",   emoji: "🐱", rarity: "N", desc: "圆脸圆身的小绅士。",         body: "#90A4AE", pattern: "solid",  eye: "#FF6F00", acc: "none", accCol: "", expr: "smile" },
    { id: "american_shorthair", name: "美短猫", emoji: "🐱", rarity: "N", desc: "斑纹清晰的美式范儿。",       body: "#9E9E9E", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "persian_cat",      name: "波斯猫",   emoji: "🐱", rarity: "N", desc: "扁脸长毛的高贵少爷。",       body: "#F5F5F5", pattern: "solid",  eye: "#FFB300", acc: "none", accCol: "", expr: "smile" },
    { id: "sphinx_cat",       name: "无毛猫",   emoji: "🐱", rarity: "N", desc: "皱纹是岁月的礼物。",         body: "#FFCCBC", pattern: "solid",  eye: "#1976D2", acc: "none", accCol: "", expr: "wink" },
    { id: "field_cat",        name: "田园猫",   emoji: "🐱", rarity: "N", desc: "中华大地最自由的猫。",       body: "#BCAAA4", pattern: "tabby",  eye: "#33691E", acc: "none", accCol: "", expr: "smile" },
    { id: "long_hair_cat",    name: "长毛猫",   emoji: "🐱", rarity: "N", desc: "梳毛要梳半小时。",           body: "#D7CCC8", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "short_hair_cat",   name: "短毛猫",   emoji: "🐱", rarity: "N", desc: "省心的好朋友。",             body: "#A1887F", pattern: "solid",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "curl_ear_cat",     name: "卷耳猫",   emoji: "🐱", rarity: "N", desc: "耳朵向后翻卷，像戴了个发箍。", body: "#FAFAFA", pattern: "solid",  eye: "#0288D1", acc: "none", accCol: "", expr: "smile" },
    { id: "fold_ear_cat",     name: "折耳猫",   emoji: "🐱", rarity: "N", desc: "短短的折耳，超萌的脸。",     body: "#90A4AE", pattern: "solid",  eye: "#FFB300", acc: "none", accCol: "", expr: "wink" },
    { id: "tail_cat",         name: "长尾猫",   emoji: "🐱", rarity: "N", desc: "尾巴比身子还长。",           body: "#FF8C00", pattern: "tabby",  eye: "#7CFC00", acc: "none", accCol: "", expr: "smile" },
    { id: "no_tail_cat",      name: "断尾猫",   emoji: "🐱", rarity: "N", desc: "短尾的小可怜，但很坚强。",   body: "#9E9E9E", pattern: "solid",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "big_eye_cat",      name: "大眼猫",   emoji: "🐱", rarity: "N", desc: "眼神纯真到能看穿你。",       body: "#FFE0B2", pattern: "solid",  eye: "#1976D2", acc: "none", accCol: "", expr: "surprised" },
    { id: "small_eye_cat",    name: "小眼猫",   emoji: "🐱", rarity: "N", desc: "眯眯眼里有大智慧。",         body: "#A1887F", pattern: "tabby",  eye: "#5D4037", acc: "none", accCol: "", expr: "sleep" },
    { id: "big_ear_cat",      name: "大耳猫",   emoji: "🐱", rarity: "N", desc: "耳朵能转向 270 度。",       body: "#D7B48C", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "surprised" },
    { id: "small_ear_cat",    name: "小耳猫",   emoji: "🐱", rarity: "N", desc: "迷你耳朵更显脸圆。",         body: "#FAFAFA", pattern: "solid",  eye: "#FFB300", acc: "none", accCol: "", expr: "smile" },
    { id: "round_face_cat",   name: "圆脸猫",   emoji: "🐱", rarity: "N", desc: "包子脸的代表。",             body: "#FFE0B2", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "long_face_cat",    name: "长脸猫",   emoji: "🐱", rarity: "N", desc: "瓜子脸的代表。",             body: "#A1887F", pattern: "solid",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "fat_cat",          name: "胖猫",     emoji: "🐱", rarity: "N", desc: "圆滚滚的快乐肥宅。",         body: "#FF8C00", pattern: "solid",  eye: "#7CFC00", acc: "none", accCol: "", expr: "smile" },
    { id: "thin_cat",         name: "瘦猫",     emoji: "🐱", rarity: "N", desc: "怎么吃都不胖的羡慕对象。",   body: "#9E9E9E", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "tall_cat",         name: "高个猫",   emoji: "🐱", rarity: "N", desc: "腿长一米八。",               body: "#A1887F", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "short_cat",        name: "矮个猫",   emoji: "🐱", rarity: "N", desc: "短腿短脚的小柯基。",         body: "#FFE0B2", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "wink" },
    { id: "sleepy_cat",       name: "爱睡猫",   emoji: "💤", rarity: "N", desc: "一天能睡 16 小时。",         body: "#90A4AE", pattern: "solid",  eye: "#1976D2", acc: "none", accCol: "", expr: "sleep" },
    { id: "jumpy_cat",        name: "爱跳猫",   emoji: "🐱", rarity: "N", desc: "弹跳力爆表。",               body: "#FF8C00", pattern: "tabby",  eye: "#7CFC00", acc: "none", accCol: "", expr: "surprised" },
    { id: "foody_cat",        name: "爱吃猫",   emoji: "🐱", rarity: "N", desc: "猫生信条：饭碗永远不能空。", body: "#FFD54F", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "playful_cat",      name: "爱玩猫",   emoji: "🐱", rarity: "N", desc: "最爱追激光笔的猫。",         body: "#A1887F", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "wink" },
    { id: "noisy_cat",        name: "爱叫猫",   emoji: "🐱", rarity: "N", desc: "嘴巴像装了喇叭。",           body: "#F5DEB3", pattern: "tuxedo", eye: "#0288D1", acc: "none", accCol: "", expr: "surprised" },
    { id: "quiet_cat",        name: "安静猫",   emoji: "🐱", rarity: "N", desc: "存在感低到几乎是空气。",     body: "#CFD8DC", pattern: "solid",  eye: "#546E7A", acc: "none", accCol: "", expr: "sleep" },
    { id: "curious_cat",      name: "好奇猫",   emoji: "🐱", rarity: "N", desc: "什么都要去碰一下。",         body: "#FFE0B2", pattern: "solid",  eye: "#1976D2", acc: "none", accCol: "", expr: "surprised" },
    { id: "shy_cat",          name: "害羞猫",   emoji: "🐱", rarity: "N", desc: "看见人就钻沙发底。",         body: "#D7B48C", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "wink" },
    { id: "brave_cat",        name: "勇敢猫",   emoji: "🐱", rarity: "N", desc: "面对吸尘器毫不退缩。",       body: "#FF8C00", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "gentle_cat",       name: "温柔猫",   emoji: "🐱", rarity: "N", desc: "撸起来软软的。",             body: "#F5F5DC", pattern: "solid",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "naughty_cat",      name: "调皮猫",   emoji: "🐱", rarity: "N", desc: "总是把杯子推下桌子的元凶。", body: "#A1887F", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "wink" },
    { id: "lazy_cat",         name: "懒散猫",   emoji: "🐱", rarity: "N", desc: "猫生格言：能躺着就不坐着。", body: "#90A4AE", pattern: "solid",  eye: "#5D4037", acc: "none", accCol: "", expr: "sleep" },
    { id: "noble_cat",        name: "贵族猫",   emoji: "🐱", rarity: "N", desc: "看人都是用鼻孔。",           body: "#F5F5F5", pattern: "solid",  eye: "#FFB300", acc: "none", accCol: "", expr: "smile" },
    { id: "street_cat",       name: "街头猫",   emoji: "🐱", rarity: "N", desc: "巷子里的潇洒派。",           body: "#A1887F", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "wink" },
    { id: "farm_cat",         name: "农场猫",   emoji: "🐱", rarity: "N", desc: "捉老鼠的好手。",             body: "#D7B48C", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "beach_cat",        name: "海边猫",   emoji: "🐱", rarity: "N", desc: "喜欢追海浪的退潮。",         body: "#F5F5DC", pattern: "solid",  eye: "#0288D1", acc: "none", accCol: "", expr: "smile" },
    { id: "mountain_cat",     name: "山间猫",   emoji: "🐱", rarity: "N", desc: "山顶日出的见证者。",         body: "#5D4037", pattern: "tabby",  eye: "#FFC107", acc: "none", accCol: "", expr: "smile" },
    { id: "city_cat",         name: "城市猫",   emoji: "🐱", rarity: "N", desc: "见过霓虹灯的猫。",           body: "#9E9E9E", pattern: "solid",  eye: "#7B1FA2", acc: "none", accCol: "", expr: "wink" },
    { id: "country_cat",      name: "乡村猫",   emoji: "🐱", rarity: "N", desc: "听过蛙鸣的猫。",             body: "#A1887F", pattern: "tabby",  eye: "#388E3C", acc: "none", accCol: "", expr: "smile" },
    { id: "unknown_cat",      name: "未知猫",   emoji: "🐱", rarity: "N", desc: "身世成谜，气质独特。",       body: "#7E57C2", pattern: "solid",  eye: "#FFEB3B", acc: "none", accCol: "", expr: "wink" },
];

// 稀有度配色 / 序号 / 概率
const SQR_RARITY_META = {
    SSR: { color: "#FFD700", border: "#FFAB00", bg: "rgba(255,215,0,0.12)", order: 0, weight: 0.01,  label: "★★★ SSR" },
    SR:  { color: "#B388FF", border: "#7C4DFF", bg: "rgba(179,136,255,0.12)", order: 1, weight: 0.02,  label: "★★ SR" },
    R:   { color: "#64B5F6", border: "#1976D2", bg: "rgba(100,181,246,0.12)", order: 2, weight: 0.015, label: "★ R" },
    N:   { color: "#B0BEC5", border: "#78909C", bg: "rgba(176,190,197,0.10)", order: 3, weight: 0.0051,label: "N" },
};

// ── 抽卡核心 ──
function _sqrDrawCat() {
    // 按稀有度组分组，每只猫的权重 = 该稀有度的 weight；
    // SSR 总和 3% (3*1%)、SR 总和 24% (12*2%)、R 总和 45% (30*1.5%)、N 总和 ~28% (55*0.51%)
    const weights = SQR_CAT_DB.map(c => SQR_RARITY_META[c.rarity].weight);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < SQR_CAT_DB.length; i++) {
        r -= weights[i];
        if (r <= 0) return SQR_CAT_DB[i];
    }
    return SQR_CAT_DB[SQR_CAT_DB.length - 1];
}

// ── 票数 / 收集存档 ──
function _sqrGetTickets() {
    try { return Math.max(0, parseInt(localStorage.getItem(SQR_GACHA_TICKETS_KEY) || "0", 10) || 0); }
    catch (e) { return 0; }
}
function _sqrSetTickets(n) {
    try { localStorage.setItem(SQR_GACHA_TICKETS_KEY, String(Math.max(0, parseInt(n, 10) || 0))); }
    catch (e) {}
}
function _sqrAddTickets(delta) {
    _sqrSetTickets(_sqrGetTickets() + delta);
}
function _sqrUseTicket() {
    const t = _sqrGetTickets();
    if (t <= 0) return false;
    _sqrSetTickets(t - 1);
    return true;
}
function _sqrGetCollection() {
    try {
        const raw = localStorage.getItem(SQR_GACHA_COLLECTION_KEY);
        if (!raw) return {};
        const data = JSON.parse(raw);
        return (data && typeof data === "object") ? data : {};
    } catch (e) { return {}; }
}
function _sqrSetCollection(obj) {
    try { localStorage.setItem(SQR_GACHA_COLLECTION_KEY, JSON.stringify(obj || {})); }
    catch (e) {}
}
function _sqrRecordCat(catId) {
    const col = _sqrGetCollection();
    const isNew = !col[catId];
    if (isNew) {
        col[catId] = { firstAt: Date.now(), count: 1 };
    } else {
        col[catId].count = (col[catId].count || 0) + 1;
    }
    _sqrSetCollection(col);
    return isNew;
}
function _sqrResetGacha() {
    _sqrSetCollection({});
    _sqrSetTickets(0);
    try { localStorage.removeItem(SQR_GACHA_LAST_REWARD_KEY); } catch (e) {}
}

// ── SVG 生成器 ──
function _sqrBuildCatSVG(cat, size) {
    size = size || 200;
    if (cat.custom === "feihou") return _sqrBuildFeihouSVG(size);
    if (cat.custom === "wuwu")   return _sqrBuildWuwuSVG(size);
    if (cat.custom === "xuezi")  return _sqrBuildXueziSVG(size);
    return _sqrBuildParamCatSVG(cat, size);
}

function _sqrBuildParamCatSVG(cat, size) {
    const body = cat.body || "#FFB74D";
    const eye = cat.eye || "#388E3C";
    const acc = cat.acc || "none";
    const accCol = cat.accCol || "#FFFFFF";
    const expr = cat.expr || "smile";
    const pattern = cat.pattern || "solid";

    // 几何参数
    const cx = 100, cy = 110;
    const headR = 62;
    const earL = `M${cx-50},${cy-45} L${cx-72},${cy-95} L${cx-25},${cy-65} Z`;
    const earR = `M${cx+50},${cy-45} L${cx+72},${cy-95} L${cx+25},${cy-65} Z`;
    const innerEarL = `M${cx-48},${cy-50} L${cx-62},${cy-82} L${cx-32},${cy-65} Z`;
    const innerEarR = `M${cx+48},${cy-50} L${cx+62},${cy-82} L${cx+32},${cy-65} Z`;

    // 花纹叠加
    let patternLayer = "";
    if (pattern === "tabby") {
        patternLayer = `
            <path d="M${cx-30},${cy-55} Q${cx},${cy-65} ${cx+30},${cy-55}" stroke="rgba(0,0,0,0.18)" stroke-width="3" fill="none"/>
            <path d="M${cx-40},${cy-30} Q${cx-20},${cy-15} ${cx-5},${cy-25}" stroke="rgba(0,0,0,0.18)" stroke-width="3" fill="none"/>
            <path d="M${cx+5},${cy-25} Q${cx+20},${cy-15} ${cx+40},${cy-30}" stroke="rgba(0,0,0,0.18)" stroke-width="3" fill="none"/>
        `;
    } else if (pattern === "tuxedo") {
        patternLayer = `<path d="M${cx-35},${cy+25} Q${cx},${cy-5} ${cx+35},${cy+25} L${cx+35},${cy+62} L${cx-35},${cy+62} Z" fill="#FFFFFF"/>`;
    } else if (pattern === "calico") {
        patternLayer = `
            <ellipse cx="${cx-30}" cy="${cy-25}" rx="22" ry="18" fill="#FFFFFF" opacity="0.85"/>
            <ellipse cx="${cx+25}" cy="${cy+10}" rx="18" ry="14" fill="#212121" opacity="0.7"/>
        `;
    }

    // 表情
    let mouth, eyeShape;
    const eyeY = cy - 8;
    const eyeLX = cx - 22, eyeRX = cx + 22;
    if (expr === "sleep") {
        eyeShape = `
            <path d="M${eyeLX-8},${eyeY} Q${eyeLX},${eyeY+5} ${eyeLX+8},${eyeY}" stroke="#212121" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            <path d="M${eyeRX-8},${eyeY} Q${eyeRX},${eyeY+5} ${eyeRX+8},${eyeY}" stroke="#212121" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        `;
        mouth = `<path d="M${cx-5},${cy+18} Q${cx},${cy+22} ${cx+5},${cy+18}" stroke="#212121" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    } else if (expr === "wink") {
        eyeShape = `
            <ellipse cx="${eyeLX}" cy="${eyeY}" rx="6" ry="9" fill="${eye}"/>
            <circle cx="${eyeLX}" cy="${eyeY}" r="2.5" fill="#212121"/>
            <circle cx="${eyeLX-1.5}" cy="${eyeY-2}" r="1.2" fill="#FFFFFF"/>
            <path d="M${eyeRX-8},${eyeY+1} Q${eyeRX},${eyeY-3} ${eyeRX+8},${eyeY+1}" stroke="#212121" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        `;
        mouth = `<path d="M${cx-6},${cy+17} Q${cx},${cy+22} ${cx+6},${cy+17}" stroke="#212121" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    } else if (expr === "surprised") {
        eyeShape = `
            <circle cx="${eyeLX}" cy="${eyeY}" r="8" fill="${eye}"/>
            <circle cx="${eyeLX}" cy="${eyeY}" r="3.5" fill="#212121"/>
            <circle cx="${eyeLX-1.5}" cy="${eyeY-2.5}" r="1.5" fill="#FFFFFF"/>
            <circle cx="${eyeRX}" cy="${eyeY}" r="8" fill="${eye}"/>
            <circle cx="${eyeRX}" cy="${eyeY}" r="3.5" fill="#212121"/>
            <circle cx="${eyeRX-1.5}" cy="${eyeY-2.5}" r="1.5" fill="#FFFFFF"/>
        `;
        mouth = `<ellipse cx="${cx}" cy="${cy+19}" rx="3" ry="4" fill="#212121"/>`;
    } else { // smile
        eyeShape = `
            <ellipse cx="${eyeLX}" cy="${eyeY}" rx="6" ry="9" fill="${eye}"/>
            <circle cx="${eyeLX}" cy="${eyeY}" r="2.5" fill="#212121"/>
            <circle cx="${eyeLX-1.5}" cy="${eyeY-2}" r="1.2" fill="#FFFFFF"/>
            <ellipse cx="${eyeRX}" cy="${eyeY}" rx="6" ry="9" fill="${eye}"/>
            <circle cx="${eyeRX}" cy="${eyeY}" r="2.5" fill="#212121"/>
            <circle cx="${eyeRX-1.5}" cy="${eyeY-2}" r="1.2" fill="#FFFFFF"/>
        `;
        mouth = `
            <path d="M${cx-7},${cy+17} Q${cx},${cy+22} ${cx+7},${cy+17}" stroke="#212121" stroke-width="2" fill="none" stroke-linecap="round"/>
            <path d="M${cx},${cy+15} L${cx},${cy+17}" stroke="#212121" stroke-width="2" stroke-linecap="round"/>
        `;
    }

    // 鼻子
    const nose = `<path d="M${cx-3},${cy+10} L${cx+3},${cy+10} L${cx},${cy+14} Z" fill="#F06292"/>`;
    // 胡须
    const whiskers = `
        <line x1="${cx-15}" y1="${cy+8}" x2="${cx-40}" y2="${cy+5}" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="${cx-15}" y1="${cy+12}" x2="${cx-40}" y2="${cy+13}" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="${cx+15}" y1="${cy+8}" x2="${cx+40}" y2="${cy+5}" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="${cx+15}" y1="${cy+12}" x2="${cx+40}" y2="${cy+13}" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
    `;

    // 配饰
    let accessory = "";
    if (acc === "wizard_hat") {
        accessory = `<path d="M${cx-30},${cy-90} L${cx},${cy-160} L${cx+30},${cy-90} Z" fill="${accCol}"/><circle cx="${cx-15}" cy="${cy-110}" r="3" fill="#FFD700"/><circle cx="${cx+10}" cy="${cy-130}" r="2" fill="#FFD700"/>`;
    } else if (acc === "chef_hat") {
        accessory = `<rect x="${cx-32}" y="${cy-110}" width="64" height="20" rx="4" fill="${accCol}"/><circle cx="${cx-22}" cy="${cy-125}" r="18" fill="${accCol}"/><circle cx="${cx}" cy="${cy-135}" r="22" fill="${accCol}"/><circle cx="${cx+22}" cy="${cy-125}" r="18" fill="${accCol}"/>`;
    } else if (acc === "helmet") {
        accessory = `<circle cx="${cx}" cy="${cy-30}" r="78" fill="${accCol}" opacity="0.35" stroke="${accCol}" stroke-width="3"/>`;
    } else if (acc === "mask") {
        accessory = `<rect x="${cx-55}" y="${cy-12}" width="110" height="14" fill="${accCol}" opacity="0.85"/>`;
    } else if (acc === "headband") {
        accessory = `<rect x="${cx-65}" y="${cy-78}" width="130" height="10" fill="${accCol}"/><circle cx="${cx}" cy="${cy-73}" r="8" fill="#FFD700"/>`;
    } else if (acc === "pirate_hat") {
        accessory = `<path d="M${cx-55},${cy-80} Q${cx},${cy-130} ${cx+55},${cy-80} Q${cx+45},${cy-95} ${cx},${cy-100} Q${cx-45},${cy-95} ${cx-55},${cy-80} Z" fill="${accCol}"/><text x="${cx}" y="${cy-95}" font-size="14" fill="#FFFFFF" text-anchor="middle">☠</text>`;
    } else if (acc === "magnifier") {
        accessory = `<circle cx="${cx+50}" cy="${cy+25}" r="18" fill="none" stroke="${accCol}" stroke-width="4"/><line x1="${cx+62}" y1="${cy+38}" x2="${cx+78}" y2="${cy+54}" stroke="${accCol}" stroke-width="5" stroke-linecap="round"/>`;
    } else if (acc === "headphones") {
        accessory = `<path d="M${cx-65},${cy-30} Q${cx},${cy-105} ${cx+65},${cy-30}" stroke="${accCol}" stroke-width="6" fill="none"/><ellipse cx="${cx-65}" cy="${cy-25}" rx="12" ry="18" fill="${accCol}"/><ellipse cx="${cx+65}" cy="${cy-25}" rx="12" ry="18" fill="${accCol}"/>`;
    } else if (acc === "beret") {
        accessory = `<ellipse cx="${cx}" cy="${cy-92}" rx="48" ry="14" fill="${accCol}"/><circle cx="${cx-40}" cy="${cy-95}" r="6" fill="${accCol}"/>`;
    } else if (acc === "goggles") {
        accessory = `<circle cx="${eyeLX}" cy="${eyeY}" r="13" fill="none" stroke="${accCol}" stroke-width="3"/><circle cx="${eyeRX}" cy="${eyeY}" r="13" fill="none" stroke="${accCol}" stroke-width="3"/><line x1="${eyeLX+13}" y1="${eyeY}" x2="${eyeRX-13}" y2="${eyeY}" stroke="${accCol}" stroke-width="3"/>`;
    } else if (acc === "headset") {
        accessory = `<path d="M${cx-65},${cy-30} Q${cx},${cy-105} ${cx+65},${cy-30}" stroke="${accCol}" stroke-width="6" fill="none"/><ellipse cx="${cx-65}" cy="${cy-25}" rx="12" ry="18" fill="${accCol}"/><ellipse cx="${cx+65}" cy="${cy-25}" rx="12" ry="18" fill="${accCol}"/><circle cx="${cx-58}" cy="${cy+5}" r="3" fill="#FF1744"/>`;
    } else if (acc === "glasses") {
        accessory = `<circle cx="${eyeLX}" cy="${eyeY}" r="12" fill="none" stroke="${accCol}" stroke-width="2.5"/><circle cx="${eyeRX}" cy="${eyeY}" r="12" fill="none" stroke="${accCol}" stroke-width="2.5"/><line x1="${eyeLX+12}" y1="${eyeY}" x2="${eyeRX-12}" y2="${eyeY}" stroke="${accCol}" stroke-width="2.5"/>`;
    } else if (acc === "scarf") {
        accessory = `<rect x="${cx-50}" y="${cy+45}" width="100" height="15" fill="${accCol}" rx="3"/><rect x="${cx-15}" y="${cy+58}" width="20" height="22" fill="${accCol}"/>`;
    } else if (acc === "bow") {
        accessory = `<path d="M${cx-25},${cy-78} L${cx-5},${cy-68} L${cx-25},${cy-58} Z" fill="${accCol}"/><path d="M${cx+25},${cy-78} L${cx+5},${cy-68} L${cx+25},${cy-58} Z" fill="${accCol}"/><circle cx="${cx}" cy="${cy-68}" r="5" fill="${accCol}"/>`;
    } else if (acc === "yarn_ball") {
        accessory = `<circle cx="${cx+55}" cy="${cy+35}" r="14" fill="${accCol}"/><path d="M${cx+45},${cy+30} Q${cx+55},${cy+25} ${cx+65},${cy+35}" stroke="#FFFFFF" stroke-width="1.5" fill="none"/><path d="M${cx+45},${cy+38} Q${cx+55},${cy+45} ${cx+65},${cy+38}" stroke="#FFFFFF" stroke-width="1.5" fill="none"/>`;
    } else if (acc === "box") {
        accessory = `<rect x="${cx-50}" y="${cy+50}" width="100" height="35" fill="${accCol}" opacity="0.8"/><line x1="${cx-50}" y1="${cy+62}" x2="${cx+50}" y2="${cy+62}" stroke="#5D4037" stroke-width="2"/>`;
    } else if (acc === "stars") {
        accessory = `<text x="${cx-55}" y="${cy-65}" font-size="14" fill="${accCol}">✦</text><text x="${cx+45}" y="${cy-55}" font-size="11" fill="${accCol}">✦</text><text x="${cx-30}" y="${cy-100}" font-size="10" fill="${accCol}">✦</text>`;
    } else if (acc === "antenna") {
        accessory = `<line x1="${cx-25}" y1="${cy-100}" x2="${cx-25}" y2="${cy-130}" stroke="${accCol}" stroke-width="3"/><circle cx="${cx-25}" cy="${cy-132}" r="4" fill="#F44336"/><line x1="${cx+25}" y1="${cy-100}" x2="${cx+25}" y2="${cy-130}" stroke="${accCol}" stroke-width="3"/><circle cx="${cx+25}" cy="${cy-132}" r="4" fill="#F44336"/>`;
    } else if (acc === "flower") {
        accessory = `<circle cx="${cx-58}" cy="${cy-80}" r="6" fill="${accCol}"/><circle cx="${cx-66}" cy="${cy-72}" r="6" fill="${accCol}"/><circle cx="${cx-50}" cy="${cy-72}" r="6" fill="${accCol}"/><circle cx="${cx-58}" cy="${cy-76}" r="3" fill="#FFD700"/>`;
    } else if (acc === "moon") {
        accessory = `<path d="M${cx+55},${cy-70} A14 14 0 1 0 ${cx+55},${cy-42} A11 11 0 1 1 ${cx+55},${cy-70} Z" fill="${accCol}"/>`;
    } else if (acc === "umbrella") {
        accessory = `<path d="M${cx-38},${cy-78} Q${cx},${cy-115} ${cx+38},${cy-78} Z" fill="${accCol}"/><line x1="${cx}" y1="${cy-78}" x2="${cx}" y2="${cy-50}" stroke="${accCol}" stroke-width="3"/>`;
    } else if (acc === "sun") {
        accessory = `<circle cx="${cx+55}" cy="${cy-65}" r="12" fill="${accCol}"/><line x1="${cx+55}" y1="${cy-85}" x2="${cx+55}" y2="${cy-92}" stroke="${accCol}" stroke-width="2.5"/><line x1="${cx+72}" y1="${cy-65}" x2="${cx+80}" y2="${cy-65}" stroke="${accCol}" stroke-width="2.5"/><line x1="${cx+38}" y1="${cy-65}" x2="${cx+30}" y2="${cy-65}" stroke="${accCol}" stroke-width="2.5"/>`;
    } else if (acc === "cloud") {
        accessory = `<ellipse cx="${cx-30}" cy="${cy-95}" rx="14" ry="9" fill="${accCol}"/><ellipse cx="${cx-15}" cy="${cy-100}" rx="16" ry="11" fill="${accCol}"/><ellipse cx="${cx+5}" cy="${cy-97}" rx="14" ry="9" fill="${accCol}"/>`;
    } else if (acc === "fish") {
        accessory = `<ellipse cx="${cx+55}" cy="${cy+35}" rx="14" ry="7" fill="${accCol}"/><path d="M${cx+68},${cy+35} L${cx+78},${cy+28} L${cx+78},${cy+42} Z" fill="${accCol}"/><circle cx="${cx+50}" cy="${cy+33}" r="1.5" fill="#212121"/>`;
    } else if (acc === "leaf") {
        accessory = `<path d="M${cx-60},${cy-85} Q${cx-50},${cy-100} ${cx-40},${cy-85} Q${cx-50},${cy-78} ${cx-60},${cy-85} Z" fill="${accCol}"/><line x1="${cx-50}" y1="${cy-100}" x2="${cx-50}" y2="${cy-85}" stroke="#1B5E20" stroke-width="1"/>`;
    } else if (acc === "cherry") {
        accessory = `<circle cx="${cx-50}" cy="${cy-72}" r="6" fill="#E53935"/><circle cx="${cx-38}" cy="${cy-78}" r="6" fill="#E53935"/><path d="M${cx-50},${cy-78} Q${cx-44},${cy-90} ${cx-38},${cy-84}" stroke="#388E3C" stroke-width="1.5" fill="none"/>`;
    } else if (acc === "rainbow") {
        accessory = `<path d="M${cx-55},${cy-65} Q${cx},${cy-115} ${cx+55},${cy-65}" stroke="#F44336" stroke-width="3" fill="none"/><path d="M${cx-50},${cy-62} Q${cx},${cy-108} ${cx+50},${cy-62}" stroke="#FF9800" stroke-width="3" fill="none"/><path d="M${cx-45},${cy-59} Q${cx},${cy-101} ${cx+45},${cy-59}" stroke="#FFEB3B" stroke-width="3" fill="none"/><path d="M${cx-40},${cy-56} Q${cx},${cy-94} ${cx+40},${cy-56}" stroke="#4CAF50" stroke-width="3" fill="none"/><path d="M${cx-35},${cy-53} Q${cx},${cy-87} ${cx+35},${cy-53}" stroke="#2196F3" stroke-width="3" fill="none"/>`;
    } else if (acc === "bolt") {
        accessory = `<path d="M${cx+55},${cy-90} L${cx+45},${cy-65} L${cx+58},${cy-65} L${cx+48},${cy-40} L${cx+68},${cy-72} L${cx+55},${cy-72} Z" fill="${accCol}"/>`;
    } else if (acc === "flame") {
        accessory = `<path d="M${cx-25},${cy-100} Q${cx-15},${cy-130} ${cx},${cy-110} Q${cx+10},${cy-140} ${cx+25},${cy-100} Q${cx+5},${cy-90} ${cx-25},${cy-100} Z" fill="${accCol}"/>`;
    } else if (acc === "snowflake") {
        accessory = `<text x="${cx-50}" y="${cy-65}" font-size="20" fill="${accCol}">❄</text><text x="${cx+38}" y="${cy-50}" font-size="14" fill="${accCol}">❄</text>`;
    } else if (acc === "mushroom_hat") {
        accessory = `<ellipse cx="${cx}" cy="${cy-90}" rx="48" ry="22" fill="${accCol}"/><circle cx="${cx-22}" cy="${cy-92}" r="6" fill="#FFFFFF"/><circle cx="${cx+10}" cy="${cy-98}" r="5" fill="#FFFFFF"/><circle cx="${cx+25}" cy="${cy-86}" r="4" fill="#FFFFFF"/>`;
    } else if (acc === "candy") {
        accessory = `<circle cx="${cx+58}" cy="${cy-55}" r="9" fill="${accCol}"/><path d="M${cx+50},${cy-58} L${cx+45},${cy-65} L${cx+48},${cy-52} Z" fill="${accCol}"/><path d="M${cx+66},${cy-58} L${cx+71},${cy-65} L${cx+68},${cy-52} Z" fill="${accCol}"/>`;
    }

    return `<svg viewBox="0 0 200 200" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <path d="${earL}" fill="${body}"/>
        <path d="${earR}" fill="${body}"/>
        <path d="${innerEarL}" fill="#F8BBD0"/>
        <path d="${innerEarR}" fill="#F8BBD0"/>
        <circle cx="${cx}" cy="${cy}" r="${headR}" fill="${body}"/>
        ${patternLayer}
        ${eyeShape}
        ${nose}
        ${mouth}
        ${whiskers}
        ${accessory}
    </svg>`;
}

// 肥猴猫专属：橙黄色 + 香蕉发饰 + 猴子腮
function _sqrBuildFeihouSVG(size) {
    return `<svg viewBox="0 0 200 200" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <radialGradient id="feihouGlow" cx="50%" cy="50%" r="65%">
                <stop offset="0%" stop-color="#FFD54F" stop-opacity="0.5"/>
                <stop offset="100%" stop-color="#FFB347" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <circle cx="100" cy="110" r="92" fill="url(#feihouGlow)"/>
        <path d="M50,65 L28,15 L75,45 Z" fill="#FFB347"/>
        <path d="M150,65 L172,15 L125,45 Z" fill="#FFB347"/>
        <path d="M52,60 L38,28 L68,45 Z" fill="#F8BBD0"/>
        <path d="M148,60 L162,28 L132,45 Z" fill="#F8BBD0"/>
        <ellipse cx="60" cy="125" rx="22" ry="28" fill="#FFD180"/>
        <ellipse cx="140" cy="125" rx="22" ry="28" fill="#FFD180"/>
        <circle cx="100" cy="110" r="62" fill="#FFB347"/>
        <ellipse cx="78" cy="102" rx="7" ry="10" fill="#5D4037"/>
        <circle cx="78" cy="102" r="3" fill="#212121"/>
        <circle cx="76" cy="100" r="1.5" fill="#FFFFFF"/>
        <ellipse cx="122" cy="102" rx="7" ry="10" fill="#5D4037"/>
        <circle cx="122" cy="102" r="3" fill="#212121"/>
        <circle cx="120" cy="100" r="1.5" fill="#FFFFFF"/>
        <path d="M97,120 L103,120 L100,124 Z" fill="#F06292"/>
        <path d="M93,127 Q100,134 107,127" stroke="#212121" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        <line x1="85" y1="118" x2="60" y2="115" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="85" y1="122" x2="60" y2="125" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="115" y1="118" x2="140" y2="115" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="115" y1="122" x2="140" y2="125" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M55,40 Q90,15 100,30 Q105,18 130,25 Q145,40 110,55 Q75,52 55,40 Z" fill="#FFEB3B" stroke="#F9A825" stroke-width="2"/>
        <path d="M58,42 Q90,28 100,38 Q108,28 130,30" stroke="#FBC02D" stroke-width="1.5" fill="none"/>
        <text x="155" y="50" font-size="22">🍌</text>
    </svg>`;
}

// wuwu 猫专属：蒸汽蓝 + 火车头 + 烟囱
function _sqrBuildWuwuSVG(size) {
    return `<svg viewBox="0 0 200 200" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <radialGradient id="wuwuGlow" cx="50%" cy="50%" r="65%">
                <stop offset="0%" stop-color="#90CAF9" stop-opacity="0.55"/>
                <stop offset="100%" stop-color="#6BB6FF" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <circle cx="100" cy="110" r="92" fill="url(#wuwuGlow)"/>
        <ellipse cx="55" cy="40" rx="14" ry="10" fill="#E0E0E0" opacity="0.85"/>
        <ellipse cx="40" cy="30" rx="11" ry="8" fill="#E0E0E0" opacity="0.7"/>
        <ellipse cx="68" cy="22" rx="9" ry="7" fill="#E0E0E0" opacity="0.6"/>
        <path d="M50,65 L28,15 L75,45 Z" fill="#6BB6FF"/>
        <path d="M150,65 L172,15 L125,45 Z" fill="#6BB6FF"/>
        <path d="M52,60 L38,28 L68,45 Z" fill="#F8BBD0"/>
        <path d="M148,60 L162,28 L132,45 Z" fill="#F8BBD0"/>
        <circle cx="100" cy="110" r="62" fill="#6BB6FF"/>
        <rect x="86" y="55" width="28" height="18" fill="#37474F"/>
        <rect x="92" y="40" width="16" height="18" fill="#37474F"/>
        <ellipse cx="100" cy="40" rx="10" ry="3" fill="#212121"/>
        <ellipse cx="78" cy="102" rx="7" ry="10" fill="#FFEB3B"/>
        <circle cx="78" cy="102" r="3" fill="#212121"/>
        <circle cx="76" cy="100" r="1.5" fill="#FFFFFF"/>
        <ellipse cx="122" cy="102" rx="7" ry="10" fill="#FFEB3B"/>
        <circle cx="122" cy="102" r="3" fill="#212121"/>
        <circle cx="120" cy="100" r="1.5" fill="#FFFFFF"/>
        <path d="M97,120 L103,120 L100,124 Z" fill="#F06292"/>
        <path d="M93,127 Q100,134 107,127" stroke="#212121" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        <line x1="85" y1="118" x2="60" y2="115" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="85" y1="122" x2="60" y2="125" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="115" y1="118" x2="140" y2="115" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="115" y1="122" x2="140" y2="125" stroke="#212121" stroke-width="1.2" stroke-linecap="round"/>
        <text x="135" y="155" font-size="22">🚂</text>
    </svg>`;
}

// 雪子猫专属：纯白 + 雪花 + 蓝眼
function _sqrBuildXueziSVG(size) {
    return `<svg viewBox="0 0 200 200" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <radialGradient id="xueziGlow" cx="50%" cy="50%" r="65%">
                <stop offset="0%" stop-color="#E1F5FE" stop-opacity="0.65"/>
                <stop offset="100%" stop-color="#B3E5FC" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <circle cx="100" cy="110" r="92" fill="url(#xueziGlow)"/>
        <text x="20" y="50" font-size="22" fill="#B3E5FC">❄</text>
        <text x="160" y="60" font-size="18" fill="#B3E5FC">❄</text>
        <text x="30" y="170" font-size="16" fill="#B3E5FC">❄</text>
        <text x="165" y="160" font-size="20" fill="#B3E5FC">❄</text>
        <path d="M50,65 L28,15 L75,45 Z" fill="#FAFAFA" stroke="#B3E5FC" stroke-width="1.5"/>
        <path d="M150,65 L172,15 L125,45 Z" fill="#FAFAFA" stroke="#B3E5FC" stroke-width="1.5"/>
        <path d="M52,60 L38,28 L68,45 Z" fill="#F8BBD0"/>
        <path d="M148,60 L162,28 L132,45 Z" fill="#F8BBD0"/>
        <circle cx="100" cy="110" r="62" fill="#FAFAFA" stroke="#E1F5FE" stroke-width="2"/>
        <ellipse cx="78" cy="102" rx="8" ry="11" fill="#0288D1"/>
        <circle cx="78" cy="102" r="3.5" fill="#212121"/>
        <circle cx="76" cy="99" r="2" fill="#FFFFFF"/>
        <circle cx="80" cy="105" r="1" fill="#FFFFFF"/>
        <ellipse cx="122" cy="102" rx="8" ry="11" fill="#0288D1"/>
        <circle cx="122" cy="102" r="3.5" fill="#212121"/>
        <circle cx="120" cy="99" r="2" fill="#FFFFFF"/>
        <circle cx="124" cy="105" r="1" fill="#FFFFFF"/>
        <path d="M97,120 L103,120 L100,124 Z" fill="#F06292"/>
        <path d="M93,127 Q100,132 107,127" stroke="#212121" stroke-width="2" fill="none" stroke-linecap="round"/>
        <text x="78" y="124" font-size="10" fill="#B3E5FC">❄</text>
        <text x="115" y="126" font-size="10" fill="#B3E5FC">❄</text>
        <text x="60" y="100" font-size="9" fill="#B3E5FC">❄</text>
        <text x="135" y="98" font-size="9" fill="#B3E5FC">❄</text>
    </svg>`;
}

// ── SSR 金色粒子特效 ──
function _sqrTriggerSSRParticles(container) {
    const canvas = document.createElement("canvas");
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:99;";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const particles = [];
    const N = 60;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    for (let i = 0; i < N; i++) {
        const angle = (Math.PI * 2 * i) / N + Math.random() * 0.3;
        const speed = 2 + Math.random() * 4;
        particles.push({
            x: cx, y: cy,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 1,
            life: 1.0,
            size: 2 + Math.random() * 3,
            hue: 40 + Math.random() * 20,
        });
    }
    let raf;
    const start = performance.now();
    const render = (now) => {
        const t = (now - start) / 1000;
        if (t > 2.2) {
            cancelAnimationFrame(raf);
            try { container.removeChild(canvas); } catch(e) {}
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.08;
            p.life -= 0.014;
            if (p.life <= 0) continue;
            ctx.beginPath();
            ctx.fillStyle = `hsla(${p.hue}, 100%, 65%, ${p.life})`;
            ctx.shadowBlur = 8;
            ctx.shadowColor = `hsla(${p.hue}, 100%, 70%, ${p.life})`;
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
        raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
}

// ── 抽卡弹框 ──
function _sqrShowGachaDialog() {
    document.getElementById("sqr-gacha-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "sqr-gacha-overlay";
    Object.assign(overlay.style, {
        position: "fixed", inset: "0", zIndex: "10020",
        background: "rgba(0,0,0,.78)",
        display: "flex", alignItems: "center", justifyContent: "center",
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
        background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 100%)",
        color: "#fff", border: "2px solid rgba(255,215,0,0.4)",
        borderRadius: "16px", padding: "26px 30px", width: "480px",
        maxWidth: "calc(100vw - 40px)", maxHeight: "90vh", overflowY: "auto",
        boxShadow: "0 10px 50px rgba(0,0,0,.85), 0 0 80px rgba(255,215,0,0.15)",
        position: "relative", textAlign: "center",
    });
    const _xBtn = document.createElement("button");
    _xBtn.textContent = "×";
    _xBtn.style.cssText = "position:absolute;top:12px;right:16px;background:none;border:none;font-size:24px;cursor:pointer;color:#aaa;line-height:1;";
    _xBtn.onmouseover = () => _xBtn.style.color = "#fff";
    _xBtn.onmouseout = () => _xBtn.style.color = "#aaa";
    _xBtn.onclick = () => overlay.remove();
    box.appendChild(_xBtn);

    const title = document.createElement("div");
    title.textContent = "🎰  猫猫扭蛋";
    title.style.cssText = "font-size:18px;font-weight:700;margin-bottom:6px;letter-spacing:1px;color:#FFD700;";
    box.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.style.cssText = "font-size:12px;opacity:.65;margin-bottom:16px;";
    box.appendChild(subtitle);

    const stage = document.createElement("div");
    stage.style.cssText = "min-height:340px;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;";
    box.appendChild(stage);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;justify-content:center;";
    box.appendChild(btnRow);

    const footer = document.createElement("div");
    footer.style.cssText = "font-size:11px;opacity:.55;margin-top:12px;text-align:right;";
    box.appendChild(footer);

    const mkBtn = (label, onClick, bg, disabled) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.disabled = !!disabled;
        b.style.cssText = `padding:8px 16px;border-radius:8px;font-size:13px;cursor:${disabled?"not-allowed":"pointer"};border:none;background:${disabled?"#444":bg};color:#fff;font-weight:600;opacity:${disabled?".5":"1"};transition:.15s ease;`;
        if (!disabled) {
            b.onmouseover = () => { b.style.transform = "translateY(-1px)"; b.style.boxShadow = "0 4px 12px rgba(0,0,0,0.4)"; };
            b.onmouseout  = () => { b.style.transform = ""; b.style.boxShadow = ""; };
        }
        b.onclick = onClick;
        return b;
    };

    const updateFooter = () => {
        const col = _sqrGetCollection();
        const owned = Object.keys(col).length;
        footer.textContent = `已收集：${owned} / ${SQR_CAT_DB.length}`;
    };

    const renderIdle = () => {
        const tickets = _sqrGetTickets();
        stage.innerHTML = "";
        btnRow.innerHTML = "";
        subtitle.textContent = tickets > 0
            ? `🎟 你有 ${tickets} 张抽卡券`
            : "🎟 暂无抽卡券";
        const idleArt = document.createElement("div");
        idleArt.style.cssText = "font-size:88px;line-height:1;margin:30px 0 16px;filter:drop-shadow(0 4px 12px rgba(255,215,0,0.3));";
        idleArt.textContent = "🎴";
        stage.appendChild(idleArt);
        const idleHint = document.createElement("div");
        idleHint.style.cssText = "font-size:13px;opacity:.7;line-height:1.7;max-width:340px;";
        if (tickets > 0) {
            idleHint.innerHTML = `点击下方按钮抽取一只猫猫。`;
        } else {
            idleHint.innerHTML = `抽卡券消耗完了！<br>去"执行模式"完整跑一次工作流，可获得 +3 张抽卡券。`;
        }
        stage.appendChild(idleHint);

        if (tickets > 0) {
            btnRow.appendChild(mkBtn("✨ 抽一张", drawOne, "linear-gradient(135deg,#FFD700,#FFA000)"));
            if (tickets >= 5) {
                btnRow.appendChild(mkBtn(`🎰 全抽 (${tickets})`, drawAll, "linear-gradient(135deg,#9C27B0,#673AB7)"));
            }
        }
        btnRow.appendChild(mkBtn("📖 图鉴", () => { _sqrShowCollectionDialog(); }, "linear-gradient(135deg,#1976D2,#1565C0)"));
        btnRow.appendChild(mkBtn("关闭", () => overlay.remove(), "#555"));
        updateFooter();
    };

    const renderSingleResult = (cat, isNew) => {
        stage.innerHTML = "";
        btnRow.innerHTML = "";
        subtitle.textContent = `剩余抽卡券：${_sqrGetTickets()}`;
        const meta = SQR_RARITY_META[cat.rarity];

        // 卡牌容器
        const card = document.createElement("div");
        card.style.cssText = `display:flex;flex-direction:column;align-items:center;padding:16px 20px;border-radius:12px;background:${meta.bg};border:2px solid ${meta.border};box-shadow:0 0 30px ${meta.color}40;animation:sqrCatFlipIn .55s ease-out;position:relative;`;
        stage.appendChild(card);

        // CSS 关键帧（注入一次）
        if (!document.getElementById("sqr-gacha-keyframes")) {
            const st = document.createElement("style");
            st.id = "sqr-gacha-keyframes";
            st.textContent = `
                @keyframes sqrCatFlipIn { 0% { transform: scale(.3) rotate(-180deg); opacity: 0; } 60% { transform: scale(1.08) rotate(8deg); opacity: 1; } 100% { transform: scale(1) rotate(0deg); opacity: 1; } }
                @keyframes sqrCatFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
                @keyframes sqrCatNewBadge { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }
            `;
            document.head.appendChild(st);
        }

        const svgWrap = document.createElement("div");
        svgWrap.style.cssText = "animation:sqrCatFloat 2.4s ease-in-out infinite;";
        svgWrap.innerHTML = _sqrBuildCatSVG(cat, 180);
        card.appendChild(svgWrap);

        const rarityLine = document.createElement("div");
        rarityLine.style.cssText = `font-size:14px;font-weight:700;color:${meta.color};margin-top:8px;letter-spacing:2px;text-shadow:0 0 8px ${meta.color}80;`;
        rarityLine.textContent = meta.label;
        card.appendChild(rarityLine);

        const nameLine = document.createElement("div");
        nameLine.style.cssText = "font-size:20px;font-weight:700;margin-top:4px;";
        nameLine.textContent = `${cat.name} ${cat.emoji}`;
        card.appendChild(nameLine);

        if (isNew) {
            const newBadge = document.createElement("div");
            newBadge.textContent = "✦ 首次获得 ✦";
            newBadge.style.cssText = "font-size:11px;font-weight:700;color:#FFD700;margin-top:4px;letter-spacing:1px;animation:sqrCatNewBadge 1.4s ease-in-out infinite;";
            card.appendChild(newBadge);
        }

        const descLine = document.createElement("div");
        descLine.style.cssText = "font-size:12px;opacity:.85;margin-top:10px;line-height:1.6;font-style:italic;max-width:320px;";
        descLine.textContent = `「${cat.desc}」`;
        card.appendChild(descLine);

        if (cat.rarity === "SSR") {
            // 延迟一点触发粒子，等卡牌动画完成
            setTimeout(() => _sqrTriggerSSRParticles(stage), 350);
        }

        // 操作按钮
        const tickets = _sqrGetTickets();
        if (tickets > 0) {
            btnRow.appendChild(mkBtn(`✨ 再抽一张 (${tickets})`, drawOne, "linear-gradient(135deg,#FFD700,#FFA000)"));
        }
        btnRow.appendChild(mkBtn("📖 图鉴", () => { _sqrShowCollectionDialog(); }, "linear-gradient(135deg,#1976D2,#1565C0)"));
        btnRow.appendChild(mkBtn("关闭", () => overlay.remove(), "#555"));
        updateFooter();
    };

    const renderMultiResult = (results) => {
        stage.innerHTML = "";
        btnRow.innerHTML = "";
        subtitle.textContent = `本轮共抽 ${results.length} 张`;

        // 顶部统计
        const stats = { SSR: 0, SR: 0, R: 0, N: 0 };
        let newCount = 0;
        results.forEach(r => { stats[r.cat.rarity]++; if (r.isNew) newCount++; });
        const statLine = document.createElement("div");
        statLine.style.cssText = "display:flex;gap:12px;margin:8px 0 14px;justify-content:center;flex-wrap:wrap;";
        ["SSR","SR","R","N"].forEach(k => {
            if (stats[k] === 0) return;
            const m = SQR_RARITY_META[k];
            const tag = document.createElement("div");
            tag.style.cssText = `padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;background:${m.bg};color:${m.color};border:1px solid ${m.border};`;
            tag.textContent = `${k} × ${stats[k]}`;
            statLine.appendChild(tag);
        });
        stage.appendChild(statLine);
        const newLine = document.createElement("div");
        newLine.style.cssText = "font-size:12px;color:#FFD700;margin-bottom:10px;";
        newLine.textContent = `🆕 新收集 ${newCount} 只`;
        stage.appendChild(newLine);

        // 网格展示
        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(5,1fr);gap:8px;max-height:340px;overflow-y:auto;padding:6px;";
        results.forEach(r => {
            const m = SQR_RARITY_META[r.cat.rarity];
            const cell = document.createElement("div");
            cell.style.cssText = `padding:6px;border-radius:6px;background:${m.bg};border:1.5px solid ${m.border};display:flex;flex-direction:column;align-items:center;${r.isNew?"box-shadow:0 0 8px "+m.color+";":""}`;
            cell.title = `${m.label} · ${r.cat.name}\n${r.cat.desc}${r.isNew?"\n（首次获得）":""}`;
            const sw = document.createElement("div");
            sw.innerHTML = _sqrBuildCatSVG(r.cat, 64);
            cell.appendChild(sw);
            const lbl = document.createElement("div");
            lbl.textContent = r.cat.name;
            lbl.style.cssText = `font-size:10px;font-weight:600;color:${m.color};margin-top:3px;text-align:center;`;
            cell.appendChild(lbl);
            grid.appendChild(cell);
        });
        stage.appendChild(grid);

        const tickets = _sqrGetTickets();
        if (tickets > 0) {
            btnRow.appendChild(mkBtn(`✨ 再抽一张 (${tickets})`, drawOne, "linear-gradient(135deg,#FFD700,#FFA000)"));
        }
        btnRow.appendChild(mkBtn("📖 图鉴", () => { _sqrShowCollectionDialog(); }, "linear-gradient(135deg,#1976D2,#1565C0)"));
        btnRow.appendChild(mkBtn("关闭", () => overlay.remove(), "#555"));
        updateFooter();
    };

    const drawOne = () => {
        if (!_sqrUseTicket()) { renderIdle(); return; }
        const cat = _sqrDrawCat();
        const isNew = _sqrRecordCat(cat.id);
        renderSingleResult(cat, isNew);
    };

    const drawAll = () => {
        const tickets = _sqrGetTickets();
        if (tickets <= 0) { renderIdle(); return; }
        const results = [];
        for (let i = 0; i < tickets; i++) {
            if (!_sqrUseTicket()) break;
            const cat = _sqrDrawCat();
            const isNew = _sqrRecordCat(cat.id);
            results.push({ cat, isNew });
        }
        renderMultiResult(results);
    };

    overlay.appendChild(box);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);

    renderIdle();
}

// ── 图鉴界面 ──
function _sqrShowCollectionDialog() {
    document.getElementById("sqr-collection-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "sqr-collection-overlay";
    Object.assign(overlay.style, {
        position: "fixed", inset: "0", zIndex: "10025",
        background: "rgba(0,0,0,.80)",
        display: "flex", alignItems: "center", justifyContent: "center",
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
        background: "linear-gradient(160deg, #1a1a2e 0%, #16213e 100%)",
        color: "#fff", border: "1.5px solid rgba(255,255,255,0.1)",
        borderRadius: "14px", padding: "22px 26px", width: "780px",
        maxWidth: "calc(100vw - 40px)", maxHeight: "92vh", overflowY: "auto",
        boxShadow: "0 10px 50px rgba(0,0,0,.85)",
        position: "relative",
    });

    const _xBtn = document.createElement("button");
    _xBtn.textContent = "×";
    _xBtn.style.cssText = "position:absolute;top:12px;right:16px;background:none;border:none;font-size:24px;cursor:pointer;color:#aaa;line-height:1;";
    _xBtn.onmouseover = () => _xBtn.style.color = "#fff";
    _xBtn.onmouseout = () => _xBtn.style.color = "#aaa";
    _xBtn.onclick = () => overlay.remove();
    box.appendChild(_xBtn);

    const title = document.createElement("div");
    title.textContent = "📖  猫猫图鉴";
    title.style.cssText = "font-size:18px;font-weight:700;margin-bottom:8px;letter-spacing:1px;";
    box.appendChild(title);

    const collection = _sqrGetCollection();
    const owned = Object.keys(collection).length;
    const ownedByRarity = { SSR: 0, SR: 0, R: 0, N: 0 };
    SQR_CAT_DB.forEach(c => { if (collection[c.id]) ownedByRarity[c.rarity]++; });
    const totalByRarity = { SSR: 0, SR: 0, R: 0, N: 0 };
    SQR_CAT_DB.forEach(c => totalByRarity[c.rarity]++);

    // 进度条
    const progressWrap = document.createElement("div");
    progressWrap.style.cssText = "margin-bottom:6px;";
    const progressLabel = document.createElement("div");
    progressLabel.textContent = `收集进度：${owned} / ${SQR_CAT_DB.length}  (${(owned*100/SQR_CAT_DB.length).toFixed(0)}%)`;
    progressLabel.style.cssText = "font-size:13px;font-weight:600;margin-bottom:4px;";
    progressWrap.appendChild(progressLabel);
    const barOuter = document.createElement("div");
    barOuter.style.cssText = "width:100%;height:10px;background:rgba(255,255,255,0.08);border-radius:5px;overflow:hidden;";
    const barInner = document.createElement("div");
    barInner.style.cssText = `width:${(owned*100/SQR_CAT_DB.length).toFixed(1)}%;height:100%;background:linear-gradient(90deg,#B0BEC5,#64B5F6,#B388FF,#FFD700);transition:.3s ease;`;
    barOuter.appendChild(barInner);
    progressWrap.appendChild(barOuter);
    box.appendChild(progressWrap);

    // 稀有度统计行
    const rarityLine = document.createElement("div");
    rarityLine.style.cssText = "display:flex;gap:14px;margin:8px 0 14px;font-size:11px;flex-wrap:wrap;";
    ["SSR","SR","R","N"].forEach(k => {
        const m = SQR_RARITY_META[k];
        const tag = document.createElement("div");
        tag.style.cssText = `padding:3px 8px;border-radius:5px;background:${m.bg};color:${m.color};border:1px solid ${m.border};font-weight:600;`;
        tag.textContent = `${k}: ${ownedByRarity[k]} / ${totalByRarity[k]}`;
        rarityLine.appendChild(tag);
    });
    box.appendChild(rarityLine);

    // 筛选按钮
    const filterRow = document.createElement("div");
    filterRow.style.cssText = "display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;";
    let activeFilter = "all";
    const filterDefs = [
        { key: "all", label: "全部" },
        { key: "SSR", label: "SSR" },
        { key: "SR", label: "SR" },
        { key: "R", label: "R" },
        { key: "N", label: "N" },
        { key: "owned", label: "已收集" },
        { key: "locked", label: "未收集" },
    ];
    const filterBtns = {};
    filterDefs.forEach(f => {
        const b = document.createElement("button");
        b.textContent = f.label;
        b.style.cssText = "padding:5px 12px;border-radius:14px;border:1px solid #555;background:rgba(255,255,255,0.05);color:#ddd;cursor:pointer;font-size:12px;transition:.15s ease;";
        b.onclick = () => { activeFilter = f.key; updateFilterStyles(); renderGrid(); };
        filterRow.appendChild(b);
        filterBtns[f.key] = b;
    });
    const updateFilterStyles = () => {
        Object.entries(filterBtns).forEach(([k, b]) => {
            const active = (k === activeFilter);
            b.style.background = active ? "rgba(100,181,246,0.25)" : "rgba(255,255,255,0.05)";
            b.style.borderColor = active ? "#64B5F6" : "#555";
            b.style.color = active ? "#90CAF9" : "#ddd";
        });
    };
    updateFilterStyles();
    box.appendChild(filterRow);

    // 网格
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(10,1fr);gap:6px;";
    box.appendChild(grid);

    const renderGrid = () => {
        grid.innerHTML = "";
        SQR_CAT_DB.forEach(cat => {
            const isOwned = !!collection[cat.id];
            // 应用筛选
            if (activeFilter !== "all") {
                if (activeFilter === "owned" && !isOwned) return;
                if (activeFilter === "locked" && isOwned) return;
                if (["SSR","SR","R","N"].includes(activeFilter) && cat.rarity !== activeFilter) return;
            }
            const m = SQR_RARITY_META[cat.rarity];
            const cell = document.createElement("div");
            cell.style.cssText = `position:relative;aspect-ratio:1;border-radius:7px;border:1.5px solid ${isOwned?m.border:"rgba(255,255,255,0.08)"};background:${isOwned?m.bg:"rgba(255,255,255,0.03)"};display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.15s ease;overflow:hidden;`;
            if (isOwned) {
                cell.innerHTML = _sqrBuildCatSVG(cat, 56);
                const info = collection[cat.id];
                const dateStr = info?.firstAt ? new Date(info.firstAt).toLocaleDateString() : "";
                cell.title = `${m.label}\n${cat.name} ${cat.emoji}\n${cat.desc}\n首次获得：${dateStr}\n累计抽到：${info?.count || 1} 次`;
            } else {
                cell.innerHTML = `<div style="font-size:24px;opacity:.4;">？</div>`;
                cell.title = `${m.label}\n???`;
            }
            cell.onmouseover = () => { cell.style.transform = "translateY(-2px) scale(1.05)"; cell.style.zIndex = "5"; cell.style.boxShadow = isOwned ? `0 4px 14px ${m.color}55` : "0 4px 14px rgba(0,0,0,0.5)"; };
            cell.onmouseout  = () => { cell.style.transform = ""; cell.style.zIndex = ""; cell.style.boxShadow = ""; };
            grid.appendChild(cell);
        });
        if (grid.children.length === 0) {
            const empty = document.createElement("div");
            empty.textContent = "（此筛选下没有任何猫）";
            empty.style.cssText = "grid-column:1/-1;text-align:center;padding:20px;font-size:12px;opacity:.5;";
            grid.appendChild(empty);
        }
    };
    renderGrid();

    // 底部操作
    const footer = document.createElement("div");
    footer.style.cssText = "margin-top:16px;display:flex;justify-content:space-between;align-items:center;font-size:11px;opacity:.55;";
    const tip = document.createElement("div");
    tip.textContent = `🎟 当前抽卡券：${_sqrGetTickets()}  ·  鼠标悬停可查看详细信息`;
    footer.appendChild(tip);
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "🔄 重置图鉴";
    resetBtn.style.cssText = "padding:4px 10px;border-radius:5px;border:1px solid rgba(255,80,80,0.4);background:rgba(255,80,80,0.08);color:#ffaaaa;cursor:pointer;font-size:11px;";
    resetBtn.onclick = () => {
        if (!confirm("确认重置图鉴？\n\n所有收集记录和抽卡券都会被清空，无法恢复！")) return;
        _sqrResetGacha();
        overlay.remove();
        _sqrShowCollectionDialog();
    };
    footer.appendChild(resetBtn);
    box.appendChild(footer);

    overlay.appendChild(box);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

// ── 票数发放小提示 ──
function _sqrShowTicketToast(n) {
    const toast = document.createElement("div");
    toast.textContent = `🎁 获得 ${n} 张抽卡券！`;
    toast.style.cssText = "position:fixed;left:50%;bottom:80px;transform:translateX(-50%);padding:12px 24px;background:linear-gradient(135deg,#FFD700,#FFA000);color:#1a1a2e;border-radius:24px;font-size:14px;font-weight:700;box-shadow:0 6px 30px rgba(255,215,0,0.5);z-index:10030;animation:sqrToastIn .4s ease-out;";
    if (!document.getElementById("sqr-toast-keyframes")) {
        const st = document.createElement("style");
        st.id = "sqr-toast-keyframes";
        st.textContent = "@keyframes sqrToastIn { 0% { transform: translate(-50%, 30px); opacity: 0; } 100% { transform: translate(-50%, 0); opacity: 1; } }";
        document.head.appendChild(st);
    }
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = "opacity .5s ease, transform .5s ease";
        toast.style.opacity = "0";
        toast.style.transform = "translate(-50%, -10px)";
        setTimeout(() => toast.remove(), 600);
    }, 2400);
}
// ═══════════════════════════════════════════════════════════════════
// ── 猫猫扭蛋系统结束 ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════


// ── 远程环境检测 ──────────────────────────────────────────────────
function _sqrIsRemote() {
    const h = window.location.hostname;
    return h !== "localhost" && h !== "127.0.0.1" && h !== "::1";
}

/**
 * 统一使用浏览器原生文件选择框选图片，上传到服务器 input/ 目录。
 * 返回 Promise<string[]>  已保存的文件名列表（相对 input/ 的名称）
 */
function _sqrPickAndUploadImages() {
    return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "image/png,image/jpeg,image/webp,image/bmp,.png,.jpg,.jpeg,.webp,.bmp";
        inp.multiple = true;
        inp.style.display = "none";
        document.body.appendChild(inp);
        inp.onchange = async () => {
            document.body.removeChild(inp);
            const files = [...inp.files];
            if (!files.length) { resolve([]); return; }
            const prog = _sqrUploadProgressUI(`正在上传 ${files.length} 张图片…`);
            try {
                const fd = new FormData();
                files.forEach(f => fd.append("files[]", f, f.name));
                const resp = await fetch("/sqr/upload_images", { method: "POST", body: fd });
                const data = await resp.json();
                prog.remove();
                if (data.error) { alert(`上传出错：${data.error}`); resolve([]); return; }
                resolve(data.saved || []);
            } catch (e) {
                prog.remove();
                alert(`上传失败：${e.message}`);
                resolve([]);
            }
        };
        inp.oncancel = () => { document.body.removeChild(inp); resolve([]); };
        inp.click();
    });
}

/**
 * 统一使用浏览器原生文件选择框选视频，上传到服务器 input/ 目录。
 * 返回 Promise<string>  已保存的文件名（或 ""）
 */
function _sqrPickAndUploadVideo() {
    return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "video/mp4,video/quicktime,video/x-msvideo,video/webm,.mp4,.mov,.avi,.mkv,.webm";
        inp.multiple = false;
        inp.style.display = "none";
        document.body.appendChild(inp);
        inp.onchange = async () => {
            document.body.removeChild(inp);
            const file = inp.files[0];
            if (!file) { resolve(""); return; }
            const prog = _sqrUploadProgressUI(`正在上传视频：${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）…`);
            try {
                const fd = new FormData();
                fd.append("file", file, file.name);
                const resp = await fetch("/sqr/upload_video", { method: "POST", body: fd });
                const data = await resp.json();
                prog.remove();
                if (data.error) { alert(`上传出错：${data.error}`); resolve(""); return; }
                resolve(data.saved || "");
            } catch (e) {
                prog.remove();
                alert(`上传失败：${e.message}`);
                resolve("");
            }
        };
        inp.oncancel = () => { document.body.removeChild(inp); resolve(""); };
        inp.click();
    });
}

/** 上传中的全屏遮罩提示 */
function _sqrUploadProgressUI(msg) {
    if (!document.getElementById("sqr-spin-style")) {
        const st = document.createElement("style");
        st.id = "sqr-spin-style";
        st.textContent = "@keyframes sqr-spin{to{transform:rotate(360deg)}}";
        document.head.appendChild(st);
    }
    const el = document.createElement("div");
    Object.assign(el.style, {
        position: "fixed", inset: "0", zIndex: "20000",
        background: "rgba(0,0,0,.65)",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexDirection: "column", gap: "16px",
        color: "#fff", fontSize: "15px", fontWeight: "600",
    });
    const spinner = document.createElement("div");
    spinner.style.cssText = "width:44px;height:44px;border:4px solid rgba(255,255,255,.2);border-top-color:#4cf;border-radius:50%;animation:sqr-spin 0.8s linear infinite;";
    el.append(spinner, Object.assign(document.createElement("div"), { textContent: msg }));
    document.body.appendChild(el);
    return el;
}

// ── SQR 上游节点收集 ──────────────────────────────────────────────
function _sqrCollectUpstream(nodeId, promptOutput, visited) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = promptOutput[nodeId];
    if (!node) return;
    for (const val of Object.values(node.inputs || {})) {
        if (Array.isArray(val) && val.length === 2) {
            const srcId = String(val[0]);
            if (promptOutput[srcId]) {
                _sqrCollectUpstream(srcId, promptOutput, visited);
            }
        }
    }
}


// ── 节点ID设置弹窗 ────────────────────────────────────────────────
function showNodeIdSelector(fields, onConfirm) {
    document.getElementById("sqr-nodeid-overlay")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "sqr-nodeid-overlay";
    Object.assign(overlay.style, {
        position: "fixed", inset: "0", zIndex: "10000",
        background: "rgba(0,0,0,.75)", display: "flex", alignItems: "center", justifyContent: "center",
        padding: "20px"
    });

    const box = document.createElement("div");
    Object.assign(box.style, {
        background: "var(--comfy-menu-bg,#1e1e1e)", color: "var(--input-text,#eee)",
        border: "1px solid var(--border-color,#444)", borderRadius: "14px",
        padding: "18px 18px", width: "720px", maxWidth: "calc(100vw - 56px)",
        maxHeight: "calc(100vh - 36px)", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: "12px",
        boxShadow: "0 8px 40px rgba(0,0,0,.7)", position: "relative"
    });

    const mkDiv = (t, s) => Object.assign(document.createElement("div"), { textContent: t, style: s || "" });
    const basenameOf = (p) => String(p || "").split(/[\\/]/).pop() || "";

    box.appendChild(mkDiv("🔧  设置节点 ID", "font-size:14px;font-weight:600;"));
    box.appendChild(mkDiv("节点 ID 可通过 ComfyUI → 设置 → 画面 → 节点 → 标签 → 显示全部 开启显示", "font-size:11px;opacity:.5;line-height:1.5;"));

    const values = {};
    fields.forEach(f => { values[f.key] = f.value || ""; });

    const localPoseVideoField = fields.find(f => f.key === "本地姿态视频路径");
    const localFaceVideoField = fields.find(f => f.key === "本地人脸视频路径");
    const localPoseIdField = fields.find(f => f.key === "姿态模型节点ID");
    const localFaceIdField = fields.find(f => f.key === "脸部模型节点ID");
    const localKeys = new Set(["姿态模型节点ID", "脸部模型节点ID", "本地姿态视频路径", "本地人脸视频路径"]);

    fields.filter(field => !localKeys.has(field.key)).forEach((field) => {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;";

        const lbl = document.createElement("label");
        lbl.textContent = field.label;
        lbl.title = field.tooltip || "";
        lbl.style.cssText = "font-size:12px;min-width:188px;flex-shrink:0;cursor:help;";

        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = values[field.key] || "";
        inp.placeholder = field.placeholder || "填入节点 ID 数字";
        inp.style.cssText = "flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border-color,#555);background:var(--comfy-input-bg,#333);color:var(--input-text,#eee);font-size:12px;min-width:0;";
        inp.oninput = () => { values[field.key] = inp.value || ""; };

        row.append(lbl, inp);
        box.appendChild(row);
    });

    if (localPoseIdField || localFaceIdField || localPoseVideoField || localFaceVideoField) {
        const group = document.createElement("div");
        group.style.cssText = "margin-top:2px;padding:12px 12px 14px;border:1px solid var(--border-color,#444);border-radius:12px;background:rgba(255,255,255,.015);display:flex;flex-direction:column;gap:12px;";
        const hint = document.createElement("div");
        hint.textContent = "使用本地已保存的骨骼和人脸参考时才需填写此区域，保证骨骼和人脸视频均与主参考视频同源。不需要此功能时此区域留空即可。";
        hint.style.cssText = "font-size:11px;line-height:1.55;opacity:.58;";
        group.appendChild(hint);

        const cols = document.createElement("div");
        cols.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start;";

        const createLocalColumn = ({ title, idKey, videoKey, chooseText, deleteText, pick, fallbackTitle }) => {
            const col = document.createElement("div");
            col.style.cssText = "display:flex;flex-direction:column;gap:9px;min-width:0;";

            const titleEl = document.createElement("div");
            titleEl.textContent = title;
            titleEl.style.cssText = "font-size:12px;color:var(--input-text,#eee);";

            const idInp = document.createElement("input");
            idInp.type = "text";
            idInp.value = values[idKey] || "";
            idInp.placeholder = "填入节点 ID 数字";
            idInp.style.cssText = "padding:8px 12px;border-radius:8px;border:1px solid var(--border-color,#555);background:var(--comfy-input-bg,#333);color:var(--input-text,#eee);font-size:12px;";
            idInp.oninput = () => { values[idKey] = idInp.value || ""; };

            const selectBtn = document.createElement("button");
            selectBtn.type = "button";
            selectBtn.style.cssText = "padding:9px 12px;border-radius:9px;cursor:pointer;font-size:12px;border:1px solid var(--border-color,#555);background:var(--comfy-input-bg,#333);color:var(--input-text,#eee);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
            const renderSelectBtn = () => {
                const cur = values[videoKey] || "";
                if (!cur) {
                    selectBtn.textContent = chooseText;
                    selectBtn.title = fallbackTitle || chooseText;
                    selectBtn.style.color = "var(--input-text,#eee)";
                    selectBtn.style.opacity = "1";
                } else {
                    const fname = basenameOf(cur) || cur;
                    selectBtn.textContent = fname;
                    selectBtn.title = cur;
                    selectBtn.style.color = "#7fffb0";
                    selectBtn.style.opacity = "1";
                }
            };
            selectBtn.onclick = async () => {
                if (typeof pick !== "function") return;
                selectBtn.disabled = true;
                try {
                    const prev = values[videoKey] || "";
                    const nextVal = await pick(prev);
                    if (nextVal !== undefined && nextVal !== null && nextVal !== false) {
                        values[videoKey] = nextVal || "";
                        renderSelectBtn();
                    }
                } finally {
                    selectBtn.disabled = false;
                }
            };
            renderSelectBtn();

            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.textContent = deleteText;
            delBtn.style.cssText = "padding:8px 12px;border-radius:8px;cursor:pointer;font-size:12px;border:1px solid rgba(200,80,80,0.35);background:rgba(180,60,60,0.12);color:#f0a3a3;text-align:center;";
            delBtn.onclick = () => {
                values[videoKey] = "";
                renderSelectBtn();
            };

            col.append(titleEl, idInp, selectBtn, delBtn);
            return col;
        };

        cols.appendChild(createLocalColumn({
            title: "姿态模型节点 ID",
            idKey: "姿态模型节点ID",
            videoKey: "本地姿态视频路径",
            chooseText: "💃选择本地姿态视频🕺",
            deleteText: "删除姿态视频",
            fallbackTitle: localPoseVideoField?.tooltip || "选择与主参考视频同步的本地姿态视频",
            pick: localPoseVideoField?.pick,
        }));

        cols.appendChild(createLocalColumn({
            title: "脸部模型节点 ID",
            idKey: "脸部模型节点ID",
            videoKey: "本地人脸视频路径",
            chooseText: "😉选择本地人脸视频😜",
            deleteText: "删除人脸视频",
            fallbackTitle: localFaceVideoField?.tooltip || "选择与主参考视频同步的本地人脸视频",
            pick: localFaceVideoField?.pick,
        }));

        group.appendChild(cols);
        box.appendChild(group);
    }

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:10px;margin-top:4px;";
    const mkBtn = (t, s, fn) => {
        const b = Object.assign(document.createElement("button"), { textContent: t });
        b.style.cssText = `flex:1;padding:9px 18px;border-radius:9px;cursor:pointer;${s}`;
        b.onclick = fn;
        return b;
    };
    btns.append(
        mkBtn("取消", "", () => overlay.remove()),
        mkBtn("✓ 确认", "background:#2a9;color:#fff;border:none;font-weight:600;", () => {
            onConfirm({ ...values });
            overlay.remove();
        })
    );
    box.appendChild(btns);

    const _xBtn = document.createElement("button");
    _xBtn.textContent = "×";
    _xBtn.style.cssText = "position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";
    _xBtn.onmouseover = () => _xBtn.style.color = "#fff";
    _xBtn.onmouseout = () => _xBtn.style.color = "var(--input-text,#aaa)";
    _xBtn.onclick = () => overlay.remove();
    box.appendChild(_xBtn);

    overlay.appendChild(box);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.body.appendChild(overlay);
}

// ── 手动分段调整弹窗（可滚动时间轴版）──────────────────────────────
// 完整替换 segment_queue.js 中原有的 showManualSegmentDialog 函数

function showManualSegmentDialog(totalFrames, frameRate, initialSegList, onConfirm, videoInfo) {
    document.getElementById("sqr-manseg-overlay")?.remove();
    // 需求3: 手动分段对话框的吸附下限受设置面板里"固定模式下限"的动态约束
    // videoInfo._fixedFrameMin 由调用方从 node._sqrSettings.fixedFrameMin 传入
    const _fmin = parseInt(videoInfo?._fixedFrameMin || 61, 10);
    const MIN_SEG = Math.max(41, isNaN(_fmin) ? 61 : _fmin);
    const PREVIEW_STEP = 4;

    const _memKey = videoInfo?._nodeId ? `sqr_manseg_splits_${videoInfo._nodeId}` : null;
    const _memCountKey = videoInfo?._nodeId ? `sqr_manseg_segcount_${videoInfo._nodeId}` : null;
    const _skipStoredSplits = !!videoInfo?._skipStoredSplits;
    let splits = [];
    let restoredFromMemory = false;

    if (_memKey && !_skipStoredSplits) {
        try {
            const savedSplits = JSON.parse(localStorage.getItem(_memKey) || "null");
            const savedCount = parseInt(localStorage.getItem(_memCountKey) || "0");
            if (savedSplits && Array.isArray(savedSplits) && savedSplits.length > 0) {
                const currentSegCount = initialSegList.length;
                if (savedCount === currentSegCount) {
                    const valid = savedSplits.every(s => typeof s === 'number' && s > 0 && s < totalFrames);
                    if (valid) { splits = savedSplits.slice(); restoredFromMemory = true; }
                } else if (savedCount > 0 && currentSegCount > 0) {
                    const validOld = savedSplits.filter(s => typeof s === 'number' && s > 0 && s < totalFrames);
                    if (currentSegCount > savedCount && validOld.length > 0) {
                        splits = validOld.slice();
                        for (let add = splits.length; add < currentSegCount - 1; add++) {
                            const boundaries = [0, ...splits.sort((a,b)=>a-b), totalFrames];
                            let maxLen = 0, maxIdx = 0;
                            for (let i = 0; i < boundaries.length - 1; i++) {
                                const len = boundaries[i+1] - boundaries[i];
                                if (len > maxLen) { maxLen = len; maxIdx = i; }
                            }
                            if (maxLen >= MIN_SEG * 2) {
                                const mid = boundaries[maxIdx] + Math.floor(maxLen / 2);
                                let k = Math.round((mid - boundaries[maxIdx] - 1) / 4);
                                if (k < Math.ceil((MIN_SEG - 1) / 4)) k = Math.ceil((MIN_SEG - 1) / 4);
                                const ns = boundaries[maxIdx] + k * 4 + 1;
                                if (ns > boundaries[maxIdx] + MIN_SEG && boundaries[maxIdx+1] - ns >= MIN_SEG) {
                                    splits.push(ns);
                                }
                            }
                        }
                        splits.sort((a,b)=>a-b);
                        restoredFromMemory = true;
                    } else if (currentSegCount < savedCount && validOld.length > 0) {
                        splits = validOld.sort((a,b)=>a-b).slice(0, currentSegCount - 1);
                        restoredFromMemory = true;
                    }
                }
            }
        } catch(e) {}
    }

    if (!restoredFromMemory) {
        for (let i = 1; i < initialSegList.length; i++) {
            splits.push(initialSegList[i][0]);
        }
    }

    function snapSplit(rawFrame, splitIdx) {
        const prevBoundary = splitIdx === 0 ? 0 : splits[splitIdx - 1];
        const nextBoundary = splitIdx === splits.length - 1 ? totalFrames : splits[splitIdx + 1];
        let segLen = rawFrame - prevBoundary;
        let k = Math.round((segLen - 1) / 4);
        if (k < Math.ceil((MIN_SEG - 1) / 4)) k = Math.ceil((MIN_SEG - 1) / 4);
        let snapped = prevBoundary + k * 4 + 1;
        const maxAllowed = nextBoundary - MIN_SEG;
        if (snapped > maxAllowed) {
            k = Math.floor((maxAllowed - prevBoundary - 1) / 4);
            if (k < Math.ceil((MIN_SEG - 1) / 4)) return null;
            snapped = prevBoundary + k * 4 + 1;
        }
        if (snapped < prevBoundary + MIN_SEG) return null;
        return snapped;
    }

    function formatTime(frame0) {
        const t = frame0 / frameRate;
        const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.round((t % 1) * 100);
        return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + ':' + String(cs).padStart(2,'0');
    }

    function formatSeconds(sec) {
        const t = Math.max(0, Number(sec) || 0);
        const m = Math.floor(t / 60), s = Math.floor(t % 60), cs = Math.round((t % 1) * 100);
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ':' + String(cs).padStart(2, '0');
    }

    const SIZE_W_KEY = "sqr_manseg_w", SIZE_H_KEY = "sqr_manseg_h";
    const MIN_BOX_W = 1080, MIN_BOX_H = 480;
    let boxW = Math.max(MIN_BOX_W, parseInt(localStorage.getItem(SIZE_W_KEY)) || 1100);
    let boxH = Math.max(MIN_BOX_H, parseInt(localStorage.getItem(SIZE_H_KEY)) || 620);

    const overlay = document.createElement("div");
    overlay.id = "sqr-manseg-overlay";
    Object.assign(overlay.style, {
        position:"fixed", inset:"0", zIndex:"10000",
        background:"rgba(0,0,0,.8)", display:"flex", alignItems:"center", justifyContent:"center"
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
        background:"var(--comfy-menu-bg,#1e1e1e)", color:"var(--input-text,#eee)",
        border:"1px solid var(--border-color,#444)", borderRadius:"12px",
        padding:"20px 24px", width:boxW+"px", height:boxH+"px",
        display:"flex", flexDirection:"column", gap:"10px",
        boxShadow:"0 8px 40px rgba(0,0,0,.7)", position:"relative", overflow:"hidden"
    });
    const mkDiv = (t, s) => Object.assign(document.createElement("div"), { textContent: t, style: s || "" });

    function addResizeHandle(corner) {
        const h = document.createElement("div");
        const cursors = {nw:"nw-resize", ne:"ne-resize", sw:"sw-resize", se:"se-resize"};
        const pos = {
            nw:{top:"-2px", left:"-2px"}, ne:{top:"-2px", right:"-2px"},
            sw:{bottom:"-2px", left:"-2px"}, se:{bottom:"-2px", right:"-2px"}
        };
        Object.assign(h.style, { position:"absolute", width:"18px", height:"18px", zIndex:"10", cursor:cursors[corner], ...pos[corner] });
        h.onmousedown = (e) => {
            e.preventDefault(); e.stopPropagation();
            const startX = e.clientX, startY = e.clientY;
            const startRect = box.getBoundingClientRect();
            const onMove = (e2) => {
                const dx = e2.clientX - startX, dy = e2.clientY - startY;
                let newW = startRect.width, newH = startRect.height;
                if (corner.includes('e')) newW = startRect.width + dx;
                if (corner.includes('w')) newW = startRect.width - dx;
                if (corner.includes('s')) newH = startRect.height + dy;
                if (corner.includes('n')) newH = startRect.height - dy;
                newW = Math.max(MIN_BOX_W, newW);
                newH = Math.max(MIN_BOX_H, newH);
                box.style.width = newW + "px";
                box.style.height = newH + "px";
                boxW = newW;
                boxH = newH;
                recalcCanvas();
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                localStorage.setItem(SIZE_W_KEY, String(Math.round(boxW)));
                localStorage.setItem(SIZE_H_KEY, String(Math.round(boxH)));
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        };
        box.appendChild(h);
    }
    ["nw","ne","sw","se"].forEach(addResizeHandle);

    box.appendChild(mkDiv("✂️  手动分段调整", "font-size:15px;font-weight:700;flex-shrink:0;"));
    const infoLine = mkDiv("", "font-size:11px;opacity:.5;line-height:1.5;flex-shrink:0;");
    function updateInfoLine() {
        const selTxt = selectedSplit >= 0 ? `  当前预览分割线：第${selectedSplit + 1}根` : "  先点选一根分割竖线再预览";
        infoLine.textContent = `总帧数：${totalFrames}  帧率：${frameRate.toFixed(2)}fps  共${splits.length + 1}段  拖竖条调整（自动吸附4n+1，最少${MIN_SEG}帧/段）  滚轮左右滚动  拖四角缩放窗口${selTxt}`;
    }
    box.appendChild(infoLine);
    if (Array.isArray(videoInfo?.localAlignNotes) && videoInfo.localAlignNotes.length) {
        box.appendChild(mkDiv(`已自动对齐：${videoInfo.localAlignNotes.join(" ")}`, "font-size:11px;line-height:1.5;color:#f7c66a;flex-shrink:0;"));
    }

    const timelineWrap = document.createElement("div");
    Object.assign(timelineWrap.style, {
        position:"relative", width:"100%", flex:"1", minHeight:"220px",
        border:"1px solid var(--border-color,#444)", borderRadius:"8px",
        background:"rgba(255,255,255,0.03)", overflow:"hidden", userSelect:"none"
    });

    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block;";
    timelineWrap.appendChild(canvas);

    const previewStage = document.createElement("div");
    previewStage.style.cssText = "position:absolute;left:40px;right:40px;top:8px;height:120px;display:flex;align-items:flex-start;justify-content:center;pointer-events:none;z-index:2;";
    const previewCard = document.createElement("div");
    previewCard.style.cssText = "position:relative;height:100%;max-width:100%;display:flex;align-items:center;justify-content:center;background:#111;border:1.5px solid #4cf;border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.35);overflow:hidden;";
    const previewVideo = document.createElement("video");
    previewVideo.preload = "auto";
    previewVideo.playsInline = true;
    previewVideo.controls = false;
    previewVideo.style.cssText = "display:none;height:100%;max-width:100%;background:#111;pointer-events:none;";
    const previewFallback = document.createElement("img");
    previewFallback.style.cssText = "display:none;height:100%;max-width:100%;background:#111;pointer-events:none;";
    const previewCaption = document.createElement("div");
    previewCaption.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:3px 10px;background:rgba(0,0,0,.72);color:#9ee7ff;font:700 10px monospace;text-align:center;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    previewCard.append(previewVideo, previewFallback, previewCaption);
    previewStage.appendChild(previewCard);
    timelineWrap.appendChild(previewStage);

    let previewImg = null;
    let previewLoading = false;
    let previewFrameNum = -1;
    let previewTimer = null;
    let selectedSplit = splits.length > 0 ? 0 : -1;
    let previewFrame = selectedSplit >= 0 ? splits[selectedSplit] : 0;
    let dragging = -1;
    let draggingSB = false;
    let scrollOffset = 0;
    let sbDragStartX = 0, sbDragStartOffset = 0;
    let CSS_W = 720, CSS_H = 200, VIEWPORT_W = 0, barY = 0, barH = 0, SB_Y = 0, SB_H = 0, PREVIEW_H = 0;
    const PAD_L = 40, PAD_R = 40;
    const MIN_SEG_PX = 100;
    let videoReady = false;
    let videoErrored = false;
    let playing = false;
    let playRaf = 0;
    let fallbackPrevTs = 0;
    let boundaryFlashUntil = 0;
    let boundaryNoticeTimer = 0;
    let boundaryNoticeText = "";

    function dialogFrameToVideoFrame(dialogFrame) {
        if (!videoInfo) return Math.max(0, Math.round(dialogFrame));
        const fo = videoInfo.frameOffset || 0;
        const nth = Math.max(1, videoInfo.selectEveryNth || 1);
        const skip = videoInfo.skipFirst || 0;
        const processedFrame = dialogFrame + fo;
        const preNthFrame = processedFrame * nth;
        const preSkipFrame = preNthFrame + skip;
        if ((videoInfo.forceRate || 0) > 0 && (videoInfo.originalFps || 0) > 0) {
            return Math.round(preSkipFrame * videoInfo.originalFps / videoInfo.forceRate);
        }
        return Math.round(preSkipFrame);
    }

    function videoFrameToDialogFrame(videoFrame) {
        if (!videoInfo) return videoFrame;
        const origFps = videoInfo.originalFps || 0;
        const forceRate = videoInfo.forceRate || 0;
        const nth = Math.max(1, videoInfo.selectEveryNth || 1);
        const skip = videoInfo.skipFirst || 0;
        const fo = videoInfo.frameOffset || 0;
        let scaled = Number(videoFrame) || 0;
        if (forceRate > 0 && origFps > 0) scaled = scaled * forceRate / origFps;
        return (scaled - skip) / nth - fo;
    }

    function dialogFrameToVideoTime(dialogFrame) {
        if ((videoInfo?.originalFps || 0) > 0) return Math.max(0, dialogFrameToVideoFrame(dialogFrame) / videoInfo.originalFps);
        return Math.max(0, dialogFrame / Math.max(frameRate, 1e-6));
    }

    function videoTimeToDialogFrame(sec) {
        if ((videoInfo?.originalFps || 0) > 0) return videoFrameToDialogFrame(sec * videoInfo.originalFps);
        return sec * frameRate;
    }

    function clampPreviewFrame(v) {
        if (!Number.isFinite(v) || totalFrames <= 0) return 0;
        return Math.max(0, Math.min(totalFrames - 1, Math.round(v)));
    }

    function requestFramePreview(dialogFrame) {
        if (!videoInfo?.file) return;
        const vf = dialogFrameToVideoFrame(dialogFrame);
        if (vf === previewFrameNum && previewImg) return;
        previewFrameNum = vf;
        if (previewLoading || previewTimer) return;
        previewTimer = setTimeout(() => {
            previewTimer = null;
            previewLoading = true;
            const img = new Image();
            img.onload = () => {
                previewImg = img;
                previewLoading = false;
                previewFallback.src = img.src;
                previewFallback.style.display = (!videoReady || videoErrored) ? "block" : "none";
                draw();
            };
            img.onerror = () => { previewLoading = false; };
            img.src = `/sqr/video_frame_at?file=${encodeURIComponent(videoInfo.file)}&frame=${vf}&w=420`;
        }, 35);
    }

    function getSelectedSplitFrame() {
        if (selectedSplit < 0 || selectedSplit >= splits.length) return 0;
        return splits[selectedSplit];
    }

    function ensureFrameVisible(frame) {
        const x = frameToSX(frame);
        const margin = 48;
        if (x < PAD_L + margin) {
            scrollOffset = Math.max(0, scrollOffset - ((PAD_L + margin) - x));
        } else if (x > PAD_L + VIEWPORT_W - margin) {
            scrollOffset = Math.min(getMaxScroll(), scrollOffset + (x - (PAD_L + VIEWPORT_W - margin)));
        }
    }

    function seekPreviewToFrame(dialogFrame, force = false) {
        previewFrame = clampPreviewFrame(dialogFrame);
        if (videoReady && !videoErrored) {
            const target = dialogFrameToVideoTime(previewFrame);
            if (force || Math.abs((previewVideo.currentTime || 0) - target) > 0.015) {
                try { previewVideo.currentTime = Math.max(0, Math.min(target, previewVideo.duration || target)); } catch(e) {}
            }
            previewFallback.style.display = "none";
        } else {
            requestFramePreview(previewFrame);
            previewFallback.style.display = previewImg ? "block" : "none";
        }
    }

    function syncSelectedSplitFromPreview() {
        if (selectedSplit < 0 || selectedSplit >= splits.length) return false;
        const snapped = snapSplit(previewFrame, selectedSplit);
        if (snapped === null) return false;
        if (splits[selectedSplit] !== snapped) {
            splits[selectedSplit] = snapped;
            ensureFrameVisible(snapped);
            return true;
        }
        return false;
    }

    function getMaxPlayableFrameForSplit(idx) {
        if (idx < 0 || idx >= splits.length) return totalFrames - 1;
        const prevBoundary = idx === 0 ? 0 : splits[idx - 1];
        const nextBoundary = idx === splits.length - 1 ? totalFrames : splits[idx + 1];
        let k = Math.floor((nextBoundary - MIN_SEG - prevBoundary - 1) / 4);
        if (k < Math.ceil((MIN_SEG - 1) / 4)) return prevBoundary + MIN_SEG;
        return Math.max(prevBoundary + MIN_SEG, prevBoundary + k * 4 + 1);
    }

    function refreshPreviewMedia(forceSeek = false) {
        if (playing) return;
        seekPreviewToFrame(previewFrame, forceSeek);
        updateTransportUI();
        draw();
    }

    function isBoundaryFlashActive() {
        return boundaryFlashUntil > performance.now();
    }

    function showBoundaryNotice(msg, duration = 1600) {
        boundaryNoticeText = msg || "";
        boundaryFlashUntil = performance.now() + duration;
        if (boundaryNoticeTimer) clearTimeout(boundaryNoticeTimer);
        if (boundaryNoticeText) {
            boundaryNoticeTimer = setTimeout(() => {
                boundaryNoticeTimer = 0;
                boundaryNoticeText = "";
                updateTransportUI();
                draw();
            }, duration + 40);
        }
        updateTransportUI();
        draw();
    }

    function updatePreviewCaption() {
        const splitFrame = getSelectedSplitFrame();
        const splitText = selectedSplit >= 0 ? `第${selectedSplit + 1}根分割线：第${splitFrame + 1}帧` : "先点选一根分割竖线";
        const liveText = `连续预览：第${previewFrame + 1}帧 ${formatTime(previewFrame)}`;
        previewCaption.textContent = `${splitText} ｜ ${liveText}`;
        const activeColor = playing ? "#7fffb0" : "#4cf";
        previewCard.style.borderColor = selectedSplit >= 0 ? activeColor : "rgba(255,255,255,0.28)";
        previewCaption.style.color = selectedSplit >= 0 ? (playing ? "#7fffb0" : "#9ee7ff") : "rgba(255,255,255,0.7)";
    }

    function updateTransportUI() {
        playBtn.textContent = playing ? "⏸ 暂停" : "▶ 播放";
        if (selectedSplit >= 0) {
            posText.textContent = `预览分割线：第${selectedSplit + 1}根  落点：第${getSelectedSplitFrame() + 1}帧  连续预览：第${previewFrame + 1}帧 ${formatTime(previewFrame)}`;
        } else {
            posText.textContent = `请先点选一根分割竖线，再用按钮或空格键预览。`;
        }
        if (boundaryNoticeText) {
            statusText.textContent = boundaryNoticeText;
            statusText.style.opacity = isBoundaryFlashActive() ? "0.95" : "0.7";
            statusText.style.color = "#ffd36a";
        } else if (selectedSplit >= 0) {
            statusText.textContent = "单击时间轴空白处，可把当前选中的分割线直接吸附到该位置。";
            statusText.style.opacity = "0.62";
            statusText.style.color = "rgba(255,255,255,0.72)";
        } else {
            statusText.textContent = "先点选一根分割竖线，再进行播放、步进或单击吸附。";
            statusText.style.opacity = "0.5";
            statusText.style.color = "rgba(255,255,255,0.65)";
        }
        playBtn.style.borderColor = playing ? "rgba(60,180,120,0.6)" : "var(--border-color,#555)";
        playBtn.style.color = playing ? "#7fffb0" : "var(--input-text,#eee)";
        updateInfoLine();
        updatePreviewCaption();
    }

    function selectSplit(idx, opts = {}) {
        if (!(idx >= 0 && idx < splits.length)) return;
        selectedSplit = idx;
        previewFrame = clampPreviewFrame(splits[idx]);
        ensureFrameVisible(splits[idx]);
        if (!playing) seekPreviewToFrame(previewFrame, !!opts.forceSeek);
        updateTransportUI();
        if (opts.forceDraw !== false) draw();
    }

    function stopPlayback(keepFrame = true, reason = "") {
        playing = false;
        if (playRaf) {
            cancelAnimationFrame(playRaf);
            playRaf = 0;
        }
        try { previewVideo.pause(); } catch(e) {}
        if (selectedSplit >= 0) {
            previewFrame = clampPreviewFrame(getSelectedSplitFrame());
            seekPreviewToFrame(previewFrame, true);
        }
        if (reason) showBoundaryNotice(reason);
        else updateTransportUI();
        if (keepFrame) draw();
    }

    function stepSelectedSplit(delta) {
        if (selectedSplit < 0) return;
        stopPlayback(false);
        const next = snapSplit(getSelectedSplitFrame() + delta, selectedSplit);
        if (next === null) return;
        splits[selectedSplit] = next;
        previewFrame = clampPreviewFrame(next);
        ensureFrameVisible(next);
        seekPreviewToFrame(previewFrame, true);
        updateSummary();
        updateTransportUI();
        draw();
    }

    function tickPlayback(ts) {
        if (!playing) return;
        let nextPreview = previewFrame;

        if (videoReady && !videoErrored) {
            nextPreview = clampPreviewFrame(videoTimeToDialogFrame(previewVideo.currentTime || 0));
        } else {
            if (!fallbackPrevTs) fallbackPrevTs = ts;
            const dt = Math.max(0, (ts - fallbackPrevTs) / 1000);
            fallbackPrevTs = ts;
            nextPreview = clampPreviewFrame(previewFrame + dt * frameRate);
            requestFramePreview(nextPreview);
        }

        previewFrame = nextPreview;
        const changed = syncSelectedSplitFromPreview();
        if (changed) updateSummary();
        updateTransportUI();
        draw();

        const splitLimit = getMaxPlayableFrameForSplit(selectedSplit);
        if ((videoReady && previewVideo.ended) || previewFrame >= splitLimit || previewFrame >= totalFrames - 1) {
            if (selectedSplit >= 0) previewFrame = clampPreviewFrame(getSelectedSplitFrame());
            const reason = selectedSplit >= 0
                ? `已到第${selectedSplit + 1}根分割线的可编辑边界，已自动暂停。`
                : "已到可编辑边界，已自动暂停。";
            stopPlayback(true, reason);
            return;
        }
        playRaf = requestAnimationFrame(tickPlayback);
    }

    function startPlayback() {
        if (playing || selectedSplit < 0) return;
        fallbackPrevTs = 0;
        playing = true;
        previewFrame = clampPreviewFrame(getSelectedSplitFrame());
        if (videoReady && !videoErrored) {
            seekPreviewToFrame(previewFrame, true);
            const p = previewVideo.play();
            if (p && typeof p.catch === "function") p.catch(() => {});
        } else {
            requestFramePreview(previewFrame);
        }
        updateTransportUI();
        draw();
        playRaf = requestAnimationFrame(tickPlayback);
    }

    function togglePlayback() {
        if (playing) stopPlayback(true);
        else startPlayback();
    }

    function getNumSegs() { return splits.length + 1; }
    function getTotalW() { return Math.max(VIEWPORT_W, getNumSegs() * MIN_SEG_PX); }
    function getMaxScroll() { return Math.max(0, getTotalW() - VIEWPORT_W); }
    function clampScroll() { scrollOffset = Math.max(0, Math.min(getMaxScroll(), scrollOffset)); }
    function frameToSX(f) { return PAD_L + (f / Math.max(1, totalFrames)) * getTotalW() - scrollOffset; }
    function sxToFrame(x) { return Math.round(((x - PAD_L + scrollOffset) / Math.max(1, getTotalW())) * totalFrames); }

    function recalcCanvas() {
        const rect = timelineWrap.getBoundingClientRect();
        CSS_W = Math.round(rect.width) || 720;
        CSS_H = Math.round(rect.height) || 220;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = CSS_W * dpr;
        canvas.height = CSS_H * dpr;
        VIEWPORT_W = CSS_W - PAD_L - PAD_R;
        PREVIEW_H = Math.min(180, Math.max(96, Math.round(CSS_H * 0.46)));
        barY = PREVIEW_H + 18;
        barH = Math.max(28, Math.min(40, Math.round((CSS_H - PREVIEW_H - 90) * 0.42)));
        SB_H = 8;
        SB_Y = CSS_H - 18;
        previewStage.style.left = PAD_L + "px";
        previewStage.style.right = PAD_R + "px";
        previewStage.style.height = PREVIEW_H + "px";
        previewCard.style.height = PREVIEW_H + "px";
        clampScroll();
        draw();
    }

    function getCanvasPos(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: (e.clientX - rect.left) * (CSS_W / rect.width), y: (e.clientY - rect.top) * (CSS_H / rect.height) };
    }

    function getSB() {
        const ms = getMaxScroll();
        if (ms <= 0) return null;
        const trackX = PAD_L, trackW = VIEWPORT_W, ratio = VIEWPORT_W / getTotalW();
        const thumbW = Math.max(30, trackW * ratio);
        const thumbX = trackX + (scrollOffset / ms) * (trackW - thumbW);
        return { trackX, trackW, thumbX, thumbW };
    }

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, CSS_W, CSS_H);
        if (!VIEWPORT_W || VIEWPORT_W <= 0) return;

        const segColors = ["rgba(80,180,120,0.3)", "rgba(80,140,220,0.3)", "rgba(220,160,80,0.3)", "rgba(180,80,180,0.3)", "rgba(220,80,80,0.3)", "rgba(80,220,220,0.3)"];
        const boundaries = [0, ...splits, totalFrames];

        ctx.save();
        ctx.beginPath();
        ctx.rect(PAD_L, 0, VIEWPORT_W, SB_Y - 2);
        ctx.clip();

        const bx1 = frameToSX(0), bx2 = frameToSX(totalFrames);
        ctx.fillStyle = "rgba(80,160,220,0.12)";
        ctx.fillRect(bx1, barY, bx2 - bx1, barH);

        for (let i = 0; i < boundaries.length - 1; i++) {
            const x1 = frameToSX(boundaries[i]), x2 = frameToSX(boundaries[i + 1]);
            ctx.fillStyle = segColors[i % segColors.length];
            ctx.fillRect(x1, barY, x2 - x1, barH);
            const segFrames = boundaries[i + 1] - boundaries[i];
            const cx = (x1 + x2) / 2, w = x2 - x1;
            if (w > 50) {
                ctx.fillStyle = "rgba(255,255,255,0.7)";
                ctx.font = "bold 11px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(`第${i+1}段`, cx, barY + barH / 2 - 6);
                ctx.font = "10px sans-serif";
                ctx.fillStyle = "rgba(255,255,255,0.5)";
                ctx.fillText(`${segFrames}帧`, cx, barY + barH / 2 + 7);
            } else if (w > 25) {
                ctx.fillStyle = "rgba(255,255,255,0.6)";
                ctx.font = "bold 9px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(`${i+1}`, cx, barY + barH / 2);
            }
        }

        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        ctx.strokeRect(bx1, barY, bx2 - bx1, barH);

        for (let i = 0; i < splits.length; i++) {
            const x = frameToSX(splits[i]);
            const isDrag = (dragging === i);
            const isSelected = (selectedSplit === i);
            const isFlashing = isSelected && isBoundaryFlashActive();
            const flashStroke = Math.floor(performance.now() / 120) % 2 === 0 ? "#ffd36a" : "#ff9f43";
            const stroke = isDrag ? "#4cf" : (isFlashing ? flashStroke : (isSelected ? (playing ? "#7fffb0" : "#4cf") : "rgba(255,255,255,0.8)"));
            const fill = isDrag ? "#4cf" : (isFlashing ? "#ffd36a" : (isSelected ? (playing ? "#7fffb0" : "#7fdfff") : "#ccc"));
            ctx.strokeStyle = stroke;
            ctx.lineWidth = isDrag ? 3 : (isSelected ? 2.8 : 2);
            ctx.beginPath();
            ctx.moveTo(x, barY - 14);
            ctx.lineTo(x, barY + barH + 14);
            ctx.stroke();
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.moveTo(x, barY - 14);
            ctx.lineTo(x - 6, barY - 22);
            ctx.lineTo(x + 6, barY - 22);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = stroke;
            ctx.font = "bold 10px monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.fillText(formatTime(splits[i]), x, barY - 24);
            ctx.textBaseline = "top";
            ctx.fillText(String(splits[i]), x, barY + barH + 32);
            if (isSelected) {
                ctx.font = "bold 9px sans-serif";
                ctx.fillText(playing ? "预览中" : "预览线", x, barY + barH + 46);
            }
        }

        const sx = frameToSX(0);
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("第1帧", sx, barY + barH + 32);
        ctx.fillText(formatTime(0), sx, barY + barH + 44);

        const ex = frameToSX(totalFrames);
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(`第${totalFrames}帧`, ex, barY + barH + 32);
        ctx.fillText(formatTime(totalFrames), ex, barY + barH + 44);

        ctx.restore();

        const sb = getSB();
        if (sb) {
            ctx.fillStyle = "rgba(255,255,255,0.06)";
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(sb.trackX, SB_Y, sb.trackW, SB_H, 4);
            else ctx.rect(sb.trackX, SB_Y, sb.trackW, SB_H);
            ctx.fill();

            ctx.fillStyle = draggingSB ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.22)";
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(sb.thumbX, SB_Y, sb.thumbW, SB_H, 4);
            else ctx.rect(sb.thumbX, SB_Y, sb.thumbW, SB_H);
            ctx.fill();

            ctx.fillStyle = "rgba(255,255,255,0.2)";
            ctx.font = "8px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText("← 滚轮左右滚动 →", CSS_W / 2, SB_Y + SB_H + 2);
        }

        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
    }

    const transportBar = document.createElement("div");
    transportBar.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;";
    const mkCtrlBtn = (text, onClick, extraStyle="") => {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.cssText = `padding:6px 14px;border-radius:7px;cursor:pointer;font-size:12px;background:var(--comfy-input-bg,#2b2b2b);border:1px solid var(--border-color,#555);color:var(--input-text,#eee);${extraStyle}`;
        b.onclick = onClick;
        return b;
    };
    const backBtn = mkCtrlBtn("⏪ -4帧", () => stepSelectedSplit(-PREVIEW_STEP));
    const playBtn = mkCtrlBtn("▶ 播放", togglePlayback, "min-width:92px;font-weight:600;");
    const nextBtn = mkCtrlBtn("+4帧 ⏩", () => stepSelectedSplit(PREVIEW_STEP));
    const posText = mkDiv("", "font-size:11px;opacity:.78;font-family:monospace;padding-left:4px;");
    transportBar.append(backBtn, playBtn, nextBtn, posText);

    const statusText = mkDiv("", "font-size:10px;line-height:1.55;min-height:16px;padding-left:4px;flex-shrink:0;transition:opacity .12s ease;");

    box.appendChild(timelineWrap);
    box.appendChild(transportBar);
    box.appendChild(statusText);

    const transportHint = document.createElement("div");
    transportHint.style.cssText = "font-size:10px;opacity:.55;line-height:1.65;flex-shrink:0;";
    transportHint.innerHTML = "快捷键：<span style='color:#ddd'>空格</span> 播放/暂停，<span style='color:#ddd'>←</span> 预览分割线后退 4 帧，<span style='color:#ddd'>→</span> 预览分割线前进 4 帧（方向键/小键盘方向键均可）。<br>操作：先点选一根分割竖线；单击时间轴空白处，可把这根分割线直接吸附到点击位置；播放触达可编辑边界时，会自动暂停并提示。<br>说明：现在预览窗口会按源视频做<span style='color:#ddd'>连续播放</span>，所以画面是流畅连续的；但你点选的那根分割竖线仍会按 <span style='color:#ddd'>4 帧</span> 步长跳动，这样暂停时分割落点依然满足每段 <span style='color:#ddd'>4n+1</span> 的规则。";
    box.appendChild(transportHint);

    const summaryDiv = document.createElement("div");
    summaryDiv.style.cssText = "font-size:11px;opacity:.7;padding:4px 0;line-height:1.8;font-family:monospace;max-height:100px;overflow-y:auto;flex-shrink:0;";
    function updateSummary() {
        updateInfoLine();
        const boundaries = [0, ...splits, totalFrames];
        const parts = [];
        for (let i = 0; i < boundaries.length - 1; i++) {
            const raw = boundaries[i + 1] - boundaries[i];
            const limit = ((raw + 2) >> 2) * 4 + 1;
            const start1 = boundaries[i] + 1;
            const end1 = boundaries[i + 1];
            parts.push(`<span style="color:${["#5d9","#6af","#fa6","#c8f","#f88","#6dd"][i % 6]}">第${i+1}段</span>: 帧${start1}~${end1} (skip=${boundaries[i]} limit=${limit})`);
        }
        summaryDiv.innerHTML = parts.join("&nbsp;&nbsp;│&nbsp;&nbsp;");
        updateTransportUI();
    }
    box.appendChild(summaryDiv);

    const splitBtns = document.createElement("div");
    splitBtns.style.cssText = "display:flex;gap:8px;flex-shrink:0;";
    const addSplitBtn = document.createElement("button");
    addSplitBtn.textContent = "➕ 增加分段";
    addSplitBtn.style.cssText = "padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;background:rgba(60,180,120,0.15);border:1px solid rgba(60,180,120,0.4);color:#6d9;";
    addSplitBtn.onclick = () => {
        const boundaries = [0, ...splits, totalFrames];
        let maxLen = 0, maxIdx = 0;
        for (let i = 0; i < boundaries.length - 1; i++) {
            const len = boundaries[i + 1] - boundaries[i];
            if (len > maxLen) { maxLen = len; maxIdx = i; }
        }
        if (maxLen < MIN_SEG * 2) return;
        const mid = boundaries[maxIdx] + Math.floor(maxLen / 2), prev = boundaries[maxIdx];
        let k = Math.round((mid - prev - 1) / 4);
        if (k < Math.ceil((MIN_SEG - 1) / 4)) k = Math.ceil((MIN_SEG - 1) / 4);
        let newSplit = prev + k * 4 + 1;
        if (boundaries[maxIdx + 1] - newSplit < MIN_SEG) { k--; newSplit = prev + k * 4 + 1; }
        if (newSplit > prev + MIN_SEG && boundaries[maxIdx + 1] - newSplit >= MIN_SEG) {
            splits.push(newSplit);
            splits.sort((a,b)=>a-b);
            selectedSplit = splits.indexOf(newSplit);
            previewFrame = clampPreviewFrame(newSplit);
            ensureFrameVisible(newSplit);
            refreshPreviewMedia(true);
            updateSummary();
        }
    };
    const rmSplitBtn = document.createElement("button");
    rmSplitBtn.textContent = "➖ 减少分段";
    rmSplitBtn.style.cssText = "padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;background:rgba(200,80,80,0.15);border:1px solid rgba(200,80,80,0.4);color:#f88;";
    rmSplitBtn.onclick = () => {
        if (splits.length <= 0) return;
        const removedSelected = selectedSplit >= splits.length - 1;
        splits.pop();
        if (!splits.length) selectedSplit = -1;
        else if (removedSelected) selectedSplit = splits.length - 1;
        previewFrame = selectedSplit >= 0 ? clampPreviewFrame(splits[selectedSplit]) : 0;
        refreshPreviewMedia(true);
        clampScroll();
        updateSummary();
        draw();
    };
    splitBtns.append(addSplitBtn, rmSplitBtn);
    box.appendChild(splitBtns);

    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;gap:8px;flex-shrink:0;";
    const mkBtn = (t, s, fn) => {
        const b = document.createElement("button");
        b.textContent = t;
        b.style.cssText = `flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;
        b.onclick = fn;
        return b;
    };

    function saveSplitsMemory() {
        if (_memKey) {
            try {
                localStorage.setItem(_memKey, JSON.stringify(splits));
                localStorage.setItem(_memCountKey, String(splits.length + 1));
            } catch(e) {}
        }
    }

    btns.append(
        mkBtn("取消", "", () => { saveSplitsMemory(); overlay.remove(); onConfirm(null); }),
        mkBtn("重置", "", () => {
            stopPlayback(false);
            splits = [];
            for (let i = 1; i < initialSegList.length; i++) splits.push(initialSegList[i][0]);
            selectedSplit = splits.length > 0 ? 0 : -1;
            previewFrame = selectedSplit >= 0 ? clampPreviewFrame(splits[selectedSplit]) : 0;
            scrollOffset = 0;
            refreshPreviewMedia(true);
            updateSummary();
        }),
        mkBtn("✓ 确认", "background:#2a9;color:#fff;border:none;font-weight:600;", () => {
            saveSplitsMemory();
            overlay.remove();
            onConfirm(splits);
        })
    );
    box.appendChild(btns);

    if (videoInfo?.file) {
        previewVideo.src = `/sqr/video_serve?file=${encodeURIComponent(videoInfo.file)}`;
        previewVideo.addEventListener("loadedmetadata", () => {
            videoReady = true;
            videoErrored = false;
            previewVideo.style.display = "block";
            previewFallback.style.display = "none";
            seekPreviewToFrame(previewFrame, true);
            updateTransportUI();
        });
        previewVideo.addEventListener("ended", () => stopPlayback(true));
        previewVideo.addEventListener("error", () => {
            videoErrored = true;
            videoReady = false;
            previewVideo.style.display = "none";
            requestFramePreview(previewFrame);
            previewFallback.style.display = previewImg ? "block" : "none";
            updateTransportUI();
        });
    }

    const _xBtn = document.createElement("button");
    _xBtn.textContent = "×";
    _xBtn.style.cssText = "position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;z-index:11;";
    _xBtn.onmouseover = () => _xBtn.style.color = "#fff";
    _xBtn.onmouseout = () => _xBtn.style.color = "var(--input-text,#aaa)";
    _xBtn.onclick = () => { saveSplitsMemory(); overlay.remove(); onConfirm(null); };
    box.appendChild(_xBtn);
    overlay.appendChild(box);
    overlay.onclick = (e) => { if (e.target === overlay) { saveSplitsMemory(); overlay.remove(); onConfirm(null); } };
    document.body.appendChild(overlay);

    canvas.onmousedown = (e) => {
        const pos = getCanvasPos(e);
        const sb = getSB();
        if (sb && pos.y >= SB_Y - 4 && pos.y <= SB_Y + SB_H + 4) {
            if (pos.x >= sb.thumbX && pos.x <= sb.thumbX + sb.thumbW) {
                draggingSB = true;
                sbDragStartX = pos.x;
                sbDragStartOffset = scrollOffset;
                canvas.style.cursor = "grabbing";
                return;
            }
            const ratio = Math.max(0, Math.min(1, (pos.x - sb.trackX) / sb.trackW));
            scrollOffset = ratio * getMaxScroll();
            clampScroll();
            draw();
            return;
        }
        for (let i = 0; i < splits.length; i++) {
            if (Math.abs(pos.x - frameToSX(splits[i])) < 12) {
                stopPlayback(false);
                dragging = i;
                selectedSplit = i;
                previewFrame = clampPreviewFrame(splits[i]);
                canvas.style.cursor = "ew-resize";
                seekPreviewToFrame(previewFrame, true);
                updateTransportUI();
                draw();
                updateSummary();
                return;
            }
        }
        if (selectedSplit >= 0 && pos.x >= PAD_L && pos.x <= PAD_L + VIEWPORT_W && pos.y >= Math.max(0, barY - 28) && pos.y <= SB_Y - 6) {
            stopPlayback(false);
            const snapped = snapSplit(sxToFrame(pos.x), selectedSplit);
            if (snapped !== null) {
                splits[selectedSplit] = snapped;
                previewFrame = clampPreviewFrame(snapped);
                ensureFrameVisible(snapped);
                seekPreviewToFrame(previewFrame, true);
                updateSummary();
                draw();
            }
            return;
        }
    };

    canvas.onmousemove = (e) => {
        const pos = getCanvasPos(e);
        if (draggingSB) {
            const sb = getSB();
            if (!sb) return;
            const dx = pos.x - sbDragStartX;
            const ms = getMaxScroll();
            const mt = sb.trackW - sb.thumbW;
            scrollOffset = sbDragStartOffset + (mt > 0 ? (dx / mt) * ms : 0);
            clampScroll();
            draw();
            return;
        }
        if (dragging >= 0) {
            const edgeZone = 40, scrollSpeed = 4;
            if (pos.x < PAD_L + edgeZone && scrollOffset > 0) {
                scrollOffset = Math.max(0, scrollOffset - scrollSpeed);
            } else if (pos.x > PAD_L + VIEWPORT_W - edgeZone && scrollOffset < getMaxScroll()) {
                scrollOffset = Math.min(getMaxScroll(), scrollOffset + scrollSpeed);
            }
            const rawFrame = sxToFrame(pos.x);
            const snapped = snapSplit(rawFrame, dragging);
            if (snapped !== null) {
                splits[dragging] = snapped;
                previewFrame = clampPreviewFrame(snapped);
                selectedSplit = dragging;
                seekPreviewToFrame(previewFrame, true);
            }
            updateTransportUI();
            draw();
            updateSummary();
            return;
        }
        let nearSplit = false;
        for (let i = 0; i < splits.length; i++) {
            if (Math.abs(pos.x - frameToSX(splits[i])) < 12) { nearSplit = true; break; }
        }
        const sb = getSB();
        const onSB = sb && pos.y >= SB_Y - 4 && pos.y <= SB_Y + SB_H + 4 && pos.x >= sb.thumbX && pos.x <= sb.thumbX + sb.thumbW;
        canvas.style.cursor = nearSplit ? "ew-resize" : (onSB ? "grab" : "default");
    };

    canvas.onmouseup = () => {
        if (dragging >= 0) {
            selectedSplit = dragging;
            previewFrame = clampPreviewFrame(splits[dragging]);
            seekPreviewToFrame(previewFrame, true);
        }
        dragging = -1;
        draggingSB = false;
        canvas.style.cursor = "default";
        draw();
        updateSummary();
    };

    canvas.onmouseleave = () => {
        if (dragging >= 0 || draggingSB) {
            if (dragging >= 0) {
                selectedSplit = dragging;
                previewFrame = clampPreviewFrame(splits[dragging]);
                seekPreviewToFrame(previewFrame, true);
            }
            dragging = -1;
            draggingSB = false;
            canvas.style.cursor = "default";
            draw();
            updateSummary();
        }
    };

    canvas.onwheel = (e) => {
        e.preventDefault();
        scrollOffset += (e.deltaY > 0 ? 60 : -60);
        clampScroll();
        draw();
    };

    function isEditableTarget(el) {
        return !!(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable));
    }

    const onKeyDown = (e) => {
        if (!overlay.isConnected || isEditableTarget(e.target)) return;
        if (e.code === "Space") {
            e.preventDefault();
            togglePlayback();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            stepSelectedSplit(-PREVIEW_STEP);
        } else if (e.key === "ArrowRight") {
            e.preventDefault();
            stepSelectedSplit(PREVIEW_STEP);
        }
    };
    document.addEventListener("keydown", onKeyDown, true);

    requestAnimationFrame(() => {
        recalcCanvas();
        updateSummary();
        if (selectedSplit >= 0) selectSplit(selectedSplit, { forceDraw: true, forceSeek: true });
        else refreshPreviewMedia(true);
    });

    const _resizeObs = new ResizeObserver(() => recalcCanvas());
    _resizeObs.observe(timelineWrap);

    const _origRemove = overlay.remove.bind(overlay);
    overlay.remove = () => {
        stopPlayback(false);
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        if (boundaryNoticeTimer) { clearTimeout(boundaryNoticeTimer); boundaryNoticeTimer = 0; }
        document.removeEventListener("keydown", onKeyDown, true);
        _resizeObs.disconnect();
        try {
            previewVideo.pause();
            previewVideo.removeAttribute("src");
            previewVideo.load();
        } catch(e) {}
        _origRemove();
    };
}


// ── JS端分段计算辅助（与后端一致）──
function _jsRoundLimitUp(rawFrames) {
    const v = Math.max(0, Math.round(Number(rawFrames) || 0));
    return Math.floor((v + 2) / 4) * 4 + 1;
}

function _jsMaxSegmentCount(totalFrames, minSeg) {
    if (minSeg == null) minSeg = SQR_MIN_SEG;
    const t = Math.max(0, Math.round(Number(totalFrames) || 0));
    if (t <= 0) return 0;
    if (t < minSeg) return 1;
    return Math.max(1, Math.floor(t / Math.max(1, minSeg)));
}

function _jsCalcSegments(totalFrames, segments, minSeg) {
    const MIN_SEG = (minSeg != null) ? minSeg : SQR_MIN_SEG;
    const total = Math.max(0, Math.round(Number(totalFrames) || 0));
    if (total <= 0) return [];
    let requested = Math.max(1, Math.round(Number(segments) || 1));
    let actual = Math.min(requested, _jsMaxSegmentCount(total, MIN_SEG));
    while (actual > 1) {
        const base = Math.ceil(total / actual);
        const perSeg = _jsRoundLimitUp(base);
        const result = [];
        for (let i = 0; i < actual; i++) {
            const skip = i * perSeg;
            if (skip >= total) break;
            const limit = i < actual - 1 ? perSeg : _jsRoundLimitUp(total - skip);
            result.push([skip, limit]);
        }
        if (!result.length) break;
        const tailRaw = total - result[result.length - 1][0];
        if (result.length > 1 && tailRaw < MIN_SEG) {
            actual -= 1;
            continue;
        }
        return result;
    }
    return [[0, _jsRoundLimitUp(total)]];
}


function _jsCalcManualSeedSegments(totalFrames, segments, minSeg) {
    const MIN_SEG = (minSeg != null) ? minSeg : SQR_MIN_SEG;
    const total = Math.max(0, Math.round(Number(totalFrames) || 0));
    if (total <= 0) return [];
    const requested = Math.max(1, Math.round(Number(segments) || 1));
    const actual = Math.min(requested, _jsMaxSegmentCount(total, MIN_SEG));
    if (actual <= 1) return [[0, _jsRoundLimitUp(total)]];

    const baseTotal = actual * MIN_SEG;
    const extra = Math.max(0, total - baseTotal);
    const extraUnits = Math.floor(extra / 4);
    const residual = extra % 4;
    const baseUnits = Math.floor(extraUnits / actual);
    const tailUnits = extraUnits % actual;

    const rawLens = Array.from({ length: actual }, () => MIN_SEG + baseUnits * 4);
    for (let i = actual - tailUnits; i < actual; i++) {
        if (i >= 0 && i < actual) rawLens[i] += 4;
    }
    rawLens[actual - 1] += residual;
    rawLens[actual - 1] += total - rawLens.reduce((a, b) => a + b, 0);

    const result = [];
    let pos = 0;
    for (const raw of rawLens) {
        result.push([pos, _jsRoundLimitUp(raw)]);
        pos += raw;
    }
    return result;
}

function _jsCalcSegmentsByFixed(totalFrames, framesPerSeg, minSeg) {
    const MIN_SEG = (minSeg != null) ? minSeg : SQR_MIN_SEG;
    const fps = Math.max(MIN_SEG, Math.floor((framesPerSeg - 1) / 4) * 4 + 1);
    const result = [];
    let pos = 0;
    while (pos < totalFrames) {
        const remaining = totalFrames - pos;
        if (remaining <= fps) {
            const limit = Math.ceil(remaining / 4) * 4 + 1;
            if (limit < MIN_SEG && result.length > 0) {
                const prev = result[result.length - 1];
                const newRemaining = totalFrames - prev[0];
                result[result.length - 1] = [prev[0], Math.ceil(newRemaining / 4) * 4 + 1];
            } else {
                result.push([pos, limit]);
            }
            break;
        }
        result.push([pos, fps]);
        pos += fps;
    }
    if (!result.length) result.push([0, Math.ceil(totalFrames / 4) * 4 + 1]);
    return result;

}

// ── 辅助函数：定位 / 读取 / 临时覆盖 Load Video ─────────────────────
function _sqrResolveRefLoadVideoNode(sqrNode) {
    const getNodeW = name => sqrNode.widgets?.find(w => w.name === name);
    let vidNode = null;
    const vidNodeId = String(getNodeW("参考视频节点ID")?.value || "").trim();
    if (vidNodeId) {
        vidNode = app.graph?.getNodeById?.(parseInt(vidNodeId));
    }
    if (!vidNode) {
        for (const inputName of ["总帧数", "帧率"]) {
            const inp = sqrNode.inputs?.find(i => i.name === inputName);
            if (inp?.link != null) {
                const link = app.graph?.links?.[inp.link];
                if (link) {
                    vidNode = app.graph?.getNodeById?.(link.origin_id);
                    if (vidNode) break;
                }
            }
        }
    }
    return vidNode || null;
}

function _sqrReadLoadVideoParams(vidNode) {
    const getVW = name => vidNode.widgets?.find(w => w.name === name);
    const videoWidget = getVW("video") || vidNode.widgets?.[0];
    return {
        video: videoWidget?.value || "",
        force_rate: parseFloat(getVW("force_rate")?.value) || 0,
        custom_width: parseInt(getVW("custom_width")?.value) || 0,
        custom_height: parseInt(getVW("custom_height")?.value) || 0,
        frame_load_cap: Math.max(0, parseInt(getVW("frame_load_cap")?.value) || 0),
        skip_first_frames: Math.max(0, parseInt(getVW("skip_first_frames")?.value) || 0),
        select_every_nth: Math.max(1, parseInt(getVW("select_every_nth")?.value) || 1),
        format: getVW("format")?.value ?? "AnimateDiff",
    };
}

function _sqrCalcLoadVideoResult(info, params, ignoreNth = false) {
    let rawFrames = Math.max(0, parseInt(info?.frame_count) || 0);
    let effectiveFps = parseFloat(info?.fps) || 0;
    const forceRate = parseFloat(params?.force_rate) || 0;
    const skipFirst = Math.max(0, parseInt(params?.skip_first_frames) || 0);
    const frameLoadCap = Math.max(0, parseInt(params?.frame_load_cap) || 0);
    const selectEveryNth = Math.max(1, parseInt(params?.select_every_nth) || 1);
    if (forceRate > 0 && effectiveFps > 0) {
        rawFrames = Math.round(rawFrames * forceRate / effectiveFps);
        effectiveFps = forceRate;
    }
    let available = Math.max(0, rawFrames - skipFirst);
    if (!ignoreNth && selectEveryNth > 1) {
        available = Math.ceil(available / selectEveryNth);
        if (effectiveFps > 0) effectiveFps = effectiveFps / selectEveryNth;
    }
    if (frameLoadCap > 0) {
        available = Math.min(available, frameLoadCap);
    }
    return {
        totalFrames: Math.max(0, available),
        frameRate: effectiveFps,
        rawFrames,
        availableBeforeNth: Math.max(0, rawFrames - skipFirst),
        frameLoadCap,
        forceRate,
        skipFirst,
        selectEveryNth,
    };
}

async function _sqrFetchVideoRealInfo(videoQuery) {
    const q = String(videoQuery || "").trim();
    if (!q) return null;
    const resp = await fetch(`/sqr/video_real_info?file=${encodeURIComponent(q)}`);
    if (!resp.ok) return null;
    const info = await resp.json();
    return info && typeof info === "object" ? info : null;
}

function _sqrCloneJsonSafe(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}

function _sqrUpdateLoadVideoPreviewOnly(vidNode, params) {
    try {
        if (!vidNode) return;
        const safeParams = {
            filename: params?.video || "",
            type: "input",
            format: "video/mp4",
            force_rate: params?.force_rate ?? 0,
            custom_width: params?.custom_width ?? 0,
            custom_height: params?.custom_height ?? 0,
            frame_load_cap: params?.frame_load_cap ?? 0,
            skip_first_frames: params?.skip_first_frames ?? 0,
            select_every_nth: Math.max(1, parseInt(params?.select_every_nth ?? 1) || 1),
        };
        if (typeof vidNode.widgets_values === "object" && vidNode.widgets_values) {
            const vp = (typeof vidNode.widgets_values.videopreview === "object" && vidNode.widgets_values.videopreview) ? vidNode.widgets_values.videopreview : {};
            vp.hidden = false;
            vp.paused = false;
            vp.params = Object.assign({}, vp.params || {}, safeParams);
            vidNode.widgets_values.videopreview = vp;
        }
        const previewWidget = vidNode.widgets?.find?.(w => w?.name === "videopreview");
        if (previewWidget) {
            const pv = (typeof previewWidget.value === "object" && previewWidget.value) ? previewWidget.value : {};
            previewWidget.value = Object.assign({}, pv, {
                hidden: false,
                paused: false,
                params: Object.assign({}, pv.params || {}, safeParams),
            });
        }
    } catch (e) {}
}

function _sqrSnapshotLoadVideoNode(vidNode) {
    const widgetKeys = ["video", "force_rate", "custom_width", "custom_height", "frame_load_cap", "skip_first_frames", "select_every_nth", "format"];
    const widgets = {};
    for (const key of widgetKeys) {
        const w = vidNode.widgets?.find?.(x => x?.name === key);
        widgets[key] = w ? _sqrCloneJsonSafe(w.value) : undefined;
    }
    const previewWidget = vidNode.widgets?.find?.(w => w?.name === "videopreview");
    return {
        widgets,
        previewWidgetValue: previewWidget ? _sqrCloneJsonSafe(previewWidget.value) : undefined,
        widgetsValues: _sqrCloneJsonSafe(vidNode.widgets_values),
    };
}

function _sqrApplyLoadVideoParams(vidNode, params) {
    const normalized = {
        video: params?.video || "",
        force_rate: Number(params?.force_rate) || 0,
        custom_width: parseInt(params?.custom_width) || 0,
        custom_height: parseInt(params?.custom_height) || 0,
        frame_load_cap: Math.max(0, parseInt(params?.frame_load_cap) || 0),
        skip_first_frames: Math.max(0, parseInt(params?.skip_first_frames) || 0),
        select_every_nth: Math.max(1, parseInt(params?.select_every_nth) || 1),
        format: params?.format ?? "AnimateDiff",
    };
    const sv = (name, value) => {
        const w = vidNode.widgets?.find?.(w => w?.name === name);
        if (w) w.value = value;
    };
    sv("video", normalized.video);
    sv("force_rate", normalized.force_rate);
    sv("custom_width", normalized.custom_width);
    sv("custom_height", normalized.custom_height);
    sv("frame_load_cap", normalized.frame_load_cap);
    sv("skip_first_frames", normalized.skip_first_frames);
    sv("select_every_nth", normalized.select_every_nth);
    sv("format", normalized.format);

    if (typeof vidNode.widgets_values === "object" && vidNode.widgets_values) {
        vidNode.widgets_values.video = normalized.video;
        vidNode.widgets_values.force_rate = normalized.force_rate;
        vidNode.widgets_values.custom_width = normalized.custom_width;
        vidNode.widgets_values.custom_height = normalized.custom_height;
        vidNode.widgets_values.frame_load_cap = normalized.frame_load_cap;
        vidNode.widgets_values.skip_first_frames = normalized.skip_first_frames;
        vidNode.widgets_values.select_every_nth = normalized.select_every_nth;
        vidNode.widgets_values.format = normalized.format;
    }
    _sqrUpdateLoadVideoPreviewOnly(vidNode, normalized);
    vidNode.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

function _sqrRestoreLoadVideoNode(vidNode, snapshot) {
    if (!vidNode || !snapshot) return;
    const sv = (name, value) => {
        const w = vidNode.widgets?.find?.(w => w?.name === name);
        if (w && value !== undefined) w.value = value;
    };
    for (const [key, value] of Object.entries(snapshot.widgets || {})) sv(key, value);
    if (snapshot.widgetsValues !== undefined) vidNode.widgets_values = _sqrCloneJsonSafe(snapshot.widgetsValues);
    const previewWidget = vidNode.widgets?.find?.(w => w?.name === "videopreview");
    if (previewWidget && snapshot.previewWidgetValue !== undefined) previewWidget.value = _sqrCloneJsonSafe(snapshot.previewWidgetValue);
    vidNode.setDirtyCanvas?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
    app.canvas?.setDirty?.(true, true);
}

async function _sqrBuildLoadVideoNthBypassPlan(sqrNode) {
    try {
        const vidNode = _sqrResolveRefLoadVideoNode(sqrNode);
        if (!vidNode) return null;
        const params = _sqrReadLoadVideoParams(vidNode);
        if (!(params.select_every_nth > 1)) return null;
        if (!(params.frame_load_cap > 0)) return null;
        const videoQuery = String(params.video || "").trim();
        if (!videoQuery) return null;
        const resp = await fetch(`/sqr/video_real_info?file=${encodeURIComponent(videoQuery)}`);
        const info = await resp.json();
        if (!info?.frame_count || !info?.fps) return null;
        const current = _sqrCalcLoadVideoResult(info, params, false);
        const desired = _sqrCalcLoadVideoResult(info, params, true);
        if (!(desired.totalFrames > current.totalFrames)) return null;
        return {
            vidNode,
            current,
            desired,
            injected: {
                ...params,
                select_every_nth: 1,
                frame_load_cap: Math.max(params.frame_load_cap || 0, desired.totalFrames || 0),
            },
            displayName: String(info?.name || videoQuery.split(/[\/]/).pop() || ""),
        };
    } catch (e) {
        console.warn("[SQR] 生成 Load Video 临时注入计划失败:", e);
        return null;
    }
}

// ── 辅助函数：从 Load Video 节点参数 + 视频真实信息计算处理后的帧数和帧率 ──
async function _sqrGetVideoRealInfo(sqrNode) {

    const getNodeW = name => sqrNode.widgets?.find(w => w.name === name);
    let totalFrames = 0;
    let frameRate = 0;
    const alignNotes = [];

    try {
        // 1. 找到 Load Video 节点
        let vidNode = null;
        const vidNodeId = (getNodeW("参考视频节点ID")?.value || "").trim();
        if (vidNodeId) {
            vidNode = app.graph?.getNodeById?.(parseInt(vidNodeId));
        }
        // 如果没有显式设置 ID，通过输入连接查找
        if (!vidNode) {
            for (const inputName of ["总帧数", "帧率"]) {
                const inp = sqrNode.inputs?.find(i => i.name === inputName);
                if (inp?.link != null) {
                    const link = app.graph.links[inp.link];
                    if (link) {
                        vidNode = app.graph.getNodeById(link.origin_id);
                        if (vidNode) break;
                    }
                }
            }
        }

        if (!vidNode) {
            console.warn("[SQR] 未找到 Load Video 节点");
            return { totalFrames: 0, frameRate: 0 };
        }

        // 2. 读取 Load Video 的 widget 参数
        const getVW = name => vidNode.widgets?.find(w => w.name === name);
        const videoWidget = getVW("video") || vidNode.widgets?.[0];
        const videoFile = videoWidget?.value || "";
        const forceRate = parseFloat(getVW("force_rate")?.value) || 0;
        const skipFirst = parseInt(getVW("skip_first_frames")?.value) || 0;
        const frameLoadCap = parseInt(getVW("frame_load_cap")?.value) || 0;
        const selectEveryNth = Math.max(1, parseInt(getVW("select_every_nth")?.value) || 1);

        if (!videoFile) {
            console.warn("[SQR] Load Video 节点没有选择视频文件");
            return { totalFrames: 0, frameRate: 0 };
        }

        // 3. 调用后端 API 获取视频文件真实信息
        const videoQuery = String(videoFile).trim();
        const fname = videoQuery.split(/[/\\]/).pop();
        const info = await _sqrFetchVideoRealInfo(videoQuery);

        if (!info?.frame_count || info.frame_count <= 0 || !info?.fps || info.fps <= 0) {
            console.warn("[SQR] 视频文件信息无效:", info);
            const guessedTotalFrames = (selectEveryNth > 1 && frameLoadCap > 0) ? frameLoadCap : 0;
            return {
                totalFrames: guessedTotalFrames,
                frameRate: forceRate > 0 ? forceRate : 0,
                file: videoQuery,
                originalFps: 0,
                originalTotalFrames: 0,
                forceRate,
                skipFirst,
                selectEveryNth,
                frameLoadCap,
                localAlignNotes: [],
            };
        }

        // 4. 模拟 Load Video 的处理逻辑
        let rawFrames = info.frame_count;
        let effectiveFps = info.fps;

        // 应用 force_rate（重采样：保持时长不变，改变帧率和帧数）
        if (forceRate > 0 && info.fps > 0) {
            rawFrames = Math.round(rawFrames * forceRate / info.fps);
            effectiveFps = forceRate;
        }

        // 应用 skip_first_frames
        let available = Math.max(0, rawFrames - skipFirst);

        // 分段队列内部忽略 select_every_nth>1，始终按 1 处理
        if (selectEveryNth > 1) {
            console.info("[SQR] select_every_nth>1 已被分段队列忽略，内部按 1 处理。");
        }

        // 应用 frame_load_cap
        if (frameLoadCap > 0 && available > frameLoadCap) {
            available = frameLoadCap;
        }

        totalFrames = available;
        frameRate = effectiveFps;

        const localCandidates = [];
        for (const [key, label] of [["本地姿态视频路径", "姿态"], ["本地人脸视频路径", "人脸"]]) {
            const localPath = String(getNodeW(key)?.value || "").trim();
            if (!localPath) continue;
            const localInfo = await _sqrFetchVideoRealInfo(localPath);
            if (!localInfo?.frame_count || !localInfo?.fps) continue;
            const localAvailable = _sqrCalcLoadVideoResult(localInfo, params, true).totalFrames;
            if (localAvailable > 0) {
                localCandidates.push({ label, frames: localAvailable });
            }
        }
        if (localCandidates.length > 0) {
            const localBound = Math.min(...localCandidates.map(x => x.frames));
            if (localBound > 0 && localBound < totalFrames) {
                const diff = totalFrames - localBound;
                const detail = localCandidates.map(x => `${x.label}${x.frames}帧`).join("；");
                alignNotes.push(diff <= 8
                    ? `本地姿态/人脸视频仅少 ${diff} 帧，已自动将总帧数对齐到 ${localBound} 帧（${detail}）。`
                    : `本地姿态/人脸视频比主参考少 ${diff} 帧，已按最短可用帧数对齐到 ${localBound} 帧继续执行（${detail}）。`);
                totalFrames = localBound;
            }
        }

        console.log(`[SQR] 视频真实信息: 原始${info.frame_count}帧@${info.fps}fps → 处理后${totalFrames}帧@${frameRate.toFixed(2)}fps`
            + ` (force_rate=${forceRate}, skip=${skipFirst}, nth=${selectEveryNth}, cap=${frameLoadCap})`);

        // 返回视频文件信息供帧预览使用
        return { totalFrames, frameRate, file: info.file || videoQuery, originalFps: info.fps, originalTotalFrames: info.frame_count || 0,
                 forceRate, skipFirst, selectEveryNth, frameLoadCap, displayName: info.name || fname, localAlignNotes: alignNotes };

    } catch(e) {
        console.warn("[SQR] 从视频文件获取帧数失败:", e);
    }

    return { totalFrames, frameRate, file: "", originalFps: 0, originalTotalFrames: 0,
             forceRate: 0, skipFirst: 0, selectEveryNth: 1, frameLoadCap: 0, localAlignNotes: [] };
}

// ── Helper: silently run a preview to obtain totalFrames ──────────
async function _sqrSilentPreviewForFrames(sqrNode, origQueuePrompt) {
    const getW = name => sqrNode.widgets?.find(w => w.name === name);
    const execW = getW("执行");
    if (!execW) return 0;

    // Save current exec state, force preview mode
    const savedExec = execW.value;
    execW.value = false;

    // Show a subtle loading indicator
    const loadEl = document.createElement("div");
    Object.assign(loadEl.style, {
        position: "fixed", top: "10px", left: "50%", transform: "translateX(-50%)",
        zIndex: "20000", background: "rgba(30,30,30,0.9)", color: "#aaa",
        padding: "10px 24px", borderRadius: "8px", fontSize: "13px",
        border: "1px solid rgba(255,255,255,0.1)", boxShadow: "0 4px 20px rgba(0,0,0,.5)"
    });
    loadEl.textContent = "正在获取视频信息…";
    document.body.appendChild(loadEl);

    try {
        // Queue a preview run
        await origQueuePrompt(0, 1);

        // Wait for the prompt to complete and logs to appear
        const uid = String(sqrNode.id);
        let totalFrames = 0;
        const maxWait = 30000; // 30s timeout
        const startTime = Date.now();

        while (Date.now() - startTime < maxWait) {
            await new Promise(r => setTimeout(r, 800));
            try {
                const resp = await fetch(`/sqr/logs?uid=${uid}`);
                const data = await resp.json();
                const logs = data.logs || [];
                // Look for total frames in log: "总帧数：XXX"
                for (const line of logs) {
                    const m = String(line).match(/总帧数[：:]\s*(\d+)/);
                    if (m) {
                        totalFrames = parseInt(m[1]);
                        break;
                    }
                }
                if (totalFrames > 0) break;

                // Also check if preview completed (look for plan text or interrupt)
                const hasPreview = logs.some(l => /预览模式/.test(l));
                if (hasPreview && logs.length > 3) {
                    // Try to extract from the plan text: parse "共 X 段" etc
                    // The plan text contains total frame info
                    break;
                }
            } catch(e) {}
        }

        // If we still don't have it, try reading from the node's resolved inputs
        if (totalFrames <= 0) {
            try {
                const { output } = await app.graphToPrompt();
                const sqrId = String(sqrNode.id);
                const sqrInputs = output[sqrId]?.inputs || {};
                if (typeof sqrInputs["总帧数"] === "number" && sqrInputs["总帧数"] > 0) {
                    totalFrames = sqrInputs["总帧数"];
                }
            } catch(e) {}
        }

        return totalFrames;
    } finally {
        // Restore exec state
        execW.value = savedExec;
        loadEl.remove();
    }
}

// ── 注册扩展 ──────────────────────────────────────────────────────
async function _showManualResumeTypeDialog() {
    return new Promise(resolve => {
        document.getElementById("sqr-manual-resume-kind-overlay")?.remove();
        const overlay = document.createElement("div");
        overlay.id = "sqr-manual-resume-kind-overlay";
        Object.assign(overlay.style, {
            position:"fixed", inset:"0", zIndex:"10010",
            background:"rgba(0,0,0,.82)", display:"flex", alignItems:"center", justifyContent:"center"
        });
        const box = document.createElement("div");
        Object.assign(box.style, {
            width:"620px", maxWidth:"calc(100vw - 40px)",
            background:"var(--comfy-menu-bg,#1e1e1e)", color:"var(--input-text,#eee)",
            border:"1px solid var(--border-color,#444)", borderRadius:"12px",
            padding:"18px 20px", boxShadow:"0 8px 40px rgba(0,0,0,.7)",
            display:"flex", flexDirection:"column", gap:"10px"
        });
        const mkDiv = (t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
        box.appendChild(mkDiv("🧭  选择手动续跑类型","font-size:15px;font-weight:700;"));
        box.appendChild(mkDiv("连续型：所选续跑视频就是当前任务已完成前缀，后续仍沿原时间轴连续往后生成；最终成品可重贴原始连续音频。","font-size:12px;line-height:1.6;opacity:.78;"));
        const btnWrap = document.createElement("div");
        btnWrap.style.cssText = "display:flex;flex-direction:column;gap:10px;margin-top:4px;";
        const mkBtn = (title, hint, kind, style='') => {
            const b = document.createElement('button');
            b.type = 'button';
            b.style.cssText = `text-align:left;padding:12px 14px;border-radius:10px;cursor:pointer;border:1.5px solid var(--border-color,#555);background:var(--comfy-input-bg,#333);color:var(--input-text,#eee);${style}`;
            b.innerHTML = `<div style="font-size:13px;font-weight:700;">${title}</div><div style="font-size:11px;opacity:.68;line-height:1.55;margin-top:4px;">${hint}</div>`;
            b.onclick = () => { overlay.remove(); resolve(kind); };
            return b;
        };
        btnWrap.appendChild(mkBtn("✅ 连续型手动续跑","你选的续跑视频被视为已完成前缀，后续继续往后生成。最终 merged 成品将尝试重贴原始连续音频。","manual_continuous","border-color:rgba(30,170,130,0.8);"));
        btnWrap.appendChild(mkBtn("🧩 非连续型手动续跑（高级）","你选的续跑视频只作为前段衔接素材，不保证与当前任务时间轴连续。最终 merged 成品将保留分段拼接音频，不做连续原音频重贴。","manual_noncontinuous","border-color:rgba(220,170,70,0.75);"));
        const actionRow = document.createElement('div');
        actionRow.style.cssText = 'display:flex;gap:10px;margin-top:2px;';

        const closeResume = document.createElement('button');
        closeResume.type = 'button';
        closeResume.textContent = '⊗ 关闭续跑';
        closeResume.style.cssText = 'flex:1;padding:9px 14px;border-radius:10px;cursor:pointer;font-size:13px;background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;font-weight:600;';
        closeResume.onclick = () => { overlay.remove(); resolve('cancel_resume'); };

        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        cancel.style.cssText = 'flex:1;padding:9px 14px;border-radius:10px;cursor:pointer;font-size:13px;background:rgba(255,255,255,0.08);border:1px solid var(--border-color,#555);color:var(--input-text,#eee);font-weight:600;';
        cancel.onclick = () => { overlay.remove(); resolve(''); };

        actionRow.append(closeResume, cancel);
        box.append(btnWrap, actionRow);
        overlay.appendChild(box);
        overlay.onclick = e => { if (e.target === overlay) { overlay.remove(); resolve(''); } };
        document.body.appendChild(overlay);
    });
}

async function _showPreSegmentDialog(sqrNode, onConfirm) {
return new Promise(resolve => {
    document.getElementById("sqr-preseg-overlay")?.remove();
    let selPaths = [];
    let dragSrcIdx = -1;

    const overlay = document.createElement("div");
    overlay.id = "sqr-preseg-overlay";
    Object.assign(overlay.style, {
        position:"fixed",inset:"0",zIndex:"10000",
        background:"rgba(0,0,0,.8)",display:"flex",alignItems:"center",justifyContent:"center"
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
        background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
        border:"1px solid var(--border-color,#444)",borderRadius:"12px",
        padding:"20px 24px",width:"620px",maxHeight:"88vh",
        display:"flex",flexDirection:"column",gap:"8px",
        boxShadow:"0 8px 40px rgba(0,0,0,.7)"
    });
    const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
    box.appendChild(mkDiv("📂  续跑合并：选择中断前已有素材","font-size:14px;font-weight:700;"));
    box.appendChild(mkDiv("点击视频文件添加到下方列表，可拖动排序，右键移除。最终将按此顺序拼接为完整成品。","font-size:11px;opacity:.6;"));

    const pathBar = document.createElement("div");
    Object.assign(pathBar.style, {
        fontSize:"11px",opacity:".6",padding:"4px 0",minHeight:"18px",
        borderBottom:"1px solid var(--border-color,#444)",marginBottom:"2px",
        display:"flex",alignItems:"center",gap:"4px",flexWrap:"wrap"
    });
    box.appendChild(pathBar);

    const selArea = document.createElement("div");
    Object.assign(selArea.style, {
        border:"1px solid var(--border-color,#444)",borderRadius:"8px",padding:"6px",
        minHeight:"52px",maxHeight:"140px",overflowY:"auto",
        display:"flex",flexWrap:"wrap",gap:"6px",alignItems:"flex-start"
    });

    function renderSel() {
        selArea.innerHTML = "";
        if (!selPaths.length) {
            selArea.appendChild(mkDiv("（未选，续跑结果将单独合并）","opacity:.35;font-size:11px;padding:4px;"));
            return;
        }
        selPaths.forEach((p, i) => {
            const card = document.createElement("div");
            Object.assign(card.style, { width:"72px",cursor:"grab",userSelect:"none",display:"flex",flexDirection:"column",alignItems:"center",gap:"2px",border:"1px solid var(--border-color,#555)",borderRadius:"6px",padding:"4px",background:"var(--comfy-input-bg,#2a2a2a)",position:"relative",fontSize:"10px" });
            const badge = mkDiv(String(i+1),"position:absolute;top:2px;left:2px;background:rgba(50,150,70,0.9);color:#fff;font-weight:700;font-size:9px;padding:0 4px;border-radius:3px;");
            const img = document.createElement("img"); img.src = `/sqr/video_thumb?file=${encodeURIComponent(p)}`; img.style.cssText = "width:64px;height:44px;object-fit:cover;border-radius:3px;"; img.draggable = false; img.onerror = () => { img.style.display="none"; };
            const name = mkDiv(p.split(/[/\\]/).pop(),"width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;opacity:.7;"); name.title = p;
            card.append(badge, img, name); card.draggable = true;
            card.ondragstart = () => { dragSrcIdx = i; card.style.opacity=".4"; }; card.ondragend = () => { card.style.opacity="1"; };
            card.ondragover = e => { e.preventDefault(); card.style.borderColor="#4c6"; }; card.ondragleave = () => { card.style.borderColor="var(--border-color,#555)"; };
            card.ondrop = e => { e.preventDefault(); card.style.borderColor="var(--border-color,#555)"; if (dragSrcIdx >= 0 && dragSrcIdx !== i) { const [m] = selPaths.splice(dragSrcIdx, 1); selPaths.splice(i, 0, m); renderSel(); } };
            card.oncontextmenu = e => { e.preventDefault(); selPaths.splice(i,1); renderSel(); };
            selArea.appendChild(card);
        });
    }

    const browserWrap = document.createElement("div");
    Object.assign(browserWrap.style, { display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(90px,1fr))",gap:"6px",border:"1px solid var(--border-color,#444)",borderRadius:"8px",padding:"8px",maxHeight:"300px",overflowY:"auto",minHeight:"80px",alignContent:"flex-start" });
    box.appendChild(browserWrap);
    box.appendChild(mkDiv("已选素材（拖动排序，右键移除）：","font-size:11px;opacity:.5;margin-top:2px;"));
    box.appendChild(selArea); renderSel();

    async function loadDir(path) {
        browserWrap.innerHTML = '<div style="opacity:.5;font-size:12px;padding:8px;grid-column:1/-1;">加载中...</div>'; pathBar.innerHTML = "";
        try {
            const url = path ? `/sqr/browse_videos?path=${encodeURIComponent(path)}` : "/sqr/browse_videos";
            const data = await (await fetch(url)).json();
            if (data.type === "dir" || data.type === "roots") { const rootBtn = mkDiv("🏠","cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);"); rootBtn.onclick=()=>loadDir(null); pathBar.appendChild(rootBtn);
                if (data.type === "dir") { pathBar.appendChild(mkDiv("›","opacity:.4;")); const sep = data.path.includes("\\") ? "\\" : "/"; let acc = data.path.match(/^[A-Za-z]:\\/)?.[0] || "/"; const parts = data.path.split(sep).filter(Boolean).slice(data.path.startsWith("/")?0:1);
                    parts.forEach((part,i) => { acc = acc + (acc.endsWith(sep)?"":sep) + part; const snap=acc; const b=mkDiv(part,"cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"); b.onclick=()=>loadDir(snap); pathBar.appendChild(b); if(i<parts.length-1) pathBar.appendChild(mkDiv("›","opacity:.4;")); }); } }
            browserWrap.innerHTML = ""; browserWrap.style.display = "grid";
            if (data.type === "roots") { data.roots.forEach(({label,path:p,is_drive})=>{ const icon = (p === "__drives__" || is_drive) ? "🖥" : "📁"; const row=document.createElement("div"); row.style.cssText="grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-radius:5px;font-size:12px;"; row.innerHTML=`<span>${icon}</span><span>${label}</span>`; row.onclick=()=>loadDir(p); row.onmouseover=()=>row.style.background="var(--comfy-input-bg,#333)"; row.onmouseout=()=>row.style.background=""; browserWrap.appendChild(row); });
            } else {
                if (data.parent) { const row=document.createElement("div"); row.style.cssText="grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-radius:5px;font-size:12px;"; row.innerHTML="<span>📁</span><span>.. （上级目录）</span>"; row.onclick=()=>loadDir(data.parent); row.onmouseover=()=>row.style.background="var(--comfy-input-bg,#333)"; row.onmouseout=()=>row.style.background=""; browserWrap.appendChild(row); }
                data.folders.forEach(f=>{ const fp=(data.path.endsWith("/")||data.path.endsWith("\\"))?data.path+f:data.path+"/"+f; const row=document.createElement("div"); row.style.cssText="grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-radius:5px;font-size:12px;"; row.innerHTML=`<span>📁</span><span>${f}</span>`; row.onclick=()=>loadDir(fp); row.onmouseover=()=>row.style.background="var(--comfy-input-bg,#333)"; row.onmouseout=()=>row.style.background=""; browserWrap.appendChild(row); });
                if (!data.videos.length && !data.folders.length) { browserWrap.appendChild(mkDiv("（此目录没有视频文件和子文件夹）","opacity:.4;font-size:12px;padding:8px;grid-column:1/-1;")); } else if (!data.videos.length) { browserWrap.appendChild(mkDiv("（此目录没有视频文件，可进入子文件夹）","opacity:.4;font-size:12px;padding:4px;grid-column:1/-1;")); }
                data.videos.forEach(f=>{ const fp=(data.path.endsWith("/")||data.path.endsWith("\\"))?data.path+f:data.path+"/"+f; const alreadySel = selPaths.includes(fp);
                    const card=document.createElement("div"); Object.assign(card.style,{ cursor:"pointer",border: alreadySel?"2px solid #4a6":"1px solid var(--border-color,#555)",borderRadius:"6px",padding:"6px 8px",background:"var(--comfy-input-bg,#2a2a2a)",display:"flex",flexDirection:"row",alignItems:"center",gap:"8px",fontSize:"11px",opacity: alreadySel?"0.55":"1",gridColumn:"1/-1" });
                    const img=document.createElement("img"); img.src=`/sqr/video_thumb?file=${encodeURIComponent(fp)}`; img.style.cssText="width:72px;height:48px;object-fit:cover;border-radius:4px;flex-shrink:0;"; img.draggable=false; img.onerror=()=>{img.style.display="none";};
                    const nmWrap=document.createElement("div"); nmWrap.style.cssText="flex:1;overflow:hidden;"; const nm=mkDiv(f,"font-size:11px;opacity:.9;word-break:break-word;overflow-wrap:anywhere;line-height:1.4;"); nm.title=fp; nmWrap.appendChild(nm); card.append(img,nmWrap);
                    card.onclick=()=>{ if (!selPaths.includes(fp)) { selPaths.push(fp); card.style.border="2px solid #4a6"; card.style.opacity="0.55"; } renderSel(); }; browserWrap.appendChild(card); });
            }
        } catch(e) { browserWrap.innerHTML=`<div style="opacity:.5;font-size:12px;padding:8px;grid-column:1/-1;">加载失败：${e.message}</div>`; }
    }

    const btns=document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
    const mkBtn=(t,s,fn)=>{const b=document.createElement("button");b.textContent=t;b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;b.onclick=fn;return b;};
    btns.append(
        mkBtn("⊗ 关闭续跑","background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;",()=>{ sqrNode._sqrClearVideo?.(); overlay.remove(); resolve({ cancelResume: true }); }),
        mkBtn("🚫 跳过，只合并本次","",()=>{ overlay.remove(); resolve([]); }),
        mkBtn("✅ 确认并运行","background:#2a9;color:#fff;border:none;font-weight:700;",()=>{ overlay.remove(); resolve(selPaths); })
    );
    const _xBtn2=document.createElement("button");_xBtn2.textContent="×";_xBtn2.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";_xBtn2.onclick=()=>{overlay.remove();resolve(null);};
    box.style.position="relative"; box.appendChild(_xBtn2); box.appendChild(btns); overlay.appendChild(box); document.body.appendChild(overlay);
    fetch("/sqr/browse_videos").then(r=>r.json()).then(data=>{const o=data.roots?.find(r=>r.label==="ComfyUI output");loadDir(o?o.path:null);}).catch(()=>loadDir(null));
});
}


// ── 日志弹窗 ─────────────────────────────────────────────────────────
function _showLogOverlay(nodeId) {
    const pid = `sqr-log-${nodeId}`;
    const existed = document.getElementById(pid);
    if (existed) { existed.remove(); return; }

    const box = document.createElement("div"); box.id = pid;
    Object.assign(box.style, { position:"fixed",bottom:"20px",right:"20px",zIndex:"9990",width:"580px",height:"390px",background:"var(--comfy-menu-bg,#161616)",border:"1px solid var(--border-color,#3a3a3a)",borderRadius:"10px",boxShadow:"0 8px 36px rgba(0,0,0,.85)",display:"flex",flexDirection:"column",overflow:"hidden",resize:"both",userSelect:"text" });
    const hdr = document.createElement("div");
    Object.assign(hdr.style, { padding:"7px 12px",display:"flex",alignItems:"center",gap:"8px",borderBottom:"1px solid var(--border-color,#2a2a2a)",background:"rgba(255,255,255,0.03)",cursor:"move",flexShrink:"0",fontSize:"12px",fontWeight:"600",userSelect:"none" });
    let dx=0,dy=0,dragging=false;
    hdr.onmousedown=e=>{dragging=true;const r=box.getBoundingClientRect();dx=e.clientX-r.left;dy=e.clientY-r.top;document.onmousemove=e2=>{if(!dragging)return;box.style.left=(e2.clientX-dx)+"px";box.style.top=(e2.clientY-dy)+"px";box.style.right="auto";box.style.bottom="auto";};document.onmouseup=()=>{dragging=false;document.onmousemove=null;document.onmouseup=null;};};
    hdr.appendChild(Object.assign(document.createElement("span"),{textContent:"📋  分段队列 · 运行日志"}));
    const dot=Object.assign(document.createElement("span"),{title:"实时更新中"});dot.style.cssText="width:6px;height:6px;border-radius:50%;background:#2a9;flex-shrink:0;";hdr.appendChild(dot);
    hdr.appendChild(Object.assign(document.createElement("span"),{style:"flex:1"}));
    const clrBtn=document.createElement("button");clrBtn.textContent="清空";clrBtn.title="清空当前日志";clrBtn.style.cssText="padding:2px 9px;border-radius:4px;cursor:pointer;font-size:11px;background:rgba(255,255,255,0.07);border:1px solid var(--border-color,#444);color:var(--input-text,#aaa);";hdr.appendChild(clrBtn);
    const xBtn=document.createElement("button");xBtn.textContent="×";xBtn.style.cssText="padding:0 8px;font-size:18px;line-height:1.4;background:none;border:none;cursor:pointer;color:var(--input-text,#666);";xBtn.onmouseover=()=>xBtn.style.color="#fff";xBtn.onmouseout=()=>xBtn.style.color="var(--input-text,#666)";xBtn.onclick=e=>{e.stopPropagation();box.remove();};hdr.appendChild(xBtn);box.appendChild(hdr);
    const progWrap=document.createElement("div");progWrap.style.cssText="padding:8px 12px;border-bottom:1px solid var(--border-color,#2a2a2a);font-size:11px;line-height:1.6;background:rgba(255,255,255,0.02);flex-shrink:0;";
    const progText=document.createElement("div");progText.style.cssText="opacity:.75;";progText.textContent="进度：等待中";
    const progBar=document.createElement("div");progBar.style.cssText="margin-top:6px;height:6px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;";
    const progFill=document.createElement("div");progFill.style.cssText="height:100%;width:0%;background:#2a9;transition:width .2s ease;";progBar.appendChild(progFill);progWrap.append(progText,progBar);box.appendChild(progWrap);
    const area=document.createElement("div");Object.assign(area.style,{flex:"1",overflowY:"auto",padding:"8px 12px",fontSize:"11px",lineHeight:"1.8",fontFamily:"'Consolas','Courier New',monospace",color:"var(--input-text,#bbb)",whiteSpace:"pre-wrap",wordBreak:"break-word",overflowWrap:"anywhere"});area.innerHTML="<div style='opacity:.4;'>加载中...</div>";box.appendChild(area);document.body.appendChild(box);
    function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
    function lineHtml(r){const s=esc(r);if(/===/.test(r))return`<div style="color:#7cf;font-weight:700;padding-top:3px;">${s}</div>`;if(/---.*段.*---/.test(r))return`<div style="color:#adf;border-top:1px solid #222;margin-top:3px;padding-top:3px;">${s}</div>`;if(/✓/.test(r))return`<div style="color:#5d9;">${s}</div>`;if(/✗/.test(r))return`<div style="color:#f76;">${s}</div>`;if(/⚠/.test(r))return`<div style="color:#fa8;">${s}</div>`;if(/预览模式|全新生成|续跑模式|重新设计续跑模式|试跑模式/.test(r))return`<div style="color:#fd9;font-weight:600;">${s}</div>`;if(String(r).trim()==="")return`<div style="height:6px;"></div>`;return`<div>${s}</div>`;}
    function render(lines){if(!lines||!lines.length){area.innerHTML="<div style='opacity:.4;'>（暂无日志）</div>";return;}const atBot=area.scrollHeight-area.scrollTop-area.clientHeight<50;const html=[];for(const raw of lines){const parts=String(raw).split(/\r?\n/);for(const r of parts)html.push(lineHtml(r));}area.innerHTML=html.join("");if(atBot)area.scrollTop=area.scrollHeight;}
    function renderProgress(p){
        const pr = p && typeof p === "object" ? p : {};
        const total = Math.max(0, Number(pr.total_segments) || 0);
        const cur = Math.max(0, Number(pr.current_segment) || 0);
        const done = Math.max(0, Number(pr.completed_segments) || 0);
        const stage = pr.current_stage || pr.status || "idle";
        const msg = pr.last_message || "";
        const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
        progFill.style.width = `${pct}%`;
        progText.textContent = `进度：${done}/${total || "-"} 段 ｜ 当前：${cur || "-"} ｜ 阶段：${stage}${msg ? ` ｜ ${msg}` : ""}`;
        dot.style.background = pr.status === "error" ? "#d66" : (pr.status === "done" ? "#6c6" : "#2a9");

        // ── 需求6: 检测彩蛋触发 + 抽卡券奖励 ──
        try {
            // 1) 抽卡券奖励：每次完成一次完整工作流，静默发放 3 张（不弹 toast 避免暴露彩蛋）
            const rewardStamp = pr.gacha_reward_run_stamp || "";
            if (rewardStamp) {
                const lastRewardKey = "sqr_gacha_last_reward_stamp";
                const lastSeenStamp = localStorage.getItem(lastRewardKey) || "";
                if (rewardStamp !== lastSeenStamp) {
                    localStorage.setItem(lastRewardKey, rewardStamp);
                    _sqrAddTickets(3);
                }
            }
            // 2) 彩蛋触发：手动 + 预览模式
            if (pr.status === "easter_egg_gacha") {
                const lastTrigKey = "sqr_gacha_last_trigger_stamp";
                const trigStamp = String(pr.updated_at || Date.now());
                const lastSeenTrig = localStorage.getItem(lastTrigKey) || "";
                if (trigStamp !== lastSeenTrig) {
                    localStorage.setItem(lastTrigKey, trigStamp);
                    if (typeof _sqrShowGachaDialog === "function") _sqrShowGachaDialog();
                }
            }
        } catch (e) { /* 防御性，不影响正常进度显示 */ }
    }
    let lastSig="", lastProgSig="";
    clrBtn.onclick=e=>{e.stopPropagation();fetch(`/sqr/logs/clear?uid=${nodeId}`,{method:"POST"}).catch(()=>{});area.innerHTML="<div style='opacity:.4;'>（已清空）</div>";lastSig="";};
    async function poll(){if(!document.getElementById(pid))return;try{dot.style.opacity=".35";const [logResp, progResp] = await Promise.all([fetch(`/sqr/logs?uid=${nodeId}`), fetch(`/sqr/progress?uid=${nodeId}`)]);const d=await logResp.json();const pd=await progResp.json();dot.style.opacity="1";const logs=Array.isArray(d.logs)?d.logs:[];const sig=JSON.stringify(logs);if(sig!==lastSig){lastSig=sig;render(logs);}const prog = pd && typeof pd.progress === "object" ? pd.progress : {};const progSig = JSON.stringify(prog);if(progSig !== lastProgSig){lastProgSig = progSig;renderProgress(prog);}}catch(e){dot.style.opacity=".15";}if(document.getElementById(pid))setTimeout(poll,2000);}
    poll();
}


app.registerExtension({
    name: "SegmentQueueRunner.UI",

    async setup() {
        const origQueuePrompt = app.queuePrompt?.bind(app);
        if (!origQueuePrompt) return;

        app.queuePrompt = async function(number, batchCount) {
            const sqrNodes = (app.graph?.nodes || []).filter(n =>
                n.type === "SegmentQueueRunner" && !n.muted && n.mode !== 4
            );
            if (sqrNodes.length === 0) {
                return origQueuePrompt(number, batchCount);
            }

            // ── 问题4: 手动分段 + 预览模式 → 直接弹抽卡彩蛋，完全绕过工作流提交 ──
            // 这样可以避免 Load Video 上传视频的耗时，第一次触发也能秒开。
            // 只要有任何一个 SegmentQueueRunner 处于此组合，就直接触发彩蛋，不再提交。
            for (const sqrNode of sqrNodes) {
                const getNodeW_egg = name => sqrNode.widgets?.find(w => w.name === name);
                const segMode_egg = sqrNode._sqrSettings?.segmentMode || "average";
                const isExec_egg = !!getNodeW_egg("执行")?.value;
                if (segMode_egg === "manual" && !isExec_egg) {
                    try {
                        if (typeof _sqrShowGachaDialog === "function") {
                            _sqrShowGachaDialog();
                        }
                    } catch (e) {
                        console.warn("[SQR] 抽卡弹框触发失败:", e);
                    }
                    // 返回一个伪造的"提交成功"对象，防止 ComfyUI 前端报错
                    return { prompt_id: "sqr_egg_" + Date.now(), number: 0, node_errors: {} };
                }
            }

            for (const sqrNode of sqrNodes) {
                const getNodeW = name => sqrNode.widgets?.find(w => w.name === name);

                // ── 续跑状态校验（避免隐藏值残留导致误弹窗） ──
                let resumePath = String(getNodeW("续跑视频路径")?.value || "").trim();
                const resumeMode = String(sqrNode._sqrResumeMode || "").trim();
                if (resumePath) {
                    try {
                        const resp = await fetch(`/sqr/video_real_info?file=${encodeURIComponent(resumePath)}`);
                        if (!resp.ok) {
                            if (typeof sqrNode._sqrClearVideo === "function") sqrNode._sqrClearVideo({ silent: true, keepManualSplits: true });
                            resumePath = "";
                        }
                    } catch (e) {
                        console.warn("[SQR] 续跑视频校验失败:", e);
                    }
                }
                if (!resumePath && !resumeMode) {
                    const resumeToggleW = getNodeW("启用续跑");
                    if (resumeToggleW) resumeToggleW.value = false;
                    const resumePathW = getNodeW("续跑视频路径");
                    if (resumePathW) resumePathW.value = "";
                    const resumeKindW = getNodeW("sqr_resume_kind");
                    if (resumeKindW) resumeKindW.value = "";
                    const preSegmentsW = getNodeW("sqr_pre_segments");
                    if (preSegmentsW) preSegmentsW.value = "";
                    const frameOffsetW = getNodeW("sqr_frame_offset");
                    if (frameOffsetW) frameOffsetW.value = -1;
                }

                // ── 手动分段模式：读取视频文件真实帧数和帧率，然后弹出timeline调整弹窗 ──
                const segMode = sqrNode._sqrSettings?.segmentMode || "average";
                const execW = getNodeW("执行");
                const manualSplitsStr = String(getNodeW("sqr_manual_splits")?.value || "").trim();
                const skipManualDialogForAutoResume = segMode === "manual" && execW?.value && !!resumePath && resumeMode === "checkpoint_auto" && !!manualSplitsStr;
                if (segMode === "manual" && execW?.value && !skipManualDialogForAutoResume) {
                    let totalFrames = 0;
                    let frameRate = 16;

                    // ── 主方案：通过 /sqr/video_real_info 读取视频文件真实信息 + Load Video 参数计算 ──
                    const realInfo = await _sqrGetVideoRealInfo(sqrNode);
                    if (realInfo.totalFrames > 0) {
                        totalFrames = realInfo.totalFrames;
                    }
                    if (realInfo.frameRate > 0) {
                        frameRate = realInfo.frameRate;
                    }
                    {
                        const realFramesW = getNodeW("sqr_real_total_frames");
                        if (realFramesW) realFramesW.value = String(Number(realInfo.originalTotalFrames || -1));
                        const realFpsW = getNodeW("sqr_real_fps");
                        if (realFpsW) realFpsW.value = String(Number(realInfo.originalFps || -1));
                    }
                    // 保存视频信息供帧预览使用
        const _videoInfoForDialog = {
            file: realInfo.file || "",
            originalFps: realInfo.originalFps || 0,
            forceRate: realInfo.forceRate || 0,
            skipFirst: realInfo.skipFirst || 0,
            selectEveryNth: realInfo.selectEveryNth || 1,
            frameLoadCap: realInfo.frameLoadCap || 0,
            localAlignNotes: realInfo.localAlignNotes || [],
            _nodeId: String(sqrNode.id),
            _skipStoredSplits: resumeMode === "checkpoint_redesign",
            // 需求3: 把当前节点设置的固定模式下限传给手动分段对话框
            _fixedFrameMin: parseInt(sqrNode._sqrSettings?.fixedFrameMin || 61, 10) || 61,
        };

                    // ── 回退方案：从 graphToPrompt 解析值 ──
                    if (totalFrames <= 0) {
                        try {
                            const { output } = await app.graphToPrompt();
                            const sqrId = String(sqrNode.id);
                            const sqrInputs = output[sqrId]?.inputs || {};
                            if (typeof sqrInputs["总帧数"] === "number" && sqrInputs["总帧数"] > 0) {
                                totalFrames = sqrInputs["总帧数"];
                            }
                            if (typeof sqrInputs["帧率"] === "number" && sqrInputs["帧率"] > 0) {
                                frameRate = sqrInputs["帧率"];
                            }
                            if ((realInfo.selectEveryNth || 1) > 1 && (realInfo.frameLoadCap || 0) > 0 && totalFrames > 0 && totalFrames < realInfo.frameLoadCap) {
                                totalFrames = realInfo.frameLoadCap;
                            }
                        } catch(e) {}
                    }

                    // ── 回退方案2：从 widget 值读取 ──
                    if (totalFrames <= 0) {
                        const tfW = getNodeW("总帧数");
                        if (tfW && tfW.value > 0) totalFrames = tfW.value;
                        if ((realInfo.selectEveryNth || 1) > 1 && (realInfo.frameLoadCap || 0) > 0 && totalFrames > 0 && totalFrames < realInfo.frameLoadCap) {
                            totalFrames = realInfo.frameLoadCap;
                        }
                    }

                    // If we STILL don't have totalFrames, show error
                    if (totalFrames <= 0) {
                        alert("无法自动获取视频总帧数。请检查参考视频节点是否正确连接，或确认参考视频节点ID已正确设置。");
                        return;
                    }

                    if (frameRate <= 0) frameRate = 16;

                    // 考虑帧偏移（续跑模式下使用）
                    const _foW = getNodeW("sqr_frame_offset");
                    const _frameOffset = (_foW && parseInt(_foW.value) >= 0) ? parseInt(_foW.value) : 0;
                    const planFrames = _frameOffset > 0 ? Math.max(1, totalFrames - _frameOffset) : totalFrames;

                    const segments = parseInt(getNodeW("分段数")?.value) || 2;
                    // 需求3修正: 用设置面板的下限来算初始种子，而不是硬编码 61
                    const _fminForSeed = Math.max(41, parseInt(sqrNode._sqrSettings?.fixedFrameMin || 61, 10) || 61);
                    const initialSegList = _jsCalcManualSeedSegments(planFrames, segments, _fminForSeed);

                    // Show manual adjustment dialog
                    _videoInfoForDialog.frameOffset = _frameOffset;
                    const splitResult = await new Promise(resolve => {
                        showManualSegmentDialog(planFrames, frameRate, initialSegList, resolve, _videoInfoForDialog);
                    });
                    if (splitResult === null) return; // cancelled

                    // Store splits in hidden widget
                    const splitsW = getNodeW("sqr_manual_splits");
                    if (splitsW) splitsW.value = splitResult.join(",");
                }

                // ── Set segment mode in hidden widget ──
                const modeW = getNodeW("sqr_segment_mode");
                if (modeW) modeW.value = segMode;
                const execScopeW = getNodeW("sqr_execution_scope");
                if (execScopeW) execScopeW.value = sqrNode._sqrSettings?.executionScope || "start_to_end";

                if (resumePath) {
                    const prePaths = await _showPreSegmentDialog(sqrNode);
                    if (prePaths === null) return;
                    if (prePaths?.cancelResume) {
                        const preW = getNodeW("sqr_pre_segments");
                        if (preW) preW.value = "";
                        continue;
                    }
                    const preW = getNodeW("sqr_pre_segments");
                    if (preW) preW.value = prePaths.join(",");
                } else {
                    const preW = getNodeW("sqr_pre_segments");
                    if (preW) preW.value = "";
                }
            }

            const tempLoadVideoPatches = [];
            try {
                const patchedNodeIds = new Set();
                for (const sqrNode of sqrNodes) {
                    const plan = await _sqrBuildLoadVideoNthBypassPlan(sqrNode);
                    if (!plan?.vidNode) continue;
                    const patchKey = String(plan.vidNode.id);
                    if (patchedNodeIds.has(patchKey)) continue;
                    patchedNodeIds.add(patchKey);
                    const snapshot = _sqrSnapshotLoadVideoNode(plan.vidNode);
                    _sqrApplyLoadVideoParams(plan.vidNode, plan.injected);
                    tempLoadVideoPatches.push({ vidNode: plan.vidNode, snapshot });
                    console.info(`[SQR] 提交前临时覆盖 Load Video：${plan.displayName || plan.vidNode.id} ｜ nth ${plan.current.selectEveryNth} → 1 ｜ 当前 ${plan.current.totalFrames} 帧 → 注入 ${plan.desired.totalFrames} 帧`);
                }
            } catch (e) {
                console.warn("[SQR] Load Video 提交前临时注入失败，已跳过该优化:", e);
            }

            let submitResult;
            try {
                const { output: fullOutput, workflow: lgWorkflow } = await app.graphToPrompt();
                const upstreamIds = new Set();
                for (const sqrNode of sqrNodes) { _sqrCollectUpstream(String(sqrNode.id), fullOutput, upstreamIds); }
                for (const sqrNode of sqrNodes) { const sqrId = String(sqrNode.id); for (const [nid, ndata] of Object.entries(fullOutput)) { const vals = Object.values(ndata.inputs || {}); if (vals.some(v => Array.isArray(v) && v.length === 2 && String(v[0]) === sqrId)) { upstreamIds.add(nid); } } }
                const strippedOutput = {};
                for (const nid of upstreamIds) { if (fullOutput[nid]) strippedOutput[nid] = fullOutput[nid]; }
                const clientId = api?.clientId ?? app.api?.clientId ?? globalThis.api?.clientId ?? "";
                if (!clientId) console.warn("[SQR] client_id 为空，分段子任务可能无法显示 WanAnimatePlus 动态采样预览。");
                const res = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ client_id: clientId, prompt: strippedOutput, extra_data: { extra_pnginfo: { workflow: lgWorkflow, sqr_full_prompt: fullOutput, sqr_client_id: clientId } } }) });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                submitResult = await res.json();

            } catch (e) {
                console.warn("[SQR] 精简提交失败，回退到完整 prompt:", e);
                submitResult = await origQueuePrompt(number, batchCount);
            } finally {
                for (let i = tempLoadVideoPatches.length - 1; i >= 0; i--) {
                    const item = tempLoadVideoPatches[i];
                    try { _sqrRestoreLoadVideoNode(item.vidNode, item.snapshot); } catch (e) {}
                }
            }
            return submitResult;
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "SegmentQueueRunner") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            const r = origCreated ? origCreated.apply(this, arguments) : undefined;
            const node = this;
            const getW = name => node.widgets?.find(w => w.name === name);

            const sqrKeys = ["参考图节点ID","参考视频节点ID","输出节点ID","动作嵌入节点ID","姿态模型节点ID","脸部模型节点ID","分段参考图","续跑视频路径","本地姿态视频路径","本地人脸视频路径"];
            const resumeToggle = getW("启用续跑");
            if (resumeToggle) { resumeToggle.computeSize = () => [0, -4]; resumeToggle.type = "hidden"; }
            sqrKeys.forEach(k => {
                const w = getW(k);
                if (w) { w.computeSize = () => [0, -4]; w.type = "hidden"; }
            });
            {
                const _spw = getW("sqr_save_png");
                if (_spw) { _spw.computeSize = () => [0, -4]; _spw.draw = () => {}; _spw.type = "hidden"; }
            }

            const segW = getW("分段数");
            const startW = getW("从第几段开始");


            function _sqrApplyExecutionScope() {
                const scope = node._sqrSettings?.executionScope || "start_to_end";
                const scopeW = getW("sqr_execution_scope");
                if (scopeW) scopeW.value = scope;
                if (startW) {
                    startW.label = scope === "single_segment" ? "目标段号" : null;
                    startW.options.min = 1;
                    const mx = segW?._sqrFixedMode ? 100 : (segW ? Math.max(1, Math.round(segW.value)) : 100);
                    startW.options.max = mx;
                    if (startW.value > mx) startW.value = mx;
                }
                node.setDirtyCanvas?.(true, true);
            }

            function _sqrApplySegMax() {
                const mode = node._sqrSettings?.segmentMode || "average";
                if (mode === "fixed") return;
                const maxVal = Math.max(2, Math.min(100, node._sqrSettings?.segMax || 100));
                if (segW) {
                    segW.options.max = maxVal;
                    if (segW.value > maxVal) segW.value = maxVal;
                }
                if (startW) {
                    const curSeg = segW ? Math.round(segW.value) : maxVal;
                    startW.options.max = curSeg;
                    if (startW.value > curSeg) startW.value = curSeg;
                }
                node.setDirtyCanvas?.(true, true);
            }

            function _sqrApplySegmentMode() {
                const mode = node._sqrSettings?.segmentMode || "average";
                if (!segW) return;
                const modeW = getW("sqr_segment_mode");
                if (modeW) modeW.value = mode;

                if (mode === "fixed") {
                    segW.label = "每段帧数";
                    segW._sqrFixedMode = true;
                    // 需求3: 后端最小段长已真改为 41，前端下限允许从 41 起
                    const _fminCfg = Math.max(41, parseInt(node._sqrSettings?.fixedFrameMin || 61, 10) || 61);
                    // 下限也对齐到 4n+1
                    const fmin = ((_fminCfg - 1) >> 2) * 4 + 1 < _fminCfg
                        ? _fminCfg
                        : Math.max(41, Math.round((_fminCfg - 1) / 4) * 4 + 1);
                    const fmax = Math.max(fmin, node._sqrSettings?.fixedFrameMax || 361);
                    segW.options.min = fmin;
                    segW.options.max = fmax;
                    segW.options.step = 4;
                    let v = Math.round(segW.value);
                    if (v < fmin) v = fmin;
                    v = Math.round((v - 1) / 4) * 4 + 1;
                    if (v < fmin) v = fmin;
                    if (v > fmax) v = fmax;
                    segW.value = v;
                    if (startW) { startW.options.max = 100; startW.options.min = 1; }
                } else {
                    segW.label = null;
                    segW._sqrFixedMode = false;
                    segW.options.min = 2;
                    segW.options.step = 1;
                    _sqrApplySegMax();
                }
                _sqrApplyExecutionScope();
                node.setDirtyCanvas?.(true, true);
            }

            if (segW) {
                const _origSegDraw = segW.draw;
                const _origSegMouse = segW.mouse;
                const _initVal = segW.value;
                Object.defineProperty(segW, 'value', {
                    get() { return this._sqr_val !== undefined ? this._sqr_val : 2; },
                    set(v) {
                        if (this._sqrFixedMode) {
                            let iv = Math.round(v);
                            iv = Math.round((iv - 1) / 4) * 4 + 1;
                            const fmin = this.options?.min || 41;
                            if (iv < fmin) iv = fmin;
                            const fmax = this.options?.max || 361;
                            if (iv > fmax) {
                                iv = Math.floor((fmax - 1) / 4) * 4 + 1;
                            }
                            this._sqr_val = iv;
                        } else {
                            this._sqr_val = v;
                        }
                    },
                    configurable: true,
                    enumerable: true,
                });
                segW._sqr_val = _initVal ?? 2;
            }

            if (segW) {
                const _origSegCb = segW.callback;
                segW.callback = function(v, ...args) {
                    if (segW._sqrFixedMode) {
                        let iv = Math.round(v);
                        iv = Math.round((iv - 1) / 4) * 4 + 1;
                        const fmin = segW.options.min || 41;
                        if (iv < fmin) iv = fmin;
                        const fmax = segW.options.max || 361;
                        if (iv > fmax) iv = fmax;
                        this.value = iv;
                    } else {
                        const iv = Math.round(v);
                        if (startW) {
                            startW.options.max = iv;
                            if (startW.value > iv) startW.value = iv;
                        }
                    }
                    if (_origSegCb) return _origSegCb.call(this, v, ...args);
                };
            }

            if (startW) {
                const _origStartCb = startW.callback;
                startW.callback = function(v, ...args) {
                    const mx = segW?._sqrFixedMode ? 100 : (segW ? Math.round(segW.value) : 100);
                    if (v > mx) { this.value = mx; v = mx; }
                    if (_origStartCb) return _origStartCb.call(this, v, ...args);
                };
            }

            const getSqr = k => getW(k)?.value || "";
            const setSqr = (k, v) => { const w = getW(k); if (w) w.value = v; };
            const _setResumeMode = mode => {
                const val = String(mode || "");
                node._sqrResumeMode = val;
                setSqr("sqr_resume_kind", val);
            };
            const _getResumeMode = () => String(node._sqrResumeMode || getSqr("sqr_resume_kind") || "");
            const _truncateResumeName = rawPath => {
                const fname = String(rawPath || "").split(/[\/]/).pop() || "";
                const availPx = Math.max(40, (node.size?.[0] || 200) - 62);
                const tc = document.createElement("canvas").getContext("2d");
                tc.font = "13px sans-serif";
                let dispName = fname;
                while (dispName.length > 2 && tc.measureText(dispName + "…").width > availPx) dispName = dispName.slice(0, -1);
                if (dispName !== fname) dispName = dispName.slice(0, -1) + "…";
                return { fname, dispName: dispName || fname || String(rawPath || "") };
            };

            const _renderResumeButton = (path, opts = {}) => {
                const cleanPath = String(path || "").trim();
                if (!cleanPath) {
                    resumeBtn._sqrActive = false;
                    resumeBtn.name = opts.clearedLabel || "🎬  选择续跑视频";
                    node.setDirtyCanvas?.(true, true);
                    return;
                }
                const { fname, dispName } = _truncateResumeName(cleanPath);
                const m = fname.match(/sqr_trans_[0-9_]+_seg(\d+)\.mp4$/i) || fname.match(/sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$/i) || fname.match(/segment_transition_seg(\d+)\.mp4$/i);
                if (m && opts.autoSegmentHint !== false) {
                    const seg = parseInt(m[1]) + 1;
                    const maxSeg = segW ? Math.round(segW.value) : 100;
                    const fromW = getW("从第几段开始");
                    if (seg <= maxSeg) {
                        if (fromW) fromW.value = seg;
                        resumeBtn.name = `🎬  ${dispName}  ← 第${seg}段开始`;
                    } else {
                        resumeBtn.name = `🎬  ${dispName}  ← 请手动设置从第几段开始`;
                    }
                    setTimeout(() => {
                        if ((getSqr("续跑视频路径") || "").trim() === cleanPath) {
                            resumeBtn.name = `🎬  ${dispName}`;
                            node.setDirtyCanvas?.(true, true);
                        }
                    }, 3000);
                } else {
                    const rm = String(_getResumeMode() || "");
                    if (rm === "manual_continuous") resumeBtn.name = `🎬  ${dispName}  · 连续型`;
                    else if (rm === "manual_noncontinuous") resumeBtn.name = `🎬  ${dispName}  · 非连续型`;
                    else resumeBtn.name = `🎬  ${dispName}`;
                }
                resumeBtn._sqrActive = true;
                node.setDirtyCanvas?.(true, true);
            };

            const _applyResumeState = (path, opts = {}) => {
                const cleanPath = String(path || "").trim();
                setSqr("续跑视频路径", cleanPath);
                const rtw = getW("启用续跑"); if (rtw) rtw.value = !!cleanPath;
                if (cleanPath) {
                    if (Object.prototype.hasOwnProperty.call(opts, "resumeMode")) _setResumeMode(opts.resumeMode);
                    _renderResumeButton(cleanPath, opts);
                } else {
                    if (!opts.keepStartSegment) { const fromW2 = getW("从第几段开始"); if (fromW2) fromW2.value = 1; }
                    if (!opts.keepFrameOffset) { const foW2 = getW("sqr_frame_offset"); if (foW2) foW2.value = -1; }
                    if (!opts.keepManualSplits) { const msW2 = getW("sqr_manual_splits"); if (msW2) msW2.value = ""; }
                    _setResumeMode(opts.resumeMode || "");
                    _renderResumeButton("", opts);
                }
            };

            const _SQR_PNG_KEY   = "sqr_save_png";
            const _SQR_SEGMAX_KEY = "sqr_seg_max";
            const _SQR_EXECGLOW_KEY = "sqr_exec_glow";
            const _SQR_SEGMODE_KEY = "sqr_segment_mode";
            const _SQR_TRIMMERGE_KEY = "sqr_trim_merge_mode";
            const _SQR_FIXEDMAX_KEY = "sqr_fixed_frame_max";
            const _SQR_FIXEDMIN_KEY = "sqr_fixed_frame_min";
            const _SQR_EXECSCOPE_KEY = "sqr_execution_scope";
            if (!node._sqrSettings) {
                const savedPng  = localStorage.getItem(_SQR_PNG_KEY);
                const savedSegMax = localStorage.getItem(_SQR_SEGMAX_KEY);
                const savedExecGlow = localStorage.getItem(_SQR_EXECGLOW_KEY);
                const savedSegMode = localStorage.getItem(_SQR_SEGMODE_KEY);
                const savedFixedMax = localStorage.getItem(_SQR_FIXEDMAX_KEY);
                const savedFixedMin = localStorage.getItem(_SQR_FIXEDMIN_KEY);
                const savedExecScope = localStorage.getItem(_SQR_EXECSCOPE_KEY);
                node._sqrSettings = {
                    savePng: savedPng === null ? true : (savedPng !== "false"),
                    segMax: savedSegMax ? parseInt(savedSegMax) : 10,
                    execGlow: savedExecGlow === null ? true : (savedExecGlow !== "false"),
                    segmentMode: savedSegMode || "average",
                    trimMergeMode: SQR_TRIM_SPLIT,
                    fixedFrameMin: savedFixedMin ? parseInt(savedFixedMin) : 61,
                    fixedFrameMax: savedFixedMax ? parseInt(savedFixedMax) : 361,
                    executionScope: savedExecScope || "start_to_end",
                };
            }

            _sqrApplySegMax();
            _sqrApplySegmentMode();
            _sqrApplyExecutionScope();
            if (typeof node._sqrResumeMode !== "string") node._sqrResumeMode = "";
            // 暴露给外部调用（用于 checkpoint 恢复分段模式）
            node._sqrApplySegmentMode = _sqrApplySegmentMode;
            node._sqrApplyExecutionScope = _sqrApplyExecutionScope;

            const execW = getW("执行");
            if (execW) {
                execW.draw = function(ctx, nodeRef, w, y, H) {
                    const isExec = !!this.value;
                    ctx.fillStyle = isExec ? "rgba(40,160,100,0.35)" : "rgba(255,255,255,0.05)";
                    ctx.beginPath();
                    ctx.roundRect ? ctx.roundRect(4, y+2, w-8, H-4, 4) : ctx.rect(4, y+2, w-8, H-4);
                    ctx.fill();
                    if (isExec) { ctx.strokeStyle = "rgba(60,200,130,0.7)"; ctx.lineWidth = 1; ctx.stroke(); }
                    const label = isExec ? "🚀  执行模式" : "👁️  预览模式";
                    ctx.fillStyle = isExec ? "#7fffb0" : "rgba(190,190,190,0.5)";
                    ctx.font = "12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    ctx.fillText(label, w / 2, y + H / 2);
                    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
                };
                execW.mouse = function(event, pos, node) {
                    if (event.type === "pointerdown" || event.type === "mousedown") {
                        this.value = !this.value;
                        node.setDirtyCanvas?.(true, true);
                        if (this.callback) this.callback(this.value);
                        return true;
                    }
                    return false;
                };
            }

            const _origDrawBg = node.onDrawBackground;
            node.onDrawBackground = function(ctx) {
                if (_origDrawBg) _origDrawBg.call(this, ctx);
                if (!node._sqrSettings?.execGlow) return;
                const eW = getW("执行");
                if (!eW || !eW.value) return;
                ctx.save();
                ctx.strokeStyle = "rgba(60,200,130,0.7)";
                ctx.lineWidth = 1.5;
                ctx.shadowColor = "rgba(60,200,130,0.6)";
                ctx.shadowBlur = 8;
                ctx.beginPath();
                const r = 6;
                ctx.roundRect ? ctx.roundRect(-1, -LiteGraph.NODE_TITLE_HEIGHT - 1, this.size[0] + 2, this.size[1] + LiteGraph.NODE_TITLE_HEIGHT + 2, r)
                              : ctx.rect(-1, -LiteGraph.NODE_TITLE_HEIGHT - 1, this.size[0] + 2, this.size[1] + LiteGraph.NODE_TITLE_HEIGHT + 2);
                ctx.stroke();
                ctx.restore();
            };

            // ── ⚙ 设置按钮 ──
            const settingsBtn = node.addWidget("button", "⚙️  设置", null, () => {
                document.getElementById("sqr-settings-overlay")?.remove();
                const s = node._sqrSettings;
                const overlay = document.createElement("div");
                overlay.id = "sqr-settings-overlay";
                Object.assign(overlay.style, {
                    position:"fixed",inset:"0",zIndex:"10000",
                    background:"rgba(0,0,0,.72)",display:"flex",alignItems:"center",justifyContent:"center"
                });
                const box = document.createElement("div");
                Object.assign(box.style, {
                    background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
                    border:"1px solid var(--border-color,#444)",borderRadius:"12px",
                    padding:"22px 26px",width:"520px",maxWidth:"calc(100vw - 40px)",
                    maxHeight:"90vh",overflowY:"auto",
                    display:"flex",flexDirection:"column",gap:"16px",
                    boxShadow:"0 8px 40px rgba(0,0,0,.7)",position:"relative"
                });
                // 修复：flex column 布局下子元素默认会被压缩，当内容超过 90vh 时
                // 按钮行会被挤出屏幕外。注入作用域 CSS 强制子元素不收缩，让 box 正常滚动。
                box.id = "sqr-settings-dialog-box";
                if (!document.getElementById("sqr-settings-dialog-style")) {
                    const _noShrinkStyle = document.createElement("style");
                    _noShrinkStyle.id = "sqr-settings-dialog-style";
                    _noShrinkStyle.textContent = "#sqr-settings-dialog-box > * { flex-shrink: 0 !important; }";
                    document.head.appendChild(_noShrinkStyle);
                }
                const mkDiv=(t,st)=>Object.assign(document.createElement("div"),{textContent:t,style:st||""});
                box.appendChild(mkDiv("⚙️  分段队列 · 设置","font-size:15px;font-weight:700;"));
                const mkRemoteHint = (text) => {
                    const el = document.createElement("div");
                    Object.assign(el.style, { padding:"10px 14px", borderRadius:"8px", fontSize:"12px", lineHeight:"1.7", border:"1px solid rgba(100,180,255,0.3)", background:"rgba(60,140,255,0.08)", color:"var(--input-text,#ccc)" });
                    el.innerHTML = `<span style="color:#7cf;font-weight:600;">🌐 远程模式</span>&nbsp; ${text}`;
                    return el;
                };

                const isRemote = _sqrIsRemote();
                // ── 分段模式 ──
                box.appendChild(Object.assign(document.createElement("div"),{style:"border-top:1px solid var(--border-color,#444);"}));
                {
                    const modeTitle = document.createElement("div");
                    modeTitle.textContent = "分段模式";
                    modeTitle.style.cssText = "font-size:11px;opacity:.5;margin-bottom:2px;";
                    box.appendChild(modeTitle);
                    const modeRow = document.createElement("div"); modeRow.style.cssText = "display:flex;gap:8px;";
                    const mkModeOpt = (value, title) => {
                        const d = document.createElement("div"); const active = (s.segmentMode === value);
                        Object.assign(d.style, { flex:"1", padding:"8px 6px", boxSizing:"border-box", borderRadius:"8px", cursor:"pointer",
                            border: active ? "2px solid #4a9" : "2px solid var(--border-color,#555)", background: active ? "rgba(60,180,120,0.12)" : "transparent",
                            textAlign:"center", fontSize:"12px", fontWeight:"600", lineHeight:"1.4" });
                        d.textContent = title;
                        d.dataset.segmode = value;
                        d.onclick = () => {
                            s.segmentMode = value;
                            modeRow.querySelectorAll("div[data-segmode]").forEach(x => {
                                const me = x.dataset.segmode === value;
                                x.style.border = me ? "2px solid #4a9" : "2px solid var(--border-color,#555)";
                                x.style.background = me ? "rgba(60,180,120,0.12)" : "transparent";
                            });
                            // 问题4: 分段数范围和每段帧数范围始终并列显示，不再根据模式切换
                        };
                        return d;
                    };
                    modeRow.append(
                        mkModeOpt("average", "平均分段"),
                        mkModeOpt("manual", "手动分段"),
                        mkModeOpt("fixed", "固定每段帧数")
                    );
                    box.appendChild(modeRow);
                }

                const segMaxSection = document.createElement("div");
                segMaxSection.style.cssText = "display:flex;align-items:center;gap:10px;margin-top:4px;";
                if (!isRemote) {
                    const segMaxLabel = document.createElement("span"); segMaxLabel.textContent = "分段数滑动条范围 2 ~"; segMaxLabel.style.cssText = "font-size:12px;opacity:.7;";
                    const segMaxInput = document.createElement("input"); segMaxInput.type = "number"; segMaxInput.min = "2"; segMaxInput.max = "100"; segMaxInput.value = String(s.segMax || 10);
                    Object.assign(segMaxInput.style, { width:"70px", padding:"5px 8px", borderRadius:"5px", border:"1px solid var(--border-color,#555)", background:"var(--comfy-input-bg,#333)", color:"var(--input-text,#eee)", fontSize:"13px" });
                    segMaxInput.onchange = () => { let v = parseInt(segMaxInput.value) || 10; v = Math.max(2, Math.min(100, v)); segMaxInput.value = v; s.segMax = v; };
                    const segMaxHint = document.createElement("span"); segMaxHint.textContent = "（2-100，默认10）"; segMaxHint.style.cssText = "font-size:11px;opacity:.4;";
                    segMaxSection.append(segMaxLabel, segMaxInput, segMaxHint);
                    box.appendChild(segMaxSection);
                } else {
                    box.appendChild(mkDiv(`当前分段最大值：${s.segMax}`,"font-size:12px;opacity:.7;padding:4px 0;"));
                }

                let fixedMaxSection = null;
                if (!isRemote) {
                    fixedMaxSection = document.createElement("div");
                    fixedMaxSection.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap;";

                    const fmLabel = document.createElement("span");
                    fmLabel.textContent = "每段帧数滑动条范围";
                    fmLabel.style.cssText = "font-size:12px;opacity:.7;";

                    // ── 下限输入（41-361，默认 61）──
                    const fminInput = document.createElement("input");
                    fminInput.type = "number"; fminInput.min = "41"; fminInput.max = "361";
                    fminInput.value = String(s.fixedFrameMin || 61);
                    Object.assign(fminInput.style, { width:"70px", padding:"5px 8px", borderRadius:"5px", border:"1px solid var(--border-color,#555)", background:"var(--comfy-input-bg,#333)", color:"var(--input-text,#eee)", fontSize:"13px" });

                    const fmMid = document.createElement("span");
                    fmMid.textContent = "~";
                    fmMid.style.cssText = "font-size:12px;opacity:.7;";

                    // ── 上限输入（361-1001，默认 361）──
                    const fmInput = document.createElement("input");
                    fmInput.type = "number"; fmInput.min = "361"; fmInput.max = "1001";
                    fmInput.value = String(s.fixedFrameMax || 361);
                    Object.assign(fmInput.style, { width:"70px", padding:"5px 8px", borderRadius:"5px", border:"1px solid var(--border-color,#555)", background:"var(--comfy-input-bg,#333)", color:"var(--input-text,#eee)", fontSize:"13px" });

                    const _align4n1 = (v) => Math.round((v - 1) / 4) * 4 + 1;

                    fminInput.onchange = () => {
                        let v = parseInt(fminInput.value) || 61;
                        v = Math.max(41, Math.min(361, v));
                        v = _align4n1(v);
                        if (v < 41) v = 41;
                        if (v > 361) v = 361;
                        fminInput.value = v;
                        s.fixedFrameMin = v;
                    };
                    fmInput.onchange = () => {
                        let v = parseInt(fmInput.value) || 361;
                        v = Math.max(361, Math.min(1001, v));
                        v = _align4n1(v);
                        if (v < 361) v = 361;
                        if (v > 1001) v = 1001;
                        fmInput.value = v;
                        s.fixedFrameMax = v;
                    };

                    const fmHint = document.createElement("span");
                    fmHint.textContent = `（下限 41-361 默认 61；上限 361-1001 默认 361；必须 4n+1。每段实际生成帧数下限建议 ≥61，过低会影响效率和质量；每段实际生成帧数上限建议 < 原本单次最大能运行帧数 - ${SQR_TRANSITION_FRAMES}）`;
                    fmHint.style.cssText = "font-size:11px;opacity:.4;width:100%;line-height:1.5;";

                    fixedMaxSection.append(fmLabel, fminInput, fmMid, fmInput, fmHint);
                    box.appendChild(fixedMaxSection);
                }
                box.appendChild(Object.assign(document.createElement("div"),{style:"border-top:1px solid var(--border-color,#444);"}));
                box.appendChild(mkDiv("执行范围","font-size:11px;opacity:.5;margin-bottom:2px;"));
                const execScopeRow = document.createElement("div"); execScopeRow.style.cssText="display:flex;gap:10px;";
                const mkExecScopeOpt = (value, label, desc) => {
                    const d = document.createElement("div");
                    const active = (s.executionScope === value);
                    Object.assign(d.style, { flex:"1", padding:"8px 12px", minHeight:"68px", boxSizing:"border-box", borderRadius:"8px", cursor:"pointer", border: active ? "2px solid #4a9" : "2px solid var(--border-color,#555)", background: active ? "rgba(60,180,120,0.12)" : "transparent" });
                    d.innerHTML = `<div style="font-size:13px;font-weight:600;">${label}</div><div style="font-size:11px;opacity:.5;margin-top:2px;line-height:1.5;">${desc}</div>`;
                    d.dataset.execscope = value;
                    d.onclick = () => {
                        s.executionScope = value;
                        execScopeRow.querySelectorAll("div[data-execscope]").forEach(x => {
                            const me = x.dataset.execscope === value;
                            x.style.border = me ? "2px solid #4a9" : "2px solid var(--border-color,#555)";
                            x.style.background = me ? "rgba(60,180,120,0.12)" : "transparent";
                        });
                    };
                    return d;
                };
                execScopeRow.append(
                    mkExecScopeOpt("start_to_end", "从第N段开始跑到最后", "默认模式"),
                    mkExecScopeOpt("single_segment", "只跑第N段", "试跑/重跑某段模式：仅输出目标段")
                );
                box.appendChild(execScopeRow);
                box.appendChild(Object.assign(document.createElement("div"),{style:"border-top:1px solid var(--border-color,#444);"}));
                box.appendChild(mkDiv("执行模式时节点边缘高亮","font-size:11px;opacity:.5;margin-bottom:2px;"));
                if (!isRemote) {
                    const glowRow = document.createElement("div"); glowRow.style.cssText = "display:flex;gap:10px;";
                    const mkGlowOpt = (value, label, desc) => {
                        const d = document.createElement("div"); const active = (s.execGlow === value);
                        Object.assign(d.style, { flex:"1", padding:"8px 12px", minHeight:"52px", boxSizing:"border-box", borderRadius:"8px", cursor:"pointer",
                            border: active ? "2px solid #4a9" : "2px solid var(--border-color,#555)", background: active ? "rgba(60,180,120,0.12)" : "transparent" });
                        d.innerHTML = `<div style="font-size:13px;font-weight:600;">${label}</div><div style="font-size:11px;opacity:.5;margin-top:2px;">${desc}</div>`;
                        d.dataset.glowval = String(value);
                        d.onclick = () => { s.execGlow = value; glowRow.querySelectorAll("div[data-glowval]").forEach(x => { const me = x.dataset.glowval === String(value); x.style.border = me ? "2px solid #4a9" : "2px solid var(--border-color,#555)"; x.style.background = me ? "rgba(60,180,120,0.12)" : "transparent"; }); };
                        return d;
                    };
                    glowRow.append(mkGlowOpt(true, "✅ True", "执行模式时节点边缘绿色发光"), mkGlowOpt(false, "🚫 False", "不显示边缘高亮"));
                    box.appendChild(glowRow);
                } else {
                    box.appendChild(mkDiv(`当前：${s.execGlow ? "开启" : "关闭"}`,"font-size:12px;opacity:.7;padding:4px 0;"));
                }
                box.appendChild(Object.assign(document.createElement("div"),{style:"border-top:1px solid var(--border-color,#444);"}));
                box.appendChild(mkDiv("Save png of first frame for metadata","font-size:11px;opacity:.5;margin-bottom:2px;"));
                if (isRemote) {
                    const pngW = getW("sqr_save_png"); if (pngW) pngW.value = "false";
                    box.appendChild(mkRemoteHint("固定为<b style='color:#aef;'>不保存 png</b>，远程环境下自动清理元数据图片以节省空间。"));
                } else {
                    const pngRow = document.createElement("div"); pngRow.style.cssText="display:flex;gap:10px;";
                    const mkPngOpt = (value, label, desc) => { const d = document.createElement("div"); const active = (s.savePng === value); Object.assign(d.style, { flex:"1", padding:"8px 12px", minHeight:"68px", boxSizing:"border-box", borderRadius:"8px", cursor:"pointer", border: active ? "2px solid #4a9" : "2px solid var(--border-color,#555)", background: active ? "rgba(60,180,120,0.12)" : "transparent" }); d.innerHTML = `<div style="font-size:13px;font-weight:600;">${label}</div><div style="font-size:11px;opacity:.5;margin-top:2px;">${desc}</div>`; d.dataset.pngval = String(value); d.onclick = () => { s.savePng = value; pngRow.querySelectorAll("div[data-pngval]").forEach(x => { const me = x.dataset.pngval === String(value); x.style.border = me ? "2px solid #4a9" : "2px solid var(--border-color,#555)"; x.style.background = me ? "rgba(60,180,120,0.12)" : "transparent"; }); }; return d; };
                    pngRow.append(mkPngOpt(true,"✅ True","保存 png"),mkPngOpt(false,"🚫 False","不保存 png（自动清理）"));
                    box.appendChild(pngRow);
                }
                const btns=document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:6px;";
                const mkBtn=(t,st,fn)=>{const b=document.createElement("button");b.textContent=t;b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${st}`;b.onclick=fn;return b;};
                btns.append(
                    mkBtn("取消","",()=>overlay.remove()),
                    mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{
                        const trimMergeW = getW("sqr_trim_merge_mode");
                        if (trimMergeW) trimMergeW.value = SQR_TRIM_SPLIT;
                        try { localStorage.removeItem(_SQR_TRIMMERGE_KEY); } catch(e) {}
                        if (!isRemote) {
                            localStorage.setItem(_SQR_PNG_KEY, String(s.savePng));
                            localStorage.setItem(_SQR_SEGMAX_KEY, String(s.segMax));
                            localStorage.setItem(_SQR_EXECGLOW_KEY, String(s.execGlow));
                            localStorage.setItem(_SQR_SEGMODE_KEY, s.segmentMode);
                            localStorage.setItem(_SQR_FIXEDMIN_KEY, String(s.fixedFrameMin));
                            localStorage.setItem(_SQR_FIXEDMAX_KEY, String(s.fixedFrameMax));
                            localStorage.setItem(_SQR_EXECSCOPE_KEY, s.executionScope || "start_to_end");
                            const pngW = getW("sqr_save_png");
                            if (pngW) pngW.value = String(s.savePng);
                            const minSegW = getW("sqr_min_seg_frames");
                            if (minSegW) minSegW.value = String(s.fixedFrameMin || 61);
                            _sqrApplySegmentMode();
                            _sqrApplyExecutionScope();
                        }
                        overlay.remove();
                        node.setDirtyCanvas?.(true, true);
                    })
                );
                box.appendChild(btns);
                const _xBtn = document.createElement("button");
                _xBtn.textContent = "×";
                _xBtn.style.cssText = "position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";
                _xBtn.onmouseover = () => _xBtn.style.color = "#fff";
                _xBtn.onmouseout  = () => _xBtn.style.color = "var(--input-text,#aaa)";
                _xBtn.onclick = () => overlay.remove();
                box.style.position = "relative";
                box.appendChild(_xBtn);
                overlay.appendChild(box);
                overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
                document.body.appendChild(overlay);
            });
            settingsBtn.serialize = false;

            // ── 🔧 设置节点 ID 按钮 ──
            const nodeIdBtn = node.addWidget("button", "🔧  设置节点 ID", null, () => {
                showNodeIdSelector([
                    {key:"参考图节点ID",   label:"参考图 LoadImage ID",        tooltip:"LoadImage node ID",               value:getSqr("参考图节点ID")},
                    {key:"参考视频节点ID", label:"参考视频 Load Video ID",      tooltip:"Load Video (target) node ID",     value:getSqr("参考视频节点ID")},
                    {key:"输出节点ID",     label:"输出 VHS_VideoCombine ID",    tooltip:"Main output VHS_VideoCombine ID", value:getSqr("输出节点ID")},
                    {key:"动作嵌入节点ID", label:"WanAnimatePlus Embeds ID", tooltip:"WanAnimatePlus AnimateEmbeds / SCAIL_2 Embeds node ID", value:getSqr("动作嵌入节点ID")},
                    {key:"姿态模型节点ID", label:"姿态模型节点 ID",              tooltip:"姿态模型节点 ID（如 409）",          value:getSqr("姿态模型节点ID")},
                    {key:"脸部模型节点ID", label:"脸部模型节点 ID",              tooltip:"脸部模型节点 ID（如 346）",          value:getSqr("脸部模型节点ID")},
                    {
                        key:"本地姿态视频路径",
                        label:"本地姿态视频",
                        tooltip:"选择与主参考视频同步的本地姿态视频",
                        kind:"video_selector",
                        buttonText:"💃选择本地姿态视频🕺",
                        emptyText:"（未选择本地姿态视频）",
                        value:getSqr("本地姿态视频路径"),
                        pick: async (currentValue) => {
                            return await _pickManagedVideo({ currentPath: currentValue || "", showManager: false });
                        }
                    },
                    {
                        key:"本地人脸视频路径",
                        label:"本地人脸视频",
                        tooltip:"选择与主参考视频同步的本地人脸视频",
                        kind:"video_selector",
                        buttonText:"😉选择本地人脸视频😜",
                        emptyText:"（未选择本地人脸视频）",
                        value:getSqr("本地人脸视频路径"),
                        pick: async (currentValue) => {
                            return await _pickManagedVideo({ currentPath: currentValue || "", showManager: false });
                        }
                    },
                ], result=>{
                    Object.entries(result).forEach(([k,v]) => setSqr(k, v));
                    node.setDirtyCanvas?.(true, true);
                });
            });
            nodeIdBtn.serialize = false;

            // ── 📋 查看日志按钮 ──
            const logBtn = node.addWidget("button", "📋  查看日志", null, () => {
                _showLogOverlay(String(node.id));
            });
            logBtn.serialize = false;
            logBtn.draw = function(ctx, node, widget_width, y, H) {
                const on = !!document.getElementById(`sqr-log-${node.id}`);
                ctx.fillStyle = on ? "rgba(40,160,100,0.35)" : "rgba(255,255,255,0.05)";
                ctx.beginPath();
                if(ctx.roundRect) ctx.roundRect(4,y+2,widget_width-8,H-4,4);
                else ctx.rect(4,y+2,widget_width-8,H-4);
                ctx.fill();
                if(on){ctx.strokeStyle="rgba(60,200,130,0.7)";ctx.lineWidth=1;ctx.stroke();}
                ctx.fillStyle = on ? "#7fffb0" : "rgba(190,190,190,0.5)";
                ctx.font="12px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";
                ctx.fillText(this.name,widget_width/2,y+H/2);
                ctx.textAlign="left";ctx.textBaseline="alphabetic";
            };

            // ── 单视频管理/选择辅助 ──
            const _showSingleVideoManager = ({ overlayId = "sqr-vidmgr-overlay", title = "🎬  已选视频", hint = "右键可移除已选视频", emptyHint = "（未选择视频）", clearButtonText = "⊗ 清空视频", currentPath = "", icon = "🎬" }, onConfirm) => {
                document.getElementById(overlayId)?.remove();
                let curPath = currentPath || "";
                const overlay = document.createElement("div"); overlay.id = overlayId;
                Object.assign(overlay.style, { position:"fixed", inset:"0", zIndex:"10001", background:"rgba(0,0,0,.75)", display:"flex", alignItems:"center", justifyContent:"center" });
                const box = document.createElement("div");
                Object.assign(box.style, { background:"var(--comfy-menu-bg,#1e1e1e)", color:"var(--input-text,#eee)", border:"1px solid var(--border-color,#444)", borderRadius:"12px", padding:"18px 22px", width:"500px", display:"flex", flexDirection:"column", gap:"10px", boxShadow:"0 8px 40px rgba(0,0,0,.7)", position:"relative" });
                const mkDiv = (t, s) => Object.assign(document.createElement("div"), { textContent:t, style:s||"" });
                box.appendChild(mkDiv(title, "font-size:14px;font-weight:600;"));
                box.appendChild(mkDiv(hint, "font-size:11px;opacity:.5;"));
                const vidArea = document.createElement("div");
                Object.assign(vidArea.style, { padding:"10px", border:"1px solid var(--border-color,#444)", borderRadius:"8px", minHeight:"52px" });
                function renderVid() {
                    vidArea.innerHTML = "";
                    if (!curPath) {
                        vidArea.appendChild(mkDiv(emptyHint, "opacity:.4;font-size:12px;padding:4px;"));
                    } else {
                        const fname = curPath.split(/[/\\]/).pop();
                        const row = document.createElement("div");
                        Object.assign(row.style, { display:"flex", alignItems:"center", gap:"8px", padding:"8px 10px", borderRadius:"6px", background:"rgba(60,180,120,0.12)", border:"1px solid #4a9", cursor:"default" });
                        row.innerHTML = `<span style="font-size:18px">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6df;">${fname}</span><span style="opacity:.35;font-size:10px;flex-shrink:0;">右键移除</span>`;
                        row.title = curPath;
                        row.oncontextmenu = e => { e.preventDefault(); curPath = ""; renderVid(); };
                        vidArea.appendChild(row);
                    }
                }
                renderVid();
                box.appendChild(vidArea);
                const btns = document.createElement("div"); btns.style.cssText = "display:flex;gap:8px;";
                const mkBtn = (t, s, fn) => { const b = document.createElement("button"); b.textContent = t; b.style.cssText = `flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`; b.onclick = fn; return b; };
                btns.append(
                    mkBtn(clearButtonText, "background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;", () => { onConfirm(""); overlay.remove(); }),
                    mkBtn("取消", "", () => { onConfirm(null); overlay.remove(); }),
                    mkBtn("✓ 确认", "background:#2a9;color:#fff;border:none;font-weight:600;", () => { onConfirm(curPath); overlay.remove(); })
                );
                box.appendChild(btns);
                const _xBtn = document.createElement("button");
                _xBtn.textContent = "×";
                _xBtn.style.cssText = "position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";
                _xBtn.onmouseover = () => _xBtn.style.color = "#fff";
                _xBtn.onmouseout = () => _xBtn.style.color = "var(--input-text,#aaa)";
                _xBtn.onclick = () => { onConfirm(null); overlay.remove(); };
                box.appendChild(_xBtn);
                overlay.appendChild(box);
                overlay.onclick = e => { if (e.target === overlay) { onConfirm(null); overlay.remove(); } };
                document.body.appendChild(overlay);
            };

            const _pickManagedVideo = async ({ overlayId, title, hint, emptyHint, clearButtonText, currentPath = "", icon = "🎬", showManager = true }) => {
                let nextPath = currentPath || "";
                let picked = false;
                try {
                    const saved = await _sqrPickAndUploadVideo();
                    if (saved) { nextPath = saved; picked = true; }
                } catch (e) {
                    console.warn("[SQR] 浏览器视频选择失败:", e);
                }
                if (!showManager) {
                    return picked ? nextPath : null;
                }
                return await new Promise(resolve => {
                    _showSingleVideoManager({ overlayId, title, hint, emptyHint, clearButtonText, currentPath: nextPath, icon }, resolve);
                });
            };

            const showVideoManager = (onConfirm) => {
                _showSingleVideoManager({
                    overlayId: "sqr-vidmgr-overlay",
                    title: "🎬  已选续跑视频",
                    hint: "右键可移除已选视频（移除后恢复普通模式）",
                    emptyHint: "（未选择续跑视频，将以普通模式运行）",
                    clearButtonText: "⊗ 关闭续跑",
                    currentPath: getSqr("续跑视频路径") || "",
                    icon: "🎬",
                }, onConfirm);
            };

            const _applyVideo = (result, opts = {}) => {
                if (!result) return;
                _applyResumeState(result, { resumeMode: opts.resumeMode || _getResumeMode() || "" });
            };

            const _resumeNative = async (opts = {}) => {
                try {
                    const saved = await _sqrPickAndUploadVideo();
                    if (saved) _applyVideo(saved, { resumeMode: opts.resumeMode || _getResumeMode() || "" });
                } catch(e) { console.warn("[SQR] 续跑浏览器选择失败:", e); }
                showVideoManager(result => { if (result === null) return; if (result) _applyVideo(result, { resumeMode: opts.resumeMode || _getResumeMode() || "" }); else _clearVideo(); });
            };
            const _resumeSelectDirect = async (opts = {}) => {
                let mode = String(opts.resumeMode || "");
                if (!(mode === "manual_continuous" || mode === "manual_noncontinuous")) {
                    mode = await _showManualResumeTypeDialog();
                    if (mode === "cancel_resume") {
                        _clearVideo();
                        return;
                    }
                    if (!mode) return;
                }
                _resumeNative({ ...opts, resumeMode: mode });
            };

            const resumeBtn = node.addWidget("button", "🎬  选择续跑视频", null, async () => {
                if (_sqrIsRemote()) { _resumeSelectDirect(); return; }
                const uid = String(node.id);
                let ckpt = null;
                try {
                    const _rvp = _getRefVideoParams();
                    const refParams = _rvp ? encodeURIComponent(JSON.stringify(_rvp)) : "";
                    const resp = await fetch(`/sqr/checkpoint?uid=${uid}&ref_params=${refParams}`);
                    const data = await resp.json();
                    const c = data.checkpoint;
                    if (c?.transition_exists && c.next_seg <= c.total_segs) ckpt = c;
                } catch(e) {}
                if (!ckpt) { _resumeSelectDirect(); return; }
                _showResumeDialog(ckpt, null);
            });
            resumeBtn.serialize = false;
            resumeBtn.draw = function(ctx, node, widget_width, y, H) {
                const active = !!this._sqrActive;
                const checkpointPrompt = !!this._sqrCheckpointPrompt;
                ctx.fillStyle = checkpointPrompt ? "rgba(255,160,0,0.28)" : (active ? "rgba(40,160,100,0.35)" : "rgba(255,255,255,0.05)");
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(4, y+2, widget_width-8, H-4, 4) : ctx.rect(4, y+2, widget_width-8, H-4);
                ctx.fill();
                if (checkpointPrompt || active) {
                    ctx.strokeStyle = checkpointPrompt ? "rgba(255,160,0,0.8)" : "rgba(60,200,130,0.7)";
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
                ctx.fillStyle = checkpointPrompt ? "#ffcc00" : (active ? "#7fffb0" : "rgba(190,190,190,0.5)");
                ctx.font = "12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(this.name, widget_width/2, y + H/2);
                ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
            };

            const _clearVideo = (opts = {}) => {
                const silent = !!opts.silent;
                node._sqrCheckpointBanner = false;
                node._sqrCheckpointData = null;
                resumeBtn._sqrCheckpointPrompt = false;
                _applyResumeState("", {
                    resumeMode: "",
                    keepFrameOffset: !!opts.keepFrameOffset,
                    keepStartSegment: !!opts.keepStartSegment,
                    keepManualSplits: !!opts.keepManualSplits,
                    clearedLabel: silent ? "🎬  选择续跑视频" : "🎬  已清除，从第1段开始",
                });
                if (!silent) {
                    setTimeout(() => {
                        if (!(getSqr("续跑视频路径") || "").trim()) {
                            resumeBtn.name = "🎬  选择续跑视频";
                            node.setDirtyCanvas?.(true, true);
                        }
                    }, 3000);
                }
            };
            node._sqrClearVideo = _clearVideo;

            { const w = getW("sqr_save_png"); if (w) w.value = String(node._sqrSettings.savePng ?? true); }
            { const w = getW("sqr_min_seg_frames"); if (w) w.value = String(node._sqrSettings.fixedFrameMin ?? 61); }
            for (const _hk of ["sqr_frame_offset", "sqr_pre_segments", "sqr_segment_mode", "sqr_trim_merge_mode", "sqr_manual_splits", "sqr_execution_scope", "sqr_resume_kind", "sqr_real_total_frames", "sqr_real_fps", "sqr_min_seg_frames"]) {
                const _hw = getW(_hk);
                if (_hw) {
                    _hw.computeSize = () => [0, -4];
                    _hw.draw = () => {};
                    _hw.type = "hidden";
                }
            }
            { const w = getW("sqr_frame_offset"); if (w) w.value = -1; }
            { const w = getW("sqr_segment_mode"); if (w) w.value = node._sqrSettings?.segmentMode || "average"; }
            { const w = getW("sqr_trim_merge_mode"); if (w) w.value = SQR_TRIM_SPLIT; }
            { const w = getW("sqr_manual_splits"); if (w) w.value = ""; }
            { const w = getW("sqr_resume_kind"); if (w) w.value = ""; }
            { const w = getW("sqr_execution_scope"); if (w) w.value = node._sqrSettings?.executionScope || "start_to_end"; }
            { const w = getW("sqr_real_total_frames"); if (w) w.value = String(w.value || "-1"); }
            { const w = getW("sqr_real_fps"); if (w) w.value = String(w.value || "-1.0"); }

            // ── 已选图片管理弹窗 ──
            const showRefManagerWithPaths = (initialPaths, onConfirm, opts={}) => {
                document.getElementById("sqr-mgr-overlay")?.remove();
                const paths = Array.isArray(initialPaths) ? initialPaths.map(s=>String(s||"").trim()).filter(Boolean) : [];
                let dragIdx = null;
                const title = opts.title || "🖼  管理已选参考图（左键复制 · 拖动排序 · 右键移除）";
                const emptyText = opts.emptyText || "（尚未选择参考图）";
                const confirmText = opts.confirmText || "✓ 确认";
                const addBtnText = opts.addBtnText || "＋ 追加选择";
                const onAdd = typeof opts.onAdd === "function" ? opts.onAdd : async () => {
                    try { return await _sqrPickAndUploadImages(); } catch(e) { console.warn("[SQR] 参考图追加失败:", e); return []; }
                };
                const dedupeOnAdd = opts.dedupeOnAdd !== false;
                const overlay = document.createElement("div");overlay.id = "sqr-mgr-overlay";Object.assign(overlay.style,{position:"fixed",inset:"0",zIndex:"10001",background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"});
                const box = document.createElement("div");Object.assign(box.style,{background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",border:"1px solid var(--border-color,#444)",borderRadius:"12px",padding:"18px 22px",width:"680px",maxHeight:"88vh",display:"flex",flexDirection:"column",gap:"10px",boxShadow:"0 8px 40px rgba(0,0,0,.7)"});
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
                box.appendChild(mkDiv(title,"font-size:14px;font-weight:600;"));
                const statsLine = mkDiv("","font-size:11px;opacity:.58;");
                box.appendChild(statsLine);
                const grid = document.createElement("div");Object.assign(grid.style,{display:"flex",flexWrap:"wrap",gap:"8px",minHeight:"80px",maxHeight:"420px",overflowY:"auto",padding:"10px",border:"1px solid var(--border-color,#444)",borderRadius:"8px"});
                function renderGrid() {
                    statsLine.textContent = paths.length ? `当前共 ${paths.length} 张，可继续追加、拖动排序、左键复制、右键移除。` : "当前未选择图片，可先追加，再统一确认。";
                    grid.innerHTML = "";
                    if (!paths.length) { grid.appendChild(mkDiv(emptyText,"opacity:.4;font-size:13px;padding:8px;")); return; }
                    grid.appendChild(mkDiv("左键单击复制  ·  拖动调整顺序  ·  右键移除  ·  可继续追加","font-size:11px;opacity:.5;width:100%;padding:2px 4px;"));
                    paths.forEach((p, idx) => {
                        const fname = p.split(/[\/]/).pop();
                        const cell = document.createElement("div");Object.assign(cell.style,{width:"100px",textAlign:"center",position:"relative",border:"2px solid var(--border-color,#555)",borderRadius:"7px",padding:"4px",cursor:"grab",userSelect:"none"});cell.draggable = true;
                        const badge = mkDiv(String(idx+1),"position:absolute;top:2px;left:2px;background:#3a9;color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:bold;line-height:16px;z-index:1;");
                        const img = new Image();img.src = sqrThumbUrl(p);Object.assign(img.style,{width:"92px",height:"92px",objectFit:"contain",display:"block",borderRadius:"4px",pointerEvents:"none"});
                        const lbl = mkDiv(fname.length>14?fname.slice(0,13)+"…":fname,"font-size:9px;margin-top:3px;word-break:break-all;opacity:.7;");lbl.title = p;
                        cell.ondragstart=e=>{e.stopPropagation();dragIdx=idx;cell._sqrDragged=false;setTimeout(()=>cell.style.opacity=".35",0);};cell.ondragend=e=>{e.stopPropagation();cell.style.opacity="1";setTimeout(()=>{cell._sqrDragged=false;},0);};
                        cell.ondragover=e=>{e.preventDefault();e.stopPropagation();cell.style.borderColor="#4a9";};cell.ondragleave=()=>{cell.style.borderColor="var(--border-color,#555)";};
                        cell.ondrop=e=>{e.preventDefault();e.stopPropagation();cell.style.borderColor="var(--border-color,#555)";cell._sqrDragged=true;if(dragIdx!==null&&dragIdx!==idx){const[m]=paths.splice(dragIdx,1);paths.splice(idx,0,m);renderGrid();}};
                        cell.onclick=e=>{e.stopPropagation();if(cell._sqrDragged){cell._sqrDragged=false;return;} paths.splice(idx+1,0,p);renderGrid();};
                        cell.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();paths.splice(idx,1);renderGrid();};
                        cell.append(badge,img,lbl);grid.appendChild(cell);
                    });
                }
                renderGrid(); box.appendChild(grid);
                const btns = document.createElement("div"); btns.style.cssText="display:flex;gap:8px;";
                const mkBtn=(t,s,fn)=>{const b=document.createElement("button");b.textContent=t;b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;b.onclick=fn;return b;};
                btns.append(
                    mkBtn(addBtnText,"background:rgba(80,120,220,0.16);border:1px solid rgba(100,140,230,0.35);color:#bcd6ff;", async()=>{
                        const saved = await onAdd(paths.slice());
                        if (!Array.isArray(saved) || !saved.length) return;
                        saved.forEach(name => {
                            const val = String(name || "").trim();
                            if (!val) return;
                            if (dedupeOnAdd && paths.includes(val)) return;
                            paths.push(val);
                        });
                        renderGrid();
                    }),
                    mkBtn("取消","",()=>overlay.remove()),
                    mkBtn(confirmText,"background:#2a9;color:#fff;border:none;font-weight:600;",()=>{onConfirm(paths.slice());overlay.remove();})
                );
                box.appendChild(btns);
                const _xBtn=document.createElement("button");_xBtn.textContent="×";_xBtn.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";_xBtn.onmouseover=()=>_xBtn.style.color="#fff";_xBtn.onmouseout=()=>_xBtn.style.color="var(--input-text,#aaa)";_xBtn.onclick=()=>overlay.remove();box.style.position="relative";box.appendChild(_xBtn);overlay.appendChild(box);overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};document.body.appendChild(overlay);
            };

            const showRefManager = (onConfirm) => {
                const paths = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean);
                showRefManagerWithPaths(paths, onConfirm, {
                    title: "🖼  管理已选参考图（左键复制 · 拖动排序 · 右键移除）",
                    emptyText: "（尚未选择参考图）",
                    confirmText: "✓ 确认",
                    addBtnText: "＋ 追加选择",
                });
            };

            const _refNative = async () => {
                try {
                    const saved = await _sqrPickAndUploadImages();
                    if (saved.length) { const cur = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean); saved.forEach(name => { if (!cur.includes(name)) cur.push(name); }); setSqr("分段参考图", cur.join(",")); refThumbWidget.syncPaths(); }
                } catch(e) { console.warn("[SQR] 参考图浏览器选择失败:", e); }
                showRefManager(result => { setSqr("分段参考图", result.join(",")); refThumbWidget.syncPaths(); node.setDirtyCanvas?.(true, true); });
            };
            const refBtn = node.addWidget("button", "🖼️  选择参考图", null, () => {
                _refNative();
            });
            refBtn.serialize = false;

            // ── 缩略图预览行 ──
            const refThumbWidget = {
                name: "_sqr_ref_thumbs", type: "sqr_thumbs", serialize: false,
                _paths: [], _loaded: {}, _dragSrc: -1, _dragOver: -1,
                syncPaths() {
                    this._paths = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean);
                    const nextLoaded = {};
                    this._paths.forEach(p => { const img = new Image(); img.src = sqrThumbUrl(p); img.onload = () => node.setDirtyCanvas?.(true, true); nextLoaded[p] = img; });
                    this._loaded = nextLoaded;
                },
                computeSize(width) { if (!this._paths.length) return [width, 0]; return [width, this._minH()]; },
                _minH() { return 20 + 16; },
                _getHeaderH(node) { let h = LiteGraph.NODE_TITLE_HEIGHT ?? 26; for (const w of (node.widgets || [])) { if (w === this) break; const sz = w.computeSize ? w.computeSize(node.size[0]) : [0, LiteGraph.NODE_WIDGET_HEIGHT ?? 20]; h += (sz[1] ?? 20) + 4; } return h; },
                _getAvailH(node, width) { const headerH = this._getHeaderH(node); const totalH = node.size[1] || 300; return Math.max(this._minH(), totalH - headerH - 8); },
                _calcLayout(width, availH) { const n = this._paths.length; if (!n) return { rows: 0, cols: 0, slot: 48, n }; const gap = 6, pad = 8; const MIN_SLOT = 20, MAX_SLOT = 800; const aW = width - pad * 2; const aH = availH - 16; let bestSlot = MIN_SLOT, bestRows = 1, bestCols = n; for (let r = 1; r <= n; r++) { const c = Math.ceil(n / r); const slotByW = Math.floor((aW - gap*(c-1)) / c); const slotByH = Math.floor((aH - gap*(r-1)) / r); const slot = Math.min(slotByW, slotByH, MAX_SLOT); if (slot >= MIN_SLOT && slot > bestSlot) { bestSlot = slot; bestRows = r; bestCols = c; } } return { rows: bestRows, cols: bestCols, slot: bestSlot, n }; },
                _layout(width) { const availH = this._getAvailH(node, width); const { rows, cols, slot, n } = this._calcLayout(width, availH); const gap = 6, pad = 8, padV = 8; const totalW = cols * slot + (cols-1) * gap; const ox = pad + Math.max(0, (width - pad*2 - totalW) / 2); return this._paths.map((p, i) => { const col = i % cols, row = Math.floor(i / cols); const x = ox + col * (slot + gap); const y = padV + row * (slot + gap); return { p, x, y: y, w: slot, h: slot }; }); },
                draw(ctx, node, width, y) {
                    if (!this._paths.length) return;
                    const curH = node.size[1]; if (this._lastWidth !== width || this._lastHeight !== curH) { this._lastWidth = width; this._lastHeight = curH; }
                    const layout = this._layout(width);
                    layout.forEach(({p, x, y: ly, w, h}, i) => {
                        const ty = y + ly; const img = this._loaded[p];
                        if (this._dragOver === i && this._dragSrc !== i) { ctx.strokeStyle = "#4c6"; ctx.lineWidth = 2; ctx.strokeRect(x-2, ty-2, w+4, h+4); }
                        if (img?.complete && img.naturalWidth) { const iw = img.naturalWidth, ih = img.naturalHeight; const scale = Math.min(w/iw, h/ih); const dw = iw*scale, dh = ih*scale; ctx.save(); if (this._dragSrc === i) ctx.globalAlpha = 0.35; ctx.drawImage(img, x+(w-dw)/2, ty+(h-dh)/2, dw, dh); ctx.restore(); } else { ctx.fillStyle = "#2a2a2a"; ctx.fillRect(x, ty, w, h); ctx.fillStyle = "#666"; ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.fillText("…", x+w/2, ty+h/2+4); }
                        ctx.fillStyle = "rgba(50,150,70,0.92)"; ctx.fillRect(x, ty, 15, 15); ctx.fillStyle = "#fff"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(i+1), x+7.5, ty+11);
                    });
                    ctx.textAlign = "left";
                },
                _idxAt(lx, ly, width) { return this._layout(width).findIndex(({x, y: iy, w, h}) => lx >= x && lx <= x+w && ly >= iy && ly <= iy+h); },
                mouse(evt, pos, node) {
                    if (!this._paths.length) return false;
                    const lx = pos[0], ly = pos[1], w = node.size[0];
                    if (evt.type === "mousedown" && evt.button === 0) { const i = this._idxAt(lx, ly, w); if (i >= 0) { this._dragSrc = i; this._dragOver = i; return true; } }
                    if (evt.type === "mousemove" && this._dragSrc >= 0) { const i = this._idxAt(lx, ly, w); if (i >= 0) this._dragOver = i; node.setDirtyCanvas?.(true, true); return true; }
                    if (evt.type === "mouseup" && this._dragSrc >= 0) { const src = this._dragSrc, over = this._dragOver; this._dragSrc = -1; this._dragOver = -1; if (src !== over && over >= 0) { const arr = [...this._paths]; const [m] = arr.splice(src, 1); arr.splice(over, 0, m); setSqr("分段参考图", arr.join(",")); this.syncPaths(); } node.setDirtyCanvas?.(true, true); return true; }
                    return false;
                }
            };
            node.addCustomWidget(refThumbWidget);

            setTimeout(() => {
                refThumbWidget.syncPaths();
                const p = String(getSqr("续跑视频路径") || "").trim();
                if (p) _applyResumeState(p, { resumeMode: _getResumeMode() || "", autoSegmentHint: false });
                else _renderResumeButton("", { clearedLabel: "🎬  选择续跑视频" });
                node.setDirtyCanvas?.(true, true);
            }, 100);

            function _getRefVideoParams() {
                try {
                    const vidNodeId = getSqr("参考视频节点ID"); if (!vidNodeId) return null;
                    const vidNode = app.graph?.getNodeById?.(parseInt(vidNodeId)); if (!vidNode) return null;
                    const getW2 = name => vidNode.widgets?.find(w => w.name === name);
                    const videoW = getW2("video") || vidNode.widgets?.[0];
                    return { video: videoW?.value ? String(videoW.value).split(/[\\/]/).pop() : "", force_rate: getW2("force_rate")?.value ?? 0, custom_width: getW2("custom_width")?.value ?? 0, custom_height: getW2("custom_height")?.value ?? 0, frame_load_cap: getW2("frame_load_cap")?.value ?? 0, skip_first_frames: Math.max(0, parseInt(getW2("skip_first_frames")?.value) || 0), select_every_nth: 1, format: getW2("format")?.value ?? "AnimateDiff" };
                } catch(e) { return null; }
            }
            function _getRefVideoName() { return _getRefVideoParams()?.video || ""; }
            function _syncLoadVideoPreview(vn, params) {
                try {
                    if (!vn || !params) return;
                    const safeParams = {
                        filename: params.video || "",
                        type: "input",
                        format: "video/mp4",
                        force_rate: params.force_rate ?? 0,
                        custom_width: params.custom_width ?? 0,
                        custom_height: params.custom_height ?? 0,
                        frame_load_cap: params.frame_load_cap ?? 0,
                        skip_first_frames: params.skip_first_frames ?? 0,
                        select_every_nth: 1,
                    };
                    if (typeof vn.widgets_values === "object" && vn.widgets_values) {
                        vn.widgets_values.video = params.video || "";
                        vn.widgets_values.force_rate = params.force_rate ?? 0;
                        vn.widgets_values.custom_width = params.custom_width ?? 0;
                        vn.widgets_values.custom_height = params.custom_height ?? 0;
                        vn.widgets_values.frame_load_cap = params.frame_load_cap ?? 0;
                        vn.widgets_values.skip_first_frames = params.skip_first_frames ?? 0;
                        vn.widgets_values.select_every_nth = 1;
                        vn.widgets_values.format = params.format ?? "AnimateDiff";
                        const vp = (typeof vn.widgets_values.videopreview === "object" && vn.widgets_values.videopreview) ? vn.widgets_values.videopreview : {};
                        vp.hidden = false;
                        vp.paused = false;
                        vp.params = Object.assign({}, vp.params || {}, safeParams);
                        vn.widgets_values.videopreview = vp;
                    }
                    const previewWidget = vn.widgets?.find?.(w => w?.name === "videopreview");
                    if (previewWidget) {
                        const pv = (typeof previewWidget.value === "object" && previewWidget.value) ? previewWidget.value : {};
                        previewWidget.value = Object.assign({}, pv, {
                            hidden: false,
                            paused: false,
                            params: Object.assign({}, pv.params || {}, safeParams),
                        });
                    }
                    vn.setDirtyCanvas?.(true, true);
                    app.graph?.setDirtyCanvas?.(true, true);
                    app.canvas?.setDirty?.(true, true);
                } catch(e) {}
            }

            if (!_sqrIsRemote()) {
                setTimeout(async () => {
                    const uid = String(node.id); if (!uid || uid === "undefined") return;
                    try {
                        const _rvp = _getRefVideoParams(); const refParams = _rvp ? encodeURIComponent(JSON.stringify(_rvp)) : "";
                        const resp = await fetch(`/sqr/checkpoint?uid=${uid}&ref_params=${refParams}`);
                        const data = await resp.json(); const ckpt = data.checkpoint;
                        if (!ckpt) return; if (!ckpt.transition_exists) return; if (ckpt.next_seg > ckpt.total_segs) return;
                        _showCheckpointBanner(ckpt);
                    } catch(e) {}
                }, 300);
            }

            function _showCheckpointBanner(ckpt) {
                if (!ckpt) return;
                node._sqrCheckpointBanner = true;
                node._sqrCheckpointData = ckpt;
                resumeBtn._sqrCheckpointPrompt = true;
                resumeBtn._sqrActive = false;
                resumeBtn.name = `⚠  上次第${ckpt.completed_seg}/${ckpt.total_segs}段中断 → 点击选择续跑方式`;
                node.setDirtyCanvas?.(true, true);
            }


            function _showResumeDialog(ckpt, bannerWidget) {
                document.getElementById("sqr-ckpt-overlay")?.remove();
                const currentRefParams = (() => {
                    try {
                        const _rvp = _getRefVideoParams();
                        return _rvp ? encodeURIComponent(JSON.stringify(_rvp)) : "";
                    } catch (e) {
                        return "";
                    }
                })();

                const getCheckpointState = (activeCkpt) => {
                    const curSeg = Number(getW("分段数")?.value ?? activeCkpt.segments);
                    const segChanged = curSeg !== Number(activeCkpt.segments);
                    const lvBad = activeCkpt.ref_video_match === false;
                    const ckptParams = activeCkpt.ref_video_params || {};
                    const resumeRefs = Array.isArray(activeCkpt.resume_ref_assets) && activeCkpt.resume_ref_assets.length
                        ? activeCkpt.resume_ref_assets
                        : (Array.isArray(activeCkpt.ref_images) ? activeCkpt.ref_images : []);
                    const resumeRefTotal = Number(activeCkpt.resume_ref_total || resumeRefs.length || 0);
                    const resumeRefExisting = Number(activeCkpt.resume_ref_existing ?? resumeRefs.length ?? 0);
                    const resumeRefMissing = Number(activeCkpt.resume_ref_missing ?? Math.max(0, resumeRefTotal - resumeRefExisting));
                    const mNames = { video:"参考视频文件", force_rate:"强制帧率", custom_width:"自定义宽度", custom_height:"自定义高度", frame_load_cap:"帧数读取上限", skip_first_frames:"跳过前X帧", select_every_nth:"间隔", format:"格式" };
                    const lvStr = (activeCkpt.ref_video_mismatches || []).map(k => mNames[k] || k).join("、");
                    const poseEnabled = !!(activeCkpt.local_pose_video_path && String(activeCkpt.local_pose_video_path).trim());
                    const faceEnabled = !!(activeCkpt.local_face_video_path && String(activeCkpt.local_face_video_path).trim());
                    return { curSeg, segChanged, lvBad, ckptParams, resumeRefs, resumeRefTotal, resumeRefExisting, resumeRefMissing, lvStr, poseEnabled, faceEnabled };
                };

                const state0 = getCheckpointState(ckpt);
                const overlay = document.createElement("div");
                overlay.id = "sqr-ckpt-overlay";
                Object.assign(overlay.style, { position:"fixed", inset:"0", zIndex:"10000", background:"rgba(0,0,0,.75)", display:"flex", alignItems:"center", justifyContent:"center" });
                const box = document.createElement("div");
                Object.assign(box.style, { background:"var(--comfy-menu-bg,#1e1e1e)", color:"var(--input-text,#eee)", border:"2px solid rgba(255,160,0,0.6)", borderRadius:"12px", padding:"20px 24px", width:"720px", maxWidth:"calc(100vw - 40px)", maxHeight:"90vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:"10px", boxShadow:"0 8px 40px rgba(0,0,0,.7)", position:"relative" });
                // 修复：flex column 布局下子元素默认会被压缩。当旧任务 checkpoint 较多时，
                // 上方的 4 张模式卡片会被挤成细线而不触发滚动条。这里给 box 设个 id，
                // 并注入一条作用域 CSS，强制所有直接子元素 flex-shrink:0，让 box 正常滚动。
                box.id = "sqr-ckpt-dialog-box";
                if (!document.getElementById("sqr-ckpt-dialog-style")) {
                    const _noShrinkStyle = document.createElement("style");
                    _noShrinkStyle.id = "sqr-ckpt-dialog-style";
                    _noShrinkStyle.textContent = "#sqr-ckpt-dialog-box > * { flex-shrink: 0 !important; }";
                    document.head.appendChild(_noShrinkStyle);
                }
                const mkDiv = (t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});

                box.appendChild(mkDiv("⚠  检测到上次中断 — 选择续跑方式","font-size:15px;font-weight:700;color:#ffcc00;"));
                const infoDiv = document.createElement("div");
                infoDiv.style.cssText = "font-size:12px;background:rgba(255,255,255,0.05);padding:8px 10px;border-radius:6px;line-height:1.9;";
                const _modeLabels = {"average":"平均分段","fixed":"固定帧数","manual":"手动分段"};
                const _ckptModeLabel = _modeLabels[ckpt.segment_mode] || "平均分段";
                const poseState = state0.poseEnabled ? `<span style="color:${ckpt.local_pose_video_exists === false ? '#f9a84a' : '#7fffb0'}">已启用${ckpt.local_pose_video_exists === false ? '（文件待确认）' : ''}</span>` : '<span style="opacity:.7;">未启用</span>';
                const faceState = state0.faceEnabled ? `<span style="color:${ckpt.local_face_video_exists === false ? '#f9a84a' : '#7fffb0'}">已启用${ckpt.local_face_video_exists === false ? '（文件待确认）' : ''}</span>` : '<span style="opacity:.7;">未启用</span>';
                infoDiv.innerHTML = `上次完成：第 ${ckpt.completed_seg} / ${ckpt.total_segs} 段 &nbsp;·&nbsp; 模式：<span style="color:#6df">${_ckptModeLabel}</span> &nbsp;·&nbsp; 续跑视频：<span style="color:#6df">${ckpt.transition_video}</span> &nbsp;·&nbsp; 时间：${ckpt.timestamp}<br>续跑参考图资产：<span style="color:${state0.resumeRefMissing ? '#f9a84a' : '#7fffb0'}">已找到 ${state0.resumeRefExisting} / ${state0.resumeRefTotal} 张</span>${ckpt.resume_ref_asset_dir_exists ? ' &nbsp;·&nbsp; 资产包可用' : ''}<br>本地姿态参考：${poseState} &nbsp;·&nbsp; 本地人脸参考：${faceState}`;
                box.appendChild(infoDiv);

                const warns = [];
                if (state0.segChanged) warns.push(`分段数已从 ${ckpt.segments} 改为 ${state0.curSeg}（自动续跑将恢复为 ${ckpt.segments} 段）`);
                if (state0.lvBad) warns.push(`Load Video 参数已修改（${state0.lvStr}）（自动续跑将恢复原参数）`);
                if (state0.resumeRefMissing > 0) warns.push(`续跑参考图资产缺失 ${state0.resumeRefMissing} 张（将优先恢复仍存在的参考图）`);
                if (state0.poseEnabled && ckpt.local_pose_video_exists === false) warns.push(`上次使用了本地姿态参考，但当前文件未验证存在，续跑前请确认路径。`);
                if (state0.faceEnabled && ckpt.local_face_video_exists === false) warns.push(`上次使用了本地人脸参考，但当前文件未验证存在，续跑前请确认路径。`);
                if (warns.length) {
                    const w = document.createElement("div");
                    w.style.cssText = "font-size:12px;color:#ffaa44;padding:6px 10px;border:1px solid rgba(255,160,0,0.35);border-radius:6px;display:flex;flex-direction:column;gap:3px;";
                    warns.forEach(t => w.appendChild(mkDiv(`⚠ ${t}`)));
                    box.appendChild(w);
                }

                let oldResumeEnabled = false;
                let oldResumeSelectedPath = "";
                let oldResumeSelectedKey = "";
                let oldResumeSelectedSummary = null;
                let oldResumeItems = [];
                let oldResumeLoaded = false;
                let oldResumeLoading = false;

                const activeHint = mkDiv("当前生效来源：最近一次中断任务", "font-size:11px;color:#7fffb0;line-height:1.6;");
                box.appendChild(activeHint);

                const fetchCheckpointBySelection = async (targetPath, targetUid) => {
                    if (!targetPath && !targetUid) return null;
                    try {
                        const qs = [];
                        if (targetUid) qs.push(`uid=${encodeURIComponent(targetUid)}`);
                        if (targetPath) qs.push(`path=${encodeURIComponent(targetPath)}`);
                        qs.push(`ref_params=${currentRefParams}`);
                        const resp = await fetch(`/sqr/checkpoint?${qs.join("&")}`);
                        const data = await resp.json();
                        return data.checkpoint || null;
                    } catch (e) {
                        console.warn("[SQR] 旧 checkpoint 读取失败:", e);
                        return null;
                    }
                };

                const updateActiveHint = () => {
                    if (oldResumeEnabled && oldResumeSelectedSummary) {
                        const txt = oldResumeSelectedSummary.timestamp || oldResumeSelectedSummary.ref_video_label || oldResumeSelectedSummary.unique_id || "";
                        activeHint.textContent = `当前生效来源：旧任务续跑 · ${txt || "已选择旧任务"}`;
                        activeHint.style.color = "#ffd98a";
                    } else if (oldResumeEnabled) {
                        activeHint.textContent = "当前生效来源：仍为最近一次中断任务（开启旧任务续跑后，还需左键点选一张缩略图）";
                        activeHint.style.color = "#f9a84a";
                    } else {
                        activeHint.textContent = "当前生效来源：最近一次中断任务";
                        activeHint.style.color = "#7fffb0";
                    }
                };

                const resolveDialogCheckpoint = async () => {
                    if (oldResumeEnabled && oldResumeSelectedPath) {
                        const picked = await fetchCheckpointBySelection(oldResumeSelectedPath, oldResumeSelectedSummary?.unique_id || "");
                        if (picked?.transition_exists) return picked;
                        alert("所选旧任务 checkpoint 已不可用，已回退到最近一次中断任务。");
                    }
                    return ckpt;
                };

                const restoreLoadVideoParams = (ckptParams) => {
                    if (!ckptParams || !ckptParams.video) return;
                    try {
                        const vn = app.graph?.getNodeById?.(parseInt(getSqr("参考视频节点ID")));
                        if (!vn) return;
                        const sv = (n, v) => { const w = vn.widgets?.find(w => w.name === n); if (w) w.value = v; };
                        sv("video", ckptParams.video);
                        sv("force_rate", ckptParams.force_rate);
                        sv("custom_width", ckptParams.custom_width);
                        sv("custom_height", ckptParams.custom_height);
                        sv("frame_load_cap", ckptParams.frame_load_cap);
                        sv("skip_first_frames", ckptParams.skip_first_frames);
                        sv("select_every_nth", 1);
                        sv("format", ckptParams.format);
                        _syncLoadVideoPreview(vn, ckptParams);
                        vn.setDirtyCanvas?.(true, true);
                    } catch (e) {}
                };

                const applyCheckpointToNode = (activeCkpt, mode, opts = {}) => {
                    const state = getCheckpointState(activeCkpt);
                    const ckptParams = state.ckptParams;
                    const resumeRefs = state.resumeRefs;
                    const foW = getW("sqr_frame_offset");
                    const fromW = getW("从第几段开始");
                    const segWw = getW("分段数");

                    let fo = -1;
                    if (mode === "auto") fo = typeof activeCkpt.base_frame_offset === "number" && activeCkpt.base_frame_offset > 0 ? activeCkpt.base_frame_offset : -1;
                    else if (mode === "redesign" || mode === "manual_continuous" || mode === "manual_noncontinuous") fo = typeof activeCkpt.frame_offset_for_resume === "number" && activeCkpt.frame_offset_for_resume > 0 ? activeCkpt.frame_offset_for_resume : -1;
                    if (foW) foW.value = fo;

                    const resumeMode = mode === "auto" ? "checkpoint_auto" : mode === "redesign" ? "checkpoint_redesign" : mode;
                    _applyResumeState(activeCkpt.transition_video, { resumeMode, autoSegmentHint: false });
                    setSqr("姿态模型节点ID", activeCkpt.pose_model_node_id || "");
                    setSqr("脸部模型节点ID", activeCkpt.face_model_node_id || "");
                    setSqr("本地姿态视频路径", activeCkpt.local_pose_video_path || "");
                    setSqr("本地人脸视频路径", activeCkpt.local_face_video_path || "");

                    if (mode === "auto") {
                        const ckptMode = activeCkpt.segment_mode || "average";
                        if (node._sqrSettings) node._sqrSettings.segmentMode = ckptMode;
                        const smW = getW("sqr_segment_mode"); if (smW) smW.value = ckptMode;
                        try { localStorage.setItem("sqr_segment_mode", ckptMode); } catch(e) {}
                        if (node._sqrSettings) node._sqrSettings.trimMergeMode = SQR_TRIM_SPLIT;
                        const tmmW = getW("sqr_trim_merge_mode"); if (tmmW) tmmW.value = SQR_TRIM_SPLIT;
                        try { localStorage.removeItem("sqr_trim_merge_mode"); } catch(e) {}
                        if (segWw) segWw.value = activeCkpt.segments_param || activeCkpt.segments;
                        const msW = getW("sqr_manual_splits");
                        if (ckptMode === "manual" && activeCkpt.manual_splits) { if (msW) msW.value = activeCkpt.manual_splits; }
                        else if (msW) msW.value = "";
                        const totalSegsActual = activeCkpt.segment_count || activeCkpt.total_segs;
                        if (fromW) fromW.value = Math.min(activeCkpt.next_seg, totalSegsActual);
                        restoreLoadVideoParams(ckptParams);
                        if (resumeRefs?.length) {
                            const si = Math.min(activeCkpt.next_seg - 1, resumeRefs.length - 1);
                            const sl = resumeRefs.slice(si).filter(Boolean);
                            if (sl.length) setSqr("分段参考图", sl.join(","));
                        }
                        if (typeof node._sqrApplySegmentMode === "function") node._sqrApplySegmentMode();
                    } else if (mode === "redesign") {
                        if (fromW) fromW.value = 1;
                        if (opts.newSegCount && segWw) segWw.value = opts.newSegCount;
                        if (opts.newRefs?.length) setSqr("分段参考图", opts.newRefs.join(","));
                        const msW = getW("sqr_manual_splits"); if (msW) msW.value = "";
                        restoreLoadVideoParams(ckptParams);
                    } else {
                        if (resumeRefs?.length) {
                            const si = Math.min(Math.max(0, (activeCkpt.next_seg || 1) - 1), resumeRefs.length - 1);
                            const sl = resumeRefs.slice(si).filter(Boolean);
                            if (sl.length) setSqr("分段参考图", sl.join(","));
                        }
                        restoreLoadVideoParams(ckptParams);
                    }

                    if (segWw && startW && !segWw._sqrFixedMode) {
                        startW.options.max = Math.round(segWw.value);
                        if (startW.value > startW.options.max) startW.value = startW.options.max;
                    }
                    const tw = node.widgets?.find(w=>w.name==="_sqr_ref_thumbs");
                    if (tw) tw.syncPaths?.();
                    node._sqrCheckpointBanner = false;
                    node._sqrCheckpointData = null;
                    resumeBtn._sqrCheckpointPrompt = false;
                    overlay.remove();
                    node.setDirtyCanvas?.(true, true);
                };

                const applyAndClose = async (mode, opts = {}) => {
                    const activeCkpt = await resolveDialogCheckpoint();
                    if (!activeCkpt) {
                        alert("未能读取所选 checkpoint。");
                        return;
                    }
                    applyCheckpointToNode(activeCkpt, mode, opts);
                };

                const mkCard = (emoji, title, hint, borderClr, clickFn, bodyEl) => {
                    const card = document.createElement("div"); card.style.cssText = `border:1.5px solid ${borderClr};border-radius:8px;overflow:hidden;`;
                    const hdr = document.createElement("div"); hdr.style.cssText = "padding:10px 14px;cursor:pointer;display:flex;align-items:baseline;gap:8px;";
                    hdr.onmouseover = ()=>hdr.style.background="rgba(255,255,255,0.05)"; hdr.onmouseout = ()=>hdr.style.background="";
                    hdr.appendChild(mkDiv(`${emoji}  ${title}`,`font-size:13px;font-weight:600;color:${borderClr};`));
                    hdr.appendChild(mkDiv(hint,"font-size:11px;opacity:.6;flex:1;"));
                    hdr.onclick = ()=>{ if (clickFn) void clickFn(); }; card.appendChild(hdr);
                    if (bodyEl) { bodyEl.style.display="none"; card.appendChild(bodyEl); hdr.onclick = ()=>{ bodyEl.style.display = bodyEl.style.display==="none" ? "block" : "none"; if (clickFn) void clickFn(); }; }
                    return card;
                };

                const abandonResume = async () => {
                    _clearVideo();
                    const ckptPath = String(ckpt?.checkpoint_path || "").trim();
                    if (ckptPath) {
                        try {
                            await fetch("/sqr/checkpoints/delete", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ paths: [ckptPath] }),
                            });
                        } catch (e) {
                            console.warn("[SQR] 关闭续跑时删除 checkpoint 失败:", e);
                        }
                    }
                    try {
                        await fetch(`/sqr/progress/clear?uid=${encodeURIComponent(String(node.id || ""))}`, { method: "POST" });
                    } catch (e) {}
                    node._sqrCheckpointBanner = false;
                    node._sqrCheckpointData = null;
                    resumeBtn._sqrCheckpointPrompt = false;
                    resumeBtn.name = "🎬  选择续跑视频";
                    overlay.remove();
                    node.setDirtyCanvas?.(true, true);
                };
                box.appendChild(mkCard("⊗","关闭续跑","放弃续跑，不衔接，全新生成一份","rgba(200,80,80,0.7)", abandonResume));
                const autoHints = [];
                if (state0.segChanged) autoHints.push(`恢复分段数为 ${ckpt.segments} 段`);
                if (state0.lvBad) autoHints.push("恢复 Load Video 参数");
                if (state0.resumeRefTotal) autoHints.push(`恢复续跑参考图 ${state0.resumeRefExisting}/${state0.resumeRefTotal} 张`);
                if (state0.poseEnabled || state0.faceEnabled) autoHints.push("恢复本地姿态/人脸参考设置");
                const autoHint = autoHints.length ? `推荐 · 将自动${autoHints.join("、")}` : "推荐 · 一键套用，参考图可随时自行修改";
                box.appendChild(mkCard("✅","自动续跑",autoHint,"rgba(30,170,130,0.8)", async ()=>{ await applyAndClose("auto"); }));

                let newRefs = [];
                const redesignBody = document.createElement("div"); redesignBody.style.cssText="padding:6px 14px 12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:8px;";
                const segRow = document.createElement("div"); segRow.style.cssText="display:flex;align-items:center;gap:8px;";
                segRow.appendChild(mkDiv("续跑部分分段数：","font-size:12px;flex-shrink:0;"));
                const segInp = document.createElement("input"); segInp.type="number"; segInp.min="1"; segInp.max="100"; segInp.value=String(getW("分段数")?.value??ckpt.segments);
                Object.assign(segInp.style,{width:"60px",padding:"4px 8px",borderRadius:"5px",fontSize:"13px",background:"var(--comfy-input-bg,#333)",color:"var(--input-text,#eee)",border:"1px solid var(--border-color,#555)"});
                segRow.appendChild(segInp); redesignBody.appendChild(segRow);

                const refRow = document.createElement("div"); refRow.style.cssText="display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
                refRow.appendChild(mkDiv("续跑参考图：","font-size:12px;flex-shrink:0;"));
                const refInfo = mkDiv("（未选，使用当前节点设置）","font-size:11px;opacity:.5;line-height:1.5;");
                const updateRedesignRefInfo = () => {
                    if (newRefs.length) {
                        const firstName = (newRefs[0].split(/[\/]/).pop() || newRefs[0]);
                        refInfo.textContent = `已暂存 ${newRefs.length} 张（首张：${firstName}${newRefs.length > 1 ? " 等" : ""}）`;
                        refInfo.style.opacity = "1";
                    } else {
                        refInfo.textContent = "（未选，使用当前节点设置）";
                        refInfo.style.opacity = ".5";
                    }
                };
                const openRedesignRefManager = () => {
                    showRefManagerWithPaths(newRefs, (paths) => {
                        newRefs = Array.isArray(paths) ? paths.slice() : [];
                        updateRedesignRefInfo();
                    }, {
                        title: "🖼  管理重新设计续跑参考图（左键复制 · 拖动排序 · 右键移除）",
                        emptyText: "（尚未选择续跑参考图，可多次从不同文件夹追加）",
                        confirmText: "✓ 应用到重新设计续跑",
                        addBtnText: "＋ 从文件夹继续追加",
                    });
                };
                const refManageBtn = document.createElement("button"); refManageBtn.textContent="🖼  追加 / 管理"; refManageBtn.style.cssText="padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;"; refManageBtn.onclick=()=>openRedesignRefManager();
                const refClearBtn = document.createElement("button"); refClearBtn.textContent="清空"; refClearBtn.style.cssText="padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;"; refClearBtn.onclick=()=>{newRefs=[];updateRedesignRefInfo();};
                refRow.append(refManageBtn,refClearBtn,refInfo); redesignBody.appendChild(refRow); updateRedesignRefInfo();
                const confirmRD = document.createElement("button"); confirmRD.textContent="✅ 确认重新设计续跑"; confirmRD.style.cssText="flex:1;padding:8px 14px;border-radius:7px;cursor:pointer;font-size:13px;background:#2a9;color:#fff;border:none;font-weight:600;margin-top:2px;";
                confirmRD.onclick=()=>{ void applyAndClose("redesign",{newSegCount:Math.max(1,parseInt(segInp.value)||1),newRefs:newRefs.length?newRefs:null}); };
                redesignBody.appendChild(confirmRD);
                box.appendChild(mkCard("🔧","重新设计续跑","自定义剩余分段数和参考图（进阶）","rgba(200,150,30,0.8)", null, redesignBody));

                const manualBody = document.createElement("div"); manualBody.style.cssText="padding:8px 14px 12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:8px;";
                manualBody.appendChild(mkDiv("请选择手动续跑类型：连续型会把你选择的续跑视频视为当前任务已完成前缀；非连续型仅把它作为衔接素材。若已开启并选中下方旧任务，则会直接套用该旧任务的续跑视频。","font-size:11px;line-height:1.6;opacity:.72;"));
                const manualContBtn = document.createElement("button"); manualContBtn.textContent="✅ 连续型手动续跑"; manualContBtn.style.cssText="padding:8px 12px;border-radius:7px;cursor:pointer;font-size:12px;background:#2a9;color:#fff;border:none;font-weight:600;";
                manualContBtn.onclick=async()=>{ if (oldResumeEnabled && oldResumeSelectedPath) { await applyAndClose("manual_continuous"); return; } overlay.remove(); _resumeSelectDirect({ resumeMode: "manual_continuous" }); };
                const manualFreeBtn = document.createElement("button"); manualFreeBtn.textContent="🧩 非连续型手动续跑（高级）"; manualFreeBtn.style.cssText="padding:8px 12px;border-radius:7px;cursor:pointer;font-size:12px;background:rgba(220,170,70,0.18);color:#ffd98a;border:1px solid rgba(220,170,70,0.45);font-weight:600;";
                manualFreeBtn.onclick=async()=>{ if (oldResumeEnabled && oldResumeSelectedPath) { await applyAndClose("manual_noncontinuous"); return; } overlay.remove(); _resumeSelectDirect({ resumeMode: "manual_noncontinuous" }); };
                manualBody.append(manualContBtn, manualFreeBtn);
                box.appendChild(mkCard("📁","手动续跑","自选视频文件；若选中下方旧任务则直接套用其续跑视频","rgba(120,120,120,0.7)", null, manualBody));

                const divider = document.createElement("div"); divider.style.cssText="margin:4px 0 0;border-top:1px solid rgba(255,255,255,0.12);padding-top:12px;"; box.appendChild(divider);
                const oldTitle = mkDiv("🕘  旧任务续跑","font-size:13px;font-weight:700;color:#ffd98a;"); box.appendChild(oldTitle);

                const oldToggleWrap = document.createElement("label"); oldToggleWrap.style.cssText="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;";
                const oldToggle = document.createElement("input"); oldToggle.type="checkbox"; oldToggle.style.cssText="cursor:pointer;";
                const oldToggleText = mkDiv("开启后，可从过往 checkpoint 中选一个任务，供上方续跑模式直接套用。","line-height:1.6;opacity:.82;");
                oldToggleWrap.append(oldToggle, oldToggleText); box.appendChild(oldToggleWrap);
                const oldHint = mkDiv("提示：左键选择一张缩略图，右键取消选择。只有“开启旧任务续跑”且已选中缩略图时，才会真正套用旧任务。","font-size:11px;opacity:.6;line-height:1.6;");
                box.appendChild(oldHint);

                const oldSection = document.createElement("div"); oldSection.style.cssText="display:none;border:1px solid rgba(255,217,138,0.18);border-radius:8px;padding:10px;background:rgba(255,217,138,0.04);flex-shrink:0;"; box.appendChild(oldSection);
                const oldStatus = mkDiv("正在使用最近一次中断任务。","font-size:11px;line-height:1.6;opacity:.72;margin-bottom:8px;"); oldSection.appendChild(oldStatus);

                // ── 需求1: 清理模式工具条 ──
                let cleanupMode = false;
                const oldDeleteSelectedKeys = new Set();
                const cleanupBar = document.createElement("div");
                cleanupBar.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);flex-wrap:wrap;";

                const cleanupToggleWrap = document.createElement("label");
                cleanupToggleWrap.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;user-select:none;";
                const cleanupToggle = document.createElement("input");
                cleanupToggle.type = "checkbox";
                cleanupToggle.style.cursor = "pointer";
                const cleanupToggleText = mkDiv("🧹 清理模式","font-weight:600;");
                cleanupToggleWrap.append(cleanupToggle, cleanupToggleText);
                cleanupBar.appendChild(cleanupToggleWrap);

                const cleanupCount = mkDiv("· 已选 0 项","font-size:11px;opacity:.7;");
                cleanupBar.appendChild(cleanupCount);

                const cleanupSpacer = document.createElement("div"); cleanupSpacer.style.cssText = "flex:1;";
                cleanupBar.appendChild(cleanupSpacer);

                const mkCleanupBtn = (label, onClick, isDanger) => {
                    const b = document.createElement("button");
                    b.type = "button"; b.textContent = label;
                    b.style.cssText = `padding:5px 10px;border-radius:5px;font-size:11px;cursor:pointer;border:1px solid ${isDanger?"rgba(255,90,90,0.6)":"var(--border-color,#555)"};background:${isDanger?"rgba(255,90,90,0.12)":"rgba(255,255,255,0.04)"};color:${isDanger?"#ffaaaa":"var(--input-text,#ddd)"};font-weight:600;transition:.12s ease;`;
                    b.onmouseover = () => { if (!b.disabled) b.style.background = isDanger?"rgba(255,90,90,0.22)":"rgba(255,255,255,0.10)"; };
                    b.onmouseout  = () => { b.style.background = isDanger?"rgba(255,90,90,0.12)":"rgba(255,255,255,0.04)"; };
                    b.onclick = onClick;
                    return b;
                };

                const selectAllBtn = mkCleanupBtn("☑ 全选", () => {
                    if (!cleanupMode) return;
                    oldResumeItems.forEach(it => {
                        const k = it.history_id || it.checkpoint_path || `${it.unique_id}|${it.timestamp || ""}`;
                        oldDeleteSelectedKeys.add(k);
                    });
                    renderOldGrid();
                    updateCleanupBar();
                });
                const invertBtn = mkCleanupBtn("⇄ 反选", () => {
                    if (!cleanupMode) return;
                    oldResumeItems.forEach(it => {
                        const k = it.history_id || it.checkpoint_path || `${it.unique_id}|${it.timestamp || ""}`;
                        if (oldDeleteSelectedKeys.has(k)) oldDeleteSelectedKeys.delete(k);
                        else oldDeleteSelectedKeys.add(k);
                    });
                    renderOldGrid();
                    updateCleanupBar();
                });
                const deleteBtn = mkCleanupBtn("🗑 删除 (0)", async () => {
                    if (!cleanupMode || oldDeleteSelectedKeys.size === 0) return;
                    // 收集要删的路径列表
                    const toDelete = [];
                    const labelLines = [];
                    oldResumeItems.forEach(it => {
                        const k = it.history_id || it.checkpoint_path || `${it.unique_id}|${it.timestamp || ""}`;
                        if (oldDeleteSelectedKeys.has(k) && it.checkpoint_path) {
                            toDelete.push(it.checkpoint_path);
                            labelLines.push(`  · ${it.timestamp || it.unique_id || k}`);
                        }
                    });
                    if (toDelete.length === 0) return;
                    const confirmText = `确认删除 ${toDelete.length} 个 checkpoint？\n\n这些任务的归档文件将被永久删除，无法恢复。\n（过渡视频文件不会删除）\n\n${labelLines.slice(0, 8).join("\n")}${labelLines.length > 8 ? `\n  · ...共 ${labelLines.length} 个` : ""}`;
                    if (!confirm(confirmText)) return;
                    deleteBtn.disabled = true;
                    deleteBtn.textContent = "🗑 删除中...";
                    try {
                        const resp = await fetch("/sqr/checkpoints/delete", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ paths: toDelete }),
                        });
                        const data = await resp.json();
                        // 从本地列表里移除已删除的项
                        const deletedSet = new Set(data.deleted_paths || []);
                        oldResumeItems = oldResumeItems.filter(it => !(it.checkpoint_path && deletedSet.has(it.checkpoint_path)));
                        // 如果当前选中的续跑项被删了，清空续跑选中状态
                        if (oldResumeSelectedPath && deletedSet.has(oldResumeSelectedPath)) {
                            oldResumeSelectedPath = "";
                            oldResumeSelectedKey = "";
                            oldResumeSelectedSummary = null;
                        }
                        oldDeleteSelectedKeys.clear();
                        renderOldGrid();
                        renderOldStatus();
                        updateCleanupBar();
                        if (data.failed && data.failed.length) {
                            alert(`删除完成：成功 ${data.deleted} 个，失败 ${data.failed.length} 个。\n失败原因：\n${data.failed.slice(0, 5).map(f => `  · ${f.error}`).join("\n")}`);
                        }
                    } catch (e) {
                        alert(`删除请求失败：${e}`);
                    } finally {
                        deleteBtn.disabled = false;
                    }
                }, true);

                cleanupBar.append(selectAllBtn, invertBtn, deleteBtn);
                oldSection.appendChild(cleanupBar);

                const updateCleanupBar = () => {
                    const n = oldDeleteSelectedKeys.size;
                    cleanupCount.textContent = `· 已选 ${n} 项`;
                    deleteBtn.textContent = `🗑 删除 (${n})`;
                    [selectAllBtn, invertBtn, deleteBtn].forEach(b => {
                        b.disabled = !cleanupMode;
                        b.style.opacity = cleanupMode ? "1" : "0.4";
                        b.style.cursor = cleanupMode ? "pointer" : "not-allowed";
                    });
                };
                updateCleanupBar();

                cleanupToggle.onchange = () => {
                    cleanupMode = !!cleanupToggle.checked;
                    if (!cleanupMode) oldDeleteSelectedKeys.clear();
                    // 清理模式时把网格边框变成淡红
                    oldSection.style.borderColor = cleanupMode ? "rgba(255,120,120,0.55)" : "rgba(255,217,138,0.18)";
                    oldSection.style.background = cleanupMode ? "rgba(255,90,90,0.04)" : "rgba(255,217,138,0.04)";
                    cleanupToggleText.style.color = cleanupMode ? "#ffaaaa" : "";
                    updateCleanupBar();
                    renderOldGrid();
                };

                const oldGrid = document.createElement("div"); oldGrid.style.cssText="display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;max-height:320px;overflow-y:auto;padding-right:4px;"; oldSection.appendChild(oldGrid);
                const oldEmpty = mkDiv("（未找到可用的旧 checkpoint 记录）","font-size:11px;opacity:.45;padding:6px 2px;"); oldSection.appendChild(oldEmpty);
                const oldLoading = mkDiv("正在读取旧 checkpoint 列表…","font-size:11px;opacity:.55;padding:6px 2px;display:none;"); oldSection.appendChild(oldLoading);

                const renderOldStatus = () => {
                    if (!oldResumeEnabled) {
                        oldStatus.textContent = "正在使用最近一次中断任务。";
                        oldStatus.style.color = "rgba(255,255,255,0.72)";
                    } else if (oldResumeSelectedSummary) {
                        const label = oldResumeSelectedSummary.timestamp || oldResumeSelectedSummary.ref_video_label || oldResumeSelectedSummary.unique_id || "旧任务";
                        oldStatus.textContent = `已选旧任务：${label}。现在点击上方“自动续跑 / 重新设计续跑 / 手动续跑”都会改为套用该旧任务。`;
                        oldStatus.style.color = "#ffd98a";
                    } else {
                        oldStatus.textContent = "旧任务续跑已开启，但尚未选中缩略图；现在点击上方模式仍会使用最近一次中断任务。";
                        oldStatus.style.color = "#f9a84a";
                    }
                    updateActiveHint();
                };

                const renderOldGrid = () => {
                    oldGrid.innerHTML = "";
                    oldEmpty.style.display = oldResumeItems.length ? "none" : "block";
                    oldResumeItems.forEach(item => {
                        const card = document.createElement("div");
                        const itemKey = item.history_id || item.checkpoint_path || `${item.unique_id}|${item.timestamp || ""}`;
                        const selectedForResume = oldResumeSelectedKey && oldResumeSelectedKey === itemKey;
                        const selectedForDelete = cleanupMode && oldDeleteSelectedKeys.has(itemKey);
                        // 边框：清理模式下，已勾的红色，未勾的灰色；正常模式下，续跑选中的金色
                        let borderColor, bgColor;
                        if (cleanupMode) {
                            borderColor = selectedForDelete ? "1.5px solid rgba(255,80,80,0.95)" : "1px solid rgba(255,255,255,0.12)";
                            bgColor = selectedForDelete ? "rgba(255,80,80,0.10)" : "rgba(255,255,255,0.03)";
                        } else {
                            borderColor = selectedForResume ? "1.5px solid rgba(255,217,138,0.95)" : "1px solid rgba(255,255,255,0.12)";
                            bgColor = selectedForResume ? "rgba(255,217,138,0.10)" : "rgba(255,255,255,0.03)";
                        }
                        card.style.cssText = `border:${borderColor};border-radius:8px;overflow:hidden;background:${bgColor};cursor:pointer;transition:.12s ease;${item.transition_exists ? "" : "opacity:.55;"}position:relative;`;

                        // 图片包裹层（用来叠徽章和删除复选框）
                        const imgWrap = document.createElement("div");
                        imgWrap.style.cssText = "position:relative;";

                        const img = document.createElement("img");
                        // 需求1b: 进度缩略图——优先用过渡视频取最后一帧
                        const thumbSrc = item.progress_thumb_source || item.ref_video_thumb_file;
                        const useLast = item.progress_thumb_use_last_frame ? "&frame=last" : "";
                        img.src = thumbSrc
                            ? `/sqr/video_thumb?file=${encodeURIComponent(thumbSrc)}${useLast}&_ts=${Date.now()}_${Math.random().toString(36).slice(2,6)}`
                            : "";
                        img.style.cssText = "display:block;width:100%;height:78px;object-fit:cover;background:#111;";
                        img.onerror = () => { img.style.opacity = ".22"; };
                        imgWrap.appendChild(img);

                        // 进度徽章（右下）
                        if (item.progress_seg_label) {
                            const badge = document.createElement("div");
                            badge.textContent = item.progress_seg_label;
                            badge.style.cssText = "position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,0.72);color:#7fffb0;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;line-height:1.2;letter-spacing:0.3px;pointer-events:none;";
                            imgWrap.appendChild(badge);
                        }

                        // 清理模式复选框（左上）
                        if (cleanupMode) {
                            const cb = document.createElement("div");
                            cb.textContent = selectedForDelete ? "☑" : "☐";
                            cb.style.cssText = `position:absolute;left:4px;top:4px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;background:${selectedForDelete ? "rgba(255,80,80,0.92)" : "rgba(0,0,0,0.72)"};color:#fff;font-size:14px;font-weight:700;border-radius:4px;line-height:1;pointer-events:none;`;
                            imgWrap.appendChild(cb);
                        }

                        const meta = document.createElement("div");
                        meta.style.cssText = "padding:7px 8px;display:flex;flex-direction:column;gap:4px;";
                        meta.appendChild(mkDiv(item.ref_video_label || "未命名参考视频","font-size:11px;font-weight:600;line-height:1.45;max-height:32px;overflow:hidden;"));
                        meta.appendChild(mkDiv(item.timestamp || item.unique_id || "","font-size:10px;opacity:.65;line-height:1.35;"));
                        meta.appendChild(mkDiv(`第 ${item.completed_seg}/${item.total_segs} 段`,"font-size:10px;opacity:.8;line-height:1.35;"));
                        if (!item.transition_exists) meta.appendChild(mkDiv("过渡视频缺失，当前不可用于续跑","font-size:10px;color:#f9a84a;line-height:1.35;"));
                        card.append(imgWrap, meta);

                        card.onclick = async () => {
                            if (cleanupMode) {
                                // 清理模式下：左键 = 切换删除勾选状态
                                if (oldDeleteSelectedKeys.has(itemKey)) oldDeleteSelectedKeys.delete(itemKey);
                                else oldDeleteSelectedKeys.add(itemKey);
                                renderOldGrid();
                                updateCleanupBar();
                                return;
                            }
                            // 普通模式下：左键 = 选作续跑来源
                            if (!item.transition_exists) return;
                            oldResumeSelectedPath = item.checkpoint_path || "";
                            oldResumeSelectedKey = itemKey;
                            oldResumeSelectedSummary = item;
                            renderOldGrid();
                            renderOldStatus();
                        };
                        card.oncontextmenu = (e) => {
                            e.preventDefault();
                            if (cleanupMode) return; // 清理模式下右键无效
                            if (oldResumeSelectedKey === itemKey) {
                                oldResumeSelectedPath = "";
                                oldResumeSelectedKey = "";
                                oldResumeSelectedSummary = null;
                                renderOldGrid();
                                renderOldStatus();
                            }
                        };
                        oldGrid.appendChild(card);
                    });
                };

                const loadOldCheckpoints = async () => {
                    if (oldResumeLoaded || oldResumeLoading) return;
                    oldResumeLoading = true;
                    oldLoading.style.display = "block";
                    oldEmpty.style.display = "none";
                    try {
                        const resp = await fetch(`/sqr/checkpoints?exclude_uid=${encodeURIComponent(String(node.id || ""))}&ref_params=${currentRefParams}`);
                        const data = await resp.json();
                        oldResumeItems = Array.isArray(data.checkpoints) ? data.checkpoints : [];
                    } catch (e) {
                        console.warn("[SQR] 旧 checkpoint 列表读取失败:", e);
                        oldResumeItems = [];
                    } finally {
                        oldResumeLoading = false;
                        oldResumeLoaded = true;
                        oldLoading.style.display = "none";
                        renderOldGrid();
                        renderOldStatus();
                    }
                };

                oldToggle.onchange = () => {
                    oldResumeEnabled = !!oldToggle.checked;
                    oldSection.style.display = oldResumeEnabled ? "block" : "none";
                    if (oldResumeEnabled) void loadOldCheckpoints();
                    renderOldStatus();
                };
                renderOldStatus();

                const _xBtn=document.createElement("button"); _xBtn.textContent="×"; _xBtn.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;"; _xBtn.onmouseover=()=>_xBtn.style.color="#fff"; _xBtn.onmouseout=()=>_xBtn.style.color="var(--input-text,#aaa)"; _xBtn.onclick=()=>overlay.remove();
                box.appendChild(_xBtn); overlay.appendChild(box); overlay.onclick=e=>{ if(e.target===overlay) overlay.remove(); }; document.body.appendChild(overlay);
            }


            return r;
        };
    }
});
