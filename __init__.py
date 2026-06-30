# Copyright (c) 2026 分段队列
# 作者 / Authors: B站：三层楼的小肥猴 & wuwukasi
# 空间 / Bilibili: https://space.bilibili.com/389291683
# 交流 / Contact: 微信 fx-feihou；QQ群 1091593367（请备注来意：加群、商务）
# 开源协议 / Open Source License: Apache License 2.0.
# 中文摘要：可在 Apache-2.0 条款下使用、复制、修改和分发；需保留版权、许可与声明，修改文件需标注变更。
# English summary: You may use, copy, modify, and distribute this software under Apache-2.0, retaining copyright, license, and notices, and marking changed files.
# 本软件按“现状”提供；具体条款以 LICENSE 文件为准。
# Distributed on an "AS IS" BASIS; see the LICENSE file for the full terms.

from .segment_queue_node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
WEB_DIRECTORY = "./js"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
