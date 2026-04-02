import { app } from "../../scripts/app.js";

const THUMB_URL = "/sqr/image_thumb?file=";

// ── SQR 上游节点收集（用于精简 prompt 提交，确保 SDPose 等无关节点不被执行）──
function _sqrCollectUpstream(nodeId, promptOutput, visited) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = promptOutput[nodeId];
    if (!node) return;
    for (const val of Object.values(node.inputs || {})) {
        // link 格式为 [src_node_id, src_slot]，ID 可能是字符串或数字
        if (Array.isArray(val) && val.length === 2) {
            const srcId = String(val[0]);
            if (promptOutput[srcId]) {          // 确认是有效节点引用再递归
                _sqrCollectUpstream(srcId, promptOutput, visited);
            }
        }
    }
}

// ── 图片选择弹窗 ─────────────────────────────────────────────────
async function showImageSelector(currentValue, onConfirm) {
    document.getElementById("sqr-img-overlay")?.remove();
    const selected = (currentValue || "").split(",").map(s=>s.trim()).filter(Boolean);
    let currentPath = null;  // null = 根目录列表

    const overlay = document.createElement("div");
    overlay.id = "sqr-img-overlay";
    Object.assign(overlay.style, {
        position:"fixed",inset:"0",zIndex:"10000",
        background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
        background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
        border:"1px solid var(--border-color,#444)",borderRadius:"12px",
        padding:"16px 20px",width:"780px",maxHeight:"90vh",
        display:"flex",flexDirection:"column",gap:"8px",
        boxShadow:"0 8px 40px rgba(0,0,0,.7)"
    });
    const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});

    // 标题
    box.appendChild(mkDiv("🖼  选择参考图（点击图片添加·拖动排序·右键移除）","font-size:14px;font-weight:600;margin-bottom:2px;"));

    // 路径栏
    const pathBar = document.createElement("div");
    Object.assign(pathBar.style, {
        fontSize:"11px",opacity:".6",padding:"4px 0",minHeight:"18px",
        borderBottom:"1px solid var(--border-color,#444)",marginBottom:"2px",
        display:"flex",alignItems:"center",gap:"4px",flexWrap:"wrap"
    });
    box.appendChild(pathBar);

    // 左侧：文件夹+图片浏览区
    const browserWrap = document.createElement("div");
    Object.assign(browserWrap.style, {
        display:"flex",flexDirection:"column",gap:"4px",
        border:"1px solid var(--border-color,#444)",borderRadius:"8px",padding:"6px",
        maxHeight:"300px",overflowY:"auto",minHeight:"80px"
    });
    box.appendChild(browserWrap);

    // 右侧：已选列表
    box.appendChild(mkDiv("已选顺序（拖动调整·右键移除）：","font-size:11px;opacity:.6;"));
    const rightList = document.createElement("div");
    Object.assign(rightList.style, {
        display:"flex",flexWrap:"wrap",gap:"8px",minHeight:"64px",maxHeight:"160px",
        overflowY:"auto",padding:"8px",
        border:"1px solid var(--border-color,#444)",borderRadius:"8px"
    });
    let dragIdx = null;
    function renderRight() {
        rightList.innerHTML = "";
        if (!selected.length) {
            rightList.style.opacity=".4"; rightList.textContent="（尚未选择）"; return;
        }
        rightList.style.opacity="1";
        selected.forEach((fullpath, idx) => {
            const fname = fullpath.split(/[/\\]/).pop();
            const cell = document.createElement("div");
            Object.assign(cell.style, {
                width:"72px",cursor:"grab",textAlign:"center",
                border:"2px solid var(--border-color,#555)",borderRadius:"6px",
                padding:"3px",position:"relative"
            });
            cell.draggable = true;
            const badge = mkDiv(String(idx+1),
                "position:absolute;top:1px;left:1px;background:#4a6;color:#fff;border-radius:3px;padding:0 3px;font-size:10px;font-weight:bold;line-height:15px;");
            const img = new Image();
            img.src = "/sqr/image_thumb?file=" + encodeURIComponent(fullpath);
            Object.assign(img.style, {width:"66px",height:"66px",objectFit:"cover",borderRadius:"3px",display:"block",pointerEvents:"none"});
            const lbl = mkDiv(fname.length>10?fname.slice(0,9)+"…":fname,"font-size:9px;margin-top:2px;word-break:break-all;");
            lbl.title = fullpath;
            cell.append(badge,img,lbl);
            cell.ondragstart=()=>{dragIdx=idx;setTimeout(()=>cell.style.opacity=".3",0);};
            cell.ondragend=()=>cell.style.opacity="1";
            cell.ondragover=e=>{e.preventDefault();cell.style.borderColor="#4a6";};
            cell.ondragleave=()=>cell.style.borderColor="var(--border-color,#555)";
            cell.ondrop=e=>{
                e.preventDefault();cell.style.borderColor="var(--border-color,#555)";
                if(dragIdx!==null&&dragIdx!==idx){const[m]=selected.splice(dragIdx,1);selected.splice(idx,0,m);renderRight();}
            };
            cell.oncontextmenu=e=>{e.preventDefault();selected.splice(idx,1);renderRight();};
            rightList.appendChild(cell);
        });
    }
    renderRight();
    box.appendChild(rightList);

    // 按钮行
    const btns = document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
    const mkBtn=(t,s,fn)=>{const b=Object.assign(document.createElement("button"),{textContent:t});
        b.style.cssText=`flex:1;padding:6px 16px;border-radius:6px;cursor:pointer;${s}`;b.onclick=fn;return b;};
    btns.append(
        mkBtn("清空","",()=>{selected.length=0;renderRight();}),
        mkBtn("取消","",()=>overlay.remove()),
        mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",
              ()=>{onConfirm(selected.join(","));overlay.remove();})
    );
    box.appendChild(btns);

    // 加载并渲染目录内容
    async function loadDir(path) {
        browserWrap.innerHTML = '<div style="opacity:.5;font-size:12px;padding:8px;">加载中...</div>';
        pathBar.innerHTML = "";
        try {
            const isVirtual = path === "__drives__";
            const url = path ? `/sqr/browse?path=${encodeURIComponent(path)}` : "/sqr/browse";
            const data = await (await fetch(url)).json();

            // 更新路径栏
            if (data.type === "roots") {
                pathBar.appendChild(mkDiv("快速入口：","font-size:11px;opacity:.5;"));
            } else {
                // 分割路径显示面包屑
                const sep = path.includes("\\") ? "\\" : "/";
                const parts = path.split(sep).filter(Boolean);
                const rootPart = path.match(/^[A-Za-z]:\\/) ? path.match(/^[A-Za-z]:\\/)[0] : "/";
                // 根目录按钮
                const rootBtn = mkDiv("🏠 根目录","cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);");
                rootBtn.onclick = () => loadDir(null);
                rootBtn.onmouseover=()=>rootBtn.style.opacity=".7";
                rootBtn.onmouseout=()=>rootBtn.style.opacity="1";
                pathBar.appendChild(rootBtn);
                pathBar.appendChild(mkDiv("›","opacity:.4;"));
                // 各级路径
                let accPath = rootPart;
                const nonRoot = parts.slice(path.startsWith("/") ? 0 : 1);
                nonRoot.forEach((part, i) => {
                    accPath = accPath + (accPath.endsWith(sep)?"":sep) + part;
                    const snap = accPath;
                    const btn = mkDiv(part, "cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
                    btn.title = snap;
                    btn.onclick = () => loadDir(snap);
                    btn.onmouseover=()=>btn.style.opacity=".7";
                    btn.onmouseout=()=>btn.style.opacity="1";
                    pathBar.appendChild(btn);
                    if (i < nonRoot.length-1) pathBar.appendChild(mkDiv("›","opacity:.4;"));
                });
            }

            browserWrap.innerHTML = "";
            currentPath = data.path || null;

            const mkRow=(icon,name,onclick,extra="")=>{
                const row=document.createElement("div");
                Object.assign(row.style,{display:"flex",alignItems:"center",gap:"8px",
                    padding:"5px 8px",borderRadius:"5px",cursor:"pointer",fontSize:"12px",
                    border:"1px solid transparent"});
                row.innerHTML=`<span style="opacity:.7">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${name}">${name}</span>${extra}`;
                row.onclick=onclick;
                row.onmouseover=()=>{row.style.background="var(--comfy-input-bg,#333)";row.style.borderColor="var(--border-color,#444)";};
                row.onmouseout=()=>{row.style.background="transparent";row.style.borderColor="transparent";};
                return row;
            };

            if (data.type === "roots") {
                // 面包屑：根目录或此电脑
                if (isVirtual) {
                    pathBar.appendChild(Object.assign(document.createElement("span"),
                        {textContent:"🏠 根目录", style:"cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);"}));
                    pathBar.lastChild.onclick=()=>loadDir(null);
                    pathBar.appendChild(mkDiv("›","opacity:.4;"));
                    pathBar.appendChild(mkDiv("此电脑","padding:2px 6px;"));
                }
                data.roots.forEach(({label, path:p, is_drive}) => {
                    const icon = (p === "__drives__" || is_drive) ? "🖥" : "📁";
                    browserWrap.appendChild(mkRow(icon, label, ()=>loadDir(p)));
                });
            } else {
                // 上级目录（虚拟此电脑的上级回到根目录）
                if (data.parent) {
                    browserWrap.appendChild(mkRow("📁",".. （上级目录）",()=>loadDir(data.parent)));
                } else if (!isVirtual && path) {
                    browserWrap.appendChild(mkRow("📁",".. （上级目录）",()=>loadDir(null)));
                }
                // 子文件夹
                data.folders.forEach(f => {
                    const fullp = (data.path.endsWith("/")||data.path.endsWith("\\")) ? data.path+f : data.path+"/"+f;
                    browserWrap.appendChild(mkRow("📁", f, ()=>loadDir(fullp)));
                });
                // 图片文件
                if (!data.images.length && !data.folders.length) {
                    browserWrap.appendChild(mkDiv("（此目录没有图片）","opacity:.4;font-size:12px;padding:8px;"));
                }
                // 图片网格（带缩略图预览）
                if (data.images.length > 0) {
                    const grid = document.createElement("div");
                    Object.assign(grid.style, {display:"flex",flexWrap:"wrap",gap:"6px",padding:"4px"});
                    data.images.forEach(f => {
                        const fullp = (data.path.endsWith("/")||data.path.endsWith("\\")) ? data.path+f : data.path+"/"+f;
                        const isSel = selected.includes(fullp);
                        const cell = document.createElement("div");
                        Object.assign(cell.style, {
                            width:"80px",cursor:"pointer",textAlign:"center",position:"relative",
                            border: isSel ? "2px solid #4a6" : "2px solid transparent",
                            borderRadius:"6px",padding:"3px",
                            background: isSel ? "var(--comfy-input-bg,#333)" : "transparent"
                        });
                        if (isSel) {
                            const badge = mkDiv(String(selected.indexOf(fullp)+1),
                                "position:absolute;top:2px;left:2px;background:#4a6;color:#fff;border-radius:3px;padding:0 3px;font-size:10px;font-weight:bold;line-height:15px;z-index:1;");
                            cell.appendChild(badge);
                        }
                        const img = new Image();
                        img.src = "/sqr/image_thumb?file=" + encodeURIComponent(fullp);
                        img.title = f;
                        Object.assign(img.style, {width:"74px",height:"74px",objectFit:"cover",borderRadius:"4px",display:"block"});
                        const lbl = mkDiv(f.length>10?f.slice(0,9)+"…":f,"font-size:9px;margin-top:2px;word-break:break-all;");
                        lbl.title = f;
                        cell.append(img, lbl);
                        cell.onclick = () => {
                            if (!selected.includes(fullp)) selected.push(fullp);
                            else selected.splice(selected.indexOf(fullp), 1);
                            loadDir(data.path); renderRight();
                        };
                        cell.onmouseover=()=>{ if(!selected.includes(fullp)) cell.style.borderColor="#666"; };
                        cell.onmouseout =()=>{ if(!selected.includes(fullp)) cell.style.borderColor="transparent"; };
                        grid.appendChild(cell);
                    });
                    browserWrap.appendChild(grid);
                }
            }
        } catch(e) {
            browserWrap.innerHTML = `<div style="opacity:.5;font-size:12px;padding:8px;">加载失败：${e.message}</div>`;
        }
    }

    // × 关闭按钮（右上角）
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

    // 初始加载
    loadDir(null);
}


async function showVideoSelector(currentValue, onConfirm) {
    document.getElementById("sqr-vid-overlay")?.remove();
    let selected = (currentValue || "").split(/[/\\]/).pop();
    let selectedFull = currentValue || "";  // 保存完整路径

    const overlay = document.createElement("div");
    overlay.id = "sqr-vid-overlay";
    Object.assign(overlay.style, {
        position:"fixed",inset:"0",zIndex:"10000",
        background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
        background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
        border:"1px solid var(--border-color,#444)",borderRadius:"12px",
        padding:"16px 20px",width:"520px",maxHeight:"80vh",
        display:"flex",flexDirection:"column",gap:"8px",
        boxShadow:"0 8px 40px rgba(0,0,0,.7)"
    });
    const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});

    box.appendChild(mkDiv("🎬  选择续跑视频","font-size:14px;font-weight:600;"));

    // 路径栏
    const pathBar = document.createElement("div");
    Object.assign(pathBar.style, {
        fontSize:"11px",opacity:".6",padding:"4px 0",minHeight:"18px",
        borderBottom:"1px solid var(--border-color,#444)",marginBottom:"2px",
        display:"flex",alignItems:"center",gap:"4px",flexWrap:"wrap"
    });
    box.appendChild(pathBar);

    // 已选视频区（将在浏览区后插入）
    const selBar = document.createElement("div");
    Object.assign(selBar.style, {
        fontSize:"12px",padding:"6px 8px",borderRadius:"6px",minHeight:"32px",
        border:"1px solid var(--border-color,#444)",background:"var(--comfy-input-bg,#222)",
        display:"flex",alignItems:"center",gap:"8px",cursor:"default"
    });
    function updateSelBar() {
        selBar.innerHTML = "";
        if (!selectedFull) {
            const hint = document.createElement("span");
            hint.textContent = "（未选择续跑视频）";
            hint.style.cssText = "opacity:.4;font-size:11px;";
            selBar.appendChild(hint);
            selBar.oncontextmenu = null;
        } else {
            const lbl = document.createElement("span");
            lbl.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6df;font-size:12px;";
            lbl.textContent = "🎬 " + selectedFull.split(/[/\\]/).pop();
            lbl.title = selectedFull;
            const hint2 = document.createElement("span");
            hint2.textContent = "右键移除";
            hint2.style.cssText = "opacity:.35;font-size:10px;flex-shrink:0;";
            selBar.append(lbl, hint2);
            selBar.oncontextmenu = e => {
                e.preventDefault();
                selectedFull = ""; selected = "";
                updateSelBar();
                browserWrap.querySelectorAll("div[data-vid]").forEach(r=>{
                    r.style.background="transparent"; r.style.borderColor="transparent";
                });
            };
        }
    }
    updateSelBar();

    // 浏览区
    const browserWrap = document.createElement("div");
    Object.assign(browserWrap.style, {
        display:"flex",flexDirection:"column",gap:"3px",
        border:"1px solid var(--border-color,#444)",borderRadius:"8px",padding:"6px",
        maxHeight:"380px",overflowY:"auto",minHeight:"80px"
    });
    box.appendChild(browserWrap);
    box.appendChild(selBar);  // 已选视频区在浏览区下方

    // 按钮行
    const btns = document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
    const mkBtn=(t,s,fn)=>{const b=Object.assign(document.createElement("button"),{textContent:t});
        b.style.cssText=`flex:1;padding:6px 16px;border-radius:6px;cursor:pointer;${s}`;b.onclick=fn;return b;};
    btns.append(
        mkBtn("⊗ 关闭续跑","background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;",
              ()=>{ onConfirm(""); overlay.remove(); }),
        mkBtn("取消","",()=>overlay.remove()),
        mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",
              ()=>{ onConfirm(selectedFull); overlay.remove(); })
    );
    box.appendChild(btns);

    async function loadDir(path) {
        browserWrap.innerHTML = '<div style="opacity:.5;font-size:12px;padding:8px;">加载中...</div>';
        pathBar.innerHTML = "";
        try {
            const isVirtual = path === "__drives__";
            const url = path ? `/sqr/browse_videos?path=${encodeURIComponent(path)}` : "/sqr/browse_videos";
            const data = await (await fetch(url)).json();

            // 面包屑
            if (data.type === "dir") {
                const rootBtn = mkDiv("🏠 根目录","cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);");
                rootBtn.onclick=()=>loadDir(null);
                rootBtn.onmouseover=()=>rootBtn.style.opacity=".7";
                rootBtn.onmouseout=()=>rootBtn.style.opacity="1";
                pathBar.appendChild(rootBtn);
                pathBar.appendChild(mkDiv("›","opacity:.4;"));
                const sep = data.path.includes("\\") ? "\\" : "/";
                const rootPart = data.path.match(/^[A-Za-z]:\\/) ? data.path.match(/^[A-Za-z]:\\/)[0] : "/";
                let accPath = rootPart;
                const parts = data.path.split(sep).filter(Boolean).slice(data.path.startsWith("/") ? 0 : 1);
                parts.forEach((part, i) => {
                    accPath = accPath + (accPath.endsWith(sep)?"":sep) + part;
                    const snap = accPath;
                    const btn = mkDiv(part,"cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
                    btn.title=snap; btn.onclick=()=>loadDir(snap);
                    btn.onmouseover=()=>btn.style.opacity=".7"; btn.onmouseout=()=>btn.style.opacity="1";
                    pathBar.appendChild(btn);
                    if(i<parts.length-1) pathBar.appendChild(mkDiv("›","opacity:.4;"));
                });
            }

            browserWrap.innerHTML = "";

            const mkRow=(icon,name,onclick,highlight=false)=>{
                const row=document.createElement("div");
                Object.assign(row.style,{display:"flex",alignItems:"center",gap:"8px",
                    padding:"6px 8px",borderRadius:"5px",cursor:"pointer",fontSize:"12px",
                    border:"1px solid transparent",
                    background: highlight?"var(--comfy-input-bg,#333)":"transparent",
                    borderColor: highlight?"#4a6":"transparent"});
                row.innerHTML=`<span style="opacity:.7">${icon}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${name}">${name}</span>`;
                row.onclick=onclick;
                row.onmouseover=()=>{if(!highlight){row.style.background="var(--comfy-input-bg,#333)";row.style.borderColor="var(--border-color,#444)";}};
                row.onmouseout=()=>{if(!highlight){row.style.background="transparent";row.style.borderColor="transparent";}};
                return row;
            };

            if (data.type === "roots") {
                if (isVirtual) {
                    const rb = Object.assign(document.createElement("span"),
                        {textContent:"🏠 根目录", style:"cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);"});
                    rb.onclick=()=>loadDir(null);
                    pathBar.appendChild(rb);
                    pathBar.appendChild(mkDiv("›","opacity:.4;"));
                    pathBar.appendChild(mkDiv("此电脑","padding:2px 6px;"));
                }
                data.roots.forEach(({label, path:p, is_drive}) => {
                    const icon = (p === "__drives__" || is_drive) ? "🖥" : "📁";
                    browserWrap.appendChild(mkRow(icon, label, ()=>loadDir(p)));
                });
            } else {
                if (data.parent) browserWrap.appendChild(mkRow("📁",".. （上级目录）",()=>loadDir(data.parent)));
                data.folders.forEach(f => {
                    const fullp = (data.path.endsWith("/")||data.path.endsWith("\\"))?data.path+f:data.path+"/"+f;
                    browserWrap.appendChild(mkRow("📁", f, ()=>loadDir(fullp)));
                });
                if (!data.videos.length && !data.folders.length) {
                    browserWrap.appendChild(mkDiv("（此目录没有视频文件）","opacity:.4;font-size:12px;padding:8px;"));
                }
                data.videos.forEach(f => {
                    const fullp = (data.path.endsWith("/")||data.path.endsWith("\\"))?data.path+f:data.path+"/"+f;
                    const isSel = fullp === selectedFull || f === selected;
                    const row = mkRow("", f, ()=>{
                        selectedFull = fullp; selected = f;
                        updateSelBar();
                        browserWrap.querySelectorAll("div[data-vid]").forEach(r=>{
                            const s = r.dataset.vid===fullp;
                            r.style.background=s?"var(--comfy-input-bg,#333)":"transparent";
                            r.style.borderColor=s?"#4a6":"transparent";
                        });
                    }, isSel);
                    row.dataset.vid = fullp;
                    // 加视频缩略图（替换 emoji 图标位置）
                    const thumbEl = document.createElement("img");
                    thumbEl.src = `/sqr/video_thumb?file=${encodeURIComponent(fullp)}`;
                    thumbEl.style.cssText = "width:48px;height:34px;object-fit:cover;border-radius:3px;flex-shrink:0;";
                    thumbEl.onerror = () => { thumbEl.style.display="none"; row.insertAdjacentText("afterbegin","🎥 "); };
                    row.insertBefore(thumbEl, row.firstChild);
                    browserWrap.appendChild(row);
                });
            }
        } catch(e) {
            browserWrap.innerHTML = `<div style="opacity:.5;font-size:12px;padding:8px;">加载失败：${e.message}</div>`;
        }
    }

    // × 关闭按钮（右上角）
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
    // 续跑视频默认打开 ComfyUI input/ 目录
    fetch("/sqr/browse_videos")
        .then(r=>r.json())
        .then(data=>{
            const inputEntry = data.roots?.find(r=>r.label==="ComfyUI input");
            loadDir(inputEntry ? inputEntry.path : null);
        })
        .catch(()=>loadDir(null));
}


// ── 节点ID设置弹窗 ────────────────────────────────────────────────
function showNodeIdSelector(fields, onConfirm) {
    document.getElementById("sqr-nodeid-overlay")?.remove();
    const overlay=document.createElement("div");
    overlay.id="sqr-nodeid-overlay";
    Object.assign(overlay.style,{position:"fixed",inset:"0",zIndex:"10000",
        background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"});
    const box=document.createElement("div");
    Object.assign(box.style,{background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
        border:"1px solid var(--border-color,#444)",borderRadius:"12px",
        padding:"20px 24px",width:"480px",
        display:"flex",flexDirection:"column",gap:"12px",
        boxShadow:"0 8px 40px rgba(0,0,0,.7)"});
    const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
    box.appendChild(mkDiv("🔧  设置节点 ID","font-size:14px;font-weight:600;"));
    box.appendChild(mkDiv("节点 ID 可通过 ComfyUI → 设置 → 画面 → 节点 → 标签 → 显示全部 开启显示","font-size:11px;opacity:.5;line-height:1.5;"));

    const inputs={};
    fields.forEach(({key,label,tooltip,value})=>{
        const row=document.createElement("div");
        row.style.cssText="display:flex;align-items:center;gap:10px;";
        const lbl=document.createElement("label");
        lbl.textContent=label; lbl.title=tooltip||"";
        lbl.style.cssText="font-size:12px;min-width:180px;flex-shrink:0;cursor:help;";
        const inp=document.createElement("input");
        inp.type="text"; inp.value=value||"";
        inp.style.cssText="flex:1;padding:5px 8px;border-radius:5px;border:1px solid var(--border-color,#555);background:var(--comfy-input-bg,#333);color:var(--input-text,#eee);font-size:12px;";
        inp.placeholder="填入节点 ID 数字";
        inputs[key]=inp; row.append(lbl,inp); box.appendChild(row);
    });

    const btns=document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
    const mkBtn=(t,s,fn)=>{const b=Object.assign(document.createElement("button"),{textContent:t});
        b.style.cssText=`flex:1;padding:6px 18px;border-radius:6px;cursor:pointer;${s}`;b.onclick=fn;return b;};
    btns.append(
        mkBtn("取消","",()=>overlay.remove()),
        mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{
            const result={};
            fields.forEach(({key})=>{result[key]=inputs[key]?.value||"";});
            onConfirm(result); overlay.remove();
        })
    );
    box.appendChild(btns);
    // × 关闭按钮（右上角）
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
}

// ── 注册扩展 ──────────────────────────────────────────────────────
async function _showPreSegmentDialog(sqrNode, onConfirm) {
return new Promise(resolve => {
    document.getElementById("sqr-preseg-overlay")?.remove();
    let selPaths = [];  // 已选路径列表（有序）
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

    // 路径栏
    const pathBar = document.createElement("div");
    Object.assign(pathBar.style, {
        fontSize:"11px",opacity:".6",padding:"4px 0",minHeight:"18px",
        borderBottom:"1px solid var(--border-color,#444)",
        display:"flex",alignItems:"center",gap:"4px",flexWrap:"wrap"
    });
    box.appendChild(pathBar);

    // 已选列表（拖动排序，缩略图）
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
            Object.assign(card.style, {
                width:"72px",cursor:"grab",userSelect:"none",
                display:"flex",flexDirection:"column",alignItems:"center",gap:"2px",
                border:"1px solid var(--border-color,#555)",borderRadius:"6px",padding:"4px",
                background:"var(--comfy-input-bg,#2a2a2a)",position:"relative",fontSize:"10px"
            });
            // 序号徽章
            const badge = mkDiv(String(i+1),"position:absolute;top:2px;left:2px;background:rgba(50,150,70,0.9);color:#fff;font-weight:700;font-size:9px;padding:0 4px;border-radius:3px;");
            // 缩略图
            const img = document.createElement("img");
            img.src = `/sqr/video_thumb?file=${encodeURIComponent(p)}`;
            img.style.cssText = "width:64px;height:44px;object-fit:cover;border-radius:3px;";
            img.draggable = false;
            img.onerror = () => { img.style.display="none"; };
            // 文件名
            const name = mkDiv(p.split(/[/\\]/).pop(),"width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;opacity:.7;");
            name.title = p;
            card.append(badge, img, name);
            // 拖动排序
            card.draggable = true;
            card.ondragstart = () => { dragSrcIdx = i; card.style.opacity=".4"; };
            card.ondragend   = () => { card.style.opacity="1"; };
            card.ondragover  = e => { e.preventDefault(); card.style.borderColor="#4c6"; };
            card.ondragleave = () => { card.style.borderColor="var(--border-color,#555)"; };
            card.ondrop      = e => {
                e.preventDefault(); card.style.borderColor="var(--border-color,#555)";
                if (dragSrcIdx >= 0 && dragSrcIdx !== i) {
                    const [m] = selPaths.splice(dragSrcIdx, 1);
                    selPaths.splice(i, 0, m);
                    renderSel();
                }
            };
            // 右键移除
            card.oncontextmenu = e => { e.preventDefault(); selPaths.splice(i,1); renderSel(); };
            selArea.appendChild(card);
        });
    }
    // 浏览区在上（先选择）
    const browserWrap = document.createElement("div");
    Object.assign(browserWrap.style, {
        display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(90px,1fr))",
        gap:"6px",border:"1px solid var(--border-color,#444)",borderRadius:"8px",
        padding:"8px",maxHeight:"300px",overflowY:"auto",minHeight:"80px",
        alignContent:"flex-start"
    });
    box.appendChild(browserWrap);

    // 已选区在下（选好后排序）
    box.appendChild(mkDiv("已选素材（拖动排序，右键移除）：","font-size:11px;opacity:.5;margin-top:2px;"));
    box.appendChild(selArea);
    renderSel();

    async function loadDir(path) {
        browserWrap.innerHTML = '<div style="opacity:.5;font-size:12px;padding:8px;grid-column:1/-1;">加载中...</div>';
        pathBar.innerHTML = "";
        try {
            const url = path ? `/sqr/browse_videos?path=${encodeURIComponent(path)}` : "/sqr/browse_videos";
            const data = await (await fetch(url)).json();

            // 面包屑
            if (data.type === "dir" || data.type === "roots") {
                const rootBtn = mkDiv("🏠","cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);");
                rootBtn.onclick=()=>loadDir(null); pathBar.appendChild(rootBtn);
                if (data.type === "dir") {
                    pathBar.appendChild(mkDiv("›","opacity:.4;"));
                    const sep = data.path.includes("\\") ? "\\" : "/";
                    let acc = data.path.match(/^[A-Za-z]:\\/)?.[0] || "/";
                    const parts = data.path.split(sep).filter(Boolean).slice(data.path.startsWith("/")?0:1);
                    parts.forEach((part,i) => {
                        acc = acc + (acc.endsWith(sep)?"":sep) + part;
                        const snap=acc;
                        const b=mkDiv(part,"cursor:pointer;padding:2px 6px;border-radius:4px;background:var(--comfy-input-bg,#333);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
                        b.onclick=()=>loadDir(snap); pathBar.appendChild(b);
                        if(i<parts.length-1) pathBar.appendChild(mkDiv("›","opacity:.4;"));
                    });
                }
            }

            browserWrap.innerHTML = "";
            browserWrap.style.display = "grid";

            if (data.type === "roots") {
                data.roots.forEach(({label,path:p,is_drive})=>{
                    const icon = (p === "__drives__" || is_drive) ? "🖥" : "📁";
                    const row=document.createElement("div");
                    row.style.cssText="grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-radius:5px;font-size:12px;";
                    row.innerHTML=`<span>${icon}</span><span>${label}</span>`;
                    row.onclick=()=>loadDir(p);
                    row.onmouseover=()=>row.style.background="var(--comfy-input-bg,#333)";
                    row.onmouseout=()=>row.style.background="";
                    browserWrap.appendChild(row);
                });
            } else {
                // 上级目录
                if (data.parent) {
                    const row=document.createElement("div");
                    row.style.cssText="grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-radius:5px;font-size:12px;";
                    row.innerHTML="<span>📁</span><span>.. （上级目录）</span>";
                    row.onclick=()=>loadDir(data.parent);
                    row.onmouseover=()=>row.style.background="var(--comfy-input-bg,#333)";
                    row.onmouseout=()=>row.style.background="";
                    browserWrap.appendChild(row);
                }
                // 子文件夹
                data.folders.forEach(f=>{
                    const fp=(data.path.endsWith("/")||data.path.endsWith("\\"))?data.path+f:data.path+"/"+f;
                    const row=document.createElement("div");
                    row.style.cssText="grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:6px;cursor:pointer;border-radius:5px;font-size:12px;";
                    row.innerHTML=`<span>📁</span><span>${f}</span>`;
                    row.onclick=()=>loadDir(fp);
                    row.onmouseover=()=>row.style.background="var(--comfy-input-bg,#333)";
                    row.onmouseout=()=>row.style.background="";
                    browserWrap.appendChild(row);
                });
                // 视频文件（卡片+缩略图）
                if (!data.videos.length && !data.folders.length) {
                    browserWrap.appendChild(mkDiv("（此目录没有视频文件和子文件夹）","opacity:.4;font-size:12px;padding:8px;grid-column:1/-1;"));
                } else if (!data.videos.length) {
                    browserWrap.appendChild(mkDiv("（此目录没有视频文件，可进入子文件夹）","opacity:.4;font-size:12px;padding:4px;grid-column:1/-1;"));
                }
                data.videos.forEach(f=>{
                    const fp=(data.path.endsWith("/")||data.path.endsWith("\\"))?data.path+f:data.path+"/"+f;
                    const alreadySel = selPaths.includes(fp);
                    const card=document.createElement("div");
                    // 改为列表行布局（grid-column:1/-1 占满宽度），文件名完整显示
                    Object.assign(card.style,{
                        cursor:"pointer",border: alreadySel?"2px solid #4a6":"1px solid var(--border-color,#555)",
                        borderRadius:"6px",padding:"6px 8px",background:"var(--comfy-input-bg,#2a2a2a)",
                        display:"flex",flexDirection:"row",alignItems:"center",gap:"8px",
                        fontSize:"11px",opacity: alreadySel?"0.55":"1",
                        gridColumn:"1/-1"
                    });
                    const img=document.createElement("img");
                    img.src=`/sqr/video_thumb?file=${encodeURIComponent(fp)}`;
                    img.style.cssText="width:72px;height:48px;object-fit:cover;border-radius:4px;flex-shrink:0;";
                    img.draggable=false;
                    img.onerror=()=>{img.style.display="none";};
                    const nmWrap=document.createElement("div");
                    nmWrap.style.cssText="flex:1;overflow:hidden;";
                    const nm=mkDiv(f,"font-size:11px;opacity:.9;word-break:break-word;overflow-wrap:anywhere;line-height:1.4;");
                    nm.title=fp;
                    nmWrap.appendChild(nm);
                    card.append(img,nmWrap);
                    card.onclick=()=>{
                        if (!selPaths.includes(fp)) {
                            selPaths.push(fp);
                            card.style.border="2px solid #4a6";
                            card.style.opacity="0.55";
                        }
                        renderSel();
                    };
                    browserWrap.appendChild(card);
                });
            }
        } catch(e) {
            browserWrap.innerHTML=`<div style="opacity:.5;font-size:12px;padding:8px;grid-column:1/-1;">加载失败：${e.message}</div>`;
        }
    }

    // 按钮行
    const btns=document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
    const mkBtn=(t,s,fn)=>{const b=document.createElement("button");b.textContent=t;
        b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;b.onclick=fn;return b;};
    btns.append(
        mkBtn("⊗ 关闭续跑","background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;",
              ()=>{ sqrNode._sqrClearVideo?.(); overlay.remove(); resolve({ cancelResume: true }); }),
        mkBtn("🚫 跳过，只合并本次","",()=>{ overlay.remove(); resolve([]); }),
        mkBtn("✅ 确认并运行","background:#2a9;color:#fff;border:none;font-weight:700;",()=>{
            overlay.remove(); resolve(selPaths);
        })
    );
    // × 关闭
    const _xBtn2=document.createElement("button");
    _xBtn2.textContent="×";
    _xBtn2.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";
    _xBtn2.onclick=()=>{ overlay.remove(); resolve(null); };
    box.style.position="relative";
    box.appendChild(_xBtn2);
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // 默认进 output 目录
    fetch("/sqr/browse_videos")
        .then(r=>r.json())
        .then(data=>{ const o=data.roots?.find(r=>r.label==="ComfyUI output"); loadDir(o?o.path:null); })
        .catch(()=>loadDir(null));
});
}



// ── 日志弹窗 ─────────────────────────────────────────────────────────
function _showLogOverlay(nodeId) {
    const pid = `sqr-log-${nodeId}`;
    const existed = document.getElementById(pid);
    if (existed) {
        existed.remove();
        return;
    }

    const box = document.createElement("div");
    box.id = pid;
    Object.assign(box.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "9990",
        width: "580px",
        height: "390px",
        background: "var(--comfy-menu-bg,#161616)",
        border: "1px solid var(--border-color,#3a3a3a)",
        borderRadius: "10px",
        boxShadow: "0 8px 36px rgba(0,0,0,.85)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        resize: "both",
        userSelect: "text",
    });

    // 标题栏（可拖动）
    const hdr = document.createElement("div");
    Object.assign(hdr.style, {
        padding: "7px 12px",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        borderBottom: "1px solid var(--border-color,#2a2a2a)",
        background: "rgba(255,255,255,0.03)",
        cursor: "move",
        flexShrink: "0",
        fontSize: "12px",
        fontWeight: "600",
        userSelect: "none",
    });

    let dx = 0, dy = 0, dragging = false;
    hdr.onmousedown = e => {
        dragging = true;
        const r = box.getBoundingClientRect();
        dx = e.clientX - r.left;
        dy = e.clientY - r.top;

        document.onmousemove = e2 => {
            if (!dragging) return;
            box.style.left = (e2.clientX - dx) + "px";
            box.style.top = (e2.clientY - dy) + "px";
            box.style.right = "auto";
            box.style.bottom = "auto";
        };

        document.onmouseup = () => {
            dragging = false;
            document.onmousemove = null;
            document.onmouseup = null;
        };
    };

    hdr.appendChild(Object.assign(document.createElement("span"), {
        textContent: "📋  分段队列 · 运行日志"
    }));

    const dot = Object.assign(document.createElement("span"), { title: "实时更新中" });
    dot.style.cssText = "width:6px;height:6px;border-radius:50%;background:#2a9;flex-shrink:0;";
    hdr.appendChild(dot);

    hdr.appendChild(Object.assign(document.createElement("span"), { style: "flex:1" }));

    const clrBtn = document.createElement("button");
    clrBtn.textContent = "清空";
    clrBtn.title = "清空当前日志";
    clrBtn.style.cssText =
        "padding:2px 9px;border-radius:4px;cursor:pointer;font-size:11px;" +
        "background:rgba(255,255,255,0.07);border:1px solid var(--border-color,#444);" +
        "color:var(--input-text,#aaa);";
    hdr.appendChild(clrBtn);

    const xBtn = document.createElement("button");
    xBtn.textContent = "×";
    xBtn.style.cssText =
        "padding:0 8px;font-size:18px;line-height:1.4;background:none;border:none;" +
        "cursor:pointer;color:var(--input-text,#666);";
    xBtn.onmouseover = () => xBtn.style.color = "#fff";
    xBtn.onmouseout = () => xBtn.style.color = "var(--input-text,#666)";
    xBtn.onclick = e => {
        e.stopPropagation();
        box.remove();
    };
    hdr.appendChild(xBtn);

    box.appendChild(hdr);

    // 日志区
    const area = document.createElement("div");
    Object.assign(area.style, {
        flex: "1",
        overflowY: "auto",
        padding: "8px 12px",
        fontSize: "11px",
        lineHeight: "1.8",
        fontFamily: "'Consolas','Courier New',monospace",
        color: "var(--input-text,#bbb)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "anywhere",
    });
    area.innerHTML = "<div style='opacity:.4;'>加载中...</div>";
    box.appendChild(area);

    document.body.appendChild(box);

    function esc(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function lineHtml(r) {
        const s = esc(r);

        if (/===/.test(r)) {
            return `<div style="color:#7cf;font-weight:700;padding-top:3px;">${s}</div>`;
        }
        if (/---.*段.*---/.test(r)) {
            return `<div style="color:#adf;border-top:1px solid #222;margin-top:3px;padding-top:3px;">${s}</div>`;
        }
        if (/✓/.test(r)) {
            return `<div style="color:#5d9;">${s}</div>`;
        }
        if (/✗/.test(r)) {
            return `<div style="color:#f76;">${s}</div>`;
        }
        if (/⚠/.test(r)) {
            return `<div style="color:#fa8;">${s}</div>`;
        }
        if (/预览模式|全新生成|续跑模式|重新设计续跑模式/.test(r)) {
            return `<div style="color:#fd9;font-weight:600;">${s}</div>`;
        }
        if (String(r).trim() === "") {
            return `<div style="height:6px;"></div>`;
        }
        return `<div>${s}</div>`;
    }

    function render(lines) {
        if (!lines || !lines.length) {
            area.innerHTML = "<div style='opacity:.4;'>（暂无日志）</div>";
            return;
        }

        const atBot = area.scrollHeight - area.scrollTop - area.clientHeight < 50;
        const html = [];

        for (const raw of lines) {
            const parts = String(raw).split(/\r?\n/);
            for (const r of parts) {
                html.push(lineHtml(r));
            }
        }

        area.innerHTML = html.join("");

        if (atBot) {
            area.scrollTop = area.scrollHeight;
        }
    }

    let lastSig = "";

    clrBtn.onclick = e => {
        e.stopPropagation();
        fetch(`/sqr/logs/clear?uid=${nodeId}`, { method: "POST" }).catch(() => {});
        area.innerHTML = "<div style='opacity:.4;'>（已清空）</div>";
        lastSig = "";
    };

    async function poll() {
        if (!document.getElementById(pid)) return;

        try {
            dot.style.opacity = ".35";
            const d = await (await fetch(`/sqr/logs?uid=${nodeId}`)).json();
            dot.style.opacity = "1";

            const logs = Array.isArray(d.logs) ? d.logs : [];
            const sig = JSON.stringify(logs);

            if (sig !== lastSig) {
                lastSig = sig;
                render(logs);
            }
        } catch (e) {
            dot.style.opacity = ".15";
        }

        if (document.getElementById(pid)) {
            setTimeout(poll, 2000);
        }
    }

    poll();
}


app.registerExtension({
    name: "SegmentQueueRunner.UI",

    async setup() {
        // 拦截全局运行按钮
        const origQueuePrompt = app.queuePrompt?.bind(app);
        if (!origQueuePrompt) return;

        app.queuePrompt = async function(number, batchCount) {
            const sqrNodes = (app.graph?.nodes || []).filter(n =>
                n.type === "SegmentQueueRunner" && !n.muted && n.mode !== 4
            );
            if (sqrNodes.length === 0) {
                return origQueuePrompt(number, batchCount);
            }

            // 续跑模式：弹前段素材选择弹窗，写好 widget 值再提交
            for (const sqrNode of sqrNodes) {
                const getNodeW = name => sqrNode.widgets?.find(w => w.name === name);
                const resumePath = getNodeW("续跑视频路径")?.value || "";
                if (resumePath) {
                    const prePaths = await _showPreSegmentDialog(sqrNode);
                    if (prePaths === null) return;  // 用户点×取消整个提交
                    if (prePaths?.cancelResume) {
                        // 用户主动取消续跑：已由 _sqrClearVideo 清除状态，清空 pre_segments 后继续
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

            // ── 精简 prompt 提交：只含 SQR 及其上游，SDPose 等无关节点不入队 ──
            // SQR 的 Python run() 通过 extra_pnginfo.sqr_full_prompt 获得完整工作流
            let submitResult;
            try {
                const { output: fullOutput, workflow: lgWorkflow } = await app.graphToPrompt();

                // 收集所有 SQR 节点的上游依赖（递归）
                const upstreamIds = new Set();
                for (const sqrNode of sqrNodes) {
                    _sqrCollectUpstream(String(sqrNode.id), fullOutput, upstreamIds);
                }

                // 同时包含 SQR 的直接下游节点（如 ShowText），确保计划文本能显示
                // 注意：link 数组里的节点 ID 可能是数字或字符串，统一用 String() 比较
                for (const sqrNode of sqrNodes) {
                    const sqrId = String(sqrNode.id);
                    for (const [nid, ndata] of Object.entries(fullOutput)) {
                        const vals = Object.values(ndata.inputs || {});
                        if (vals.some(v => Array.isArray(v) && v.length === 2 && String(v[0]) === sqrId)) {
                            upstreamIds.add(nid);
                        }
                    }
                }

                // 构建精简 prompt（仅 SQR 上游节点）
                const strippedOutput = {};
                for (const nid of upstreamIds) {
                    if (fullOutput[nid]) strippedOutput[nid] = fullOutput[nid];
                }

                // 提交：精简 prompt + 完整工作流（Python 端用于构建分段 wf）
                // 带上 client_id 确保分段 prompt 的采样预览和节点缩略图正常路由到当前浏览器
                const clientId = app.api?.clientId ?? "";
                const res = await fetch("/prompt", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: clientId,
                        prompt: strippedOutput,
                        extra_data: {
                            extra_pnginfo: {
                                workflow: lgWorkflow,
                                sqr_full_prompt: fullOutput,
                                sqr_client_id: clientId      // Python 提交分段 prompt 时使用
                            }
                        }
                    })
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                submitResult = await res.json();
            } catch (e) {
                console.warn("[SQR] 精简提交失败，回退到完整 prompt:", e);
                submitResult = await origQueuePrompt(number, batchCount);
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

            // 节点ID等字段是 required，但由按钮管理，尝试缩小显示
            const sqrKeys = ["参考图节点ID","参考视频节点ID","输出节点ID","动作嵌入节点ID","分段参考图","续跑视频路径"];
            // 隐藏"启用续跑"widget（由续跑视频路径是否有值决定）
            const resumeToggle = getW("启用续跑");
            if (resumeToggle) { resumeToggle.computeSize = () => [0, -4]; resumeToggle.type = "hidden"; }
            sqrKeys.forEach(k => {
                const w = getW(k);
                if (w) {
                    w.computeSize = () => [0, -4];
                    w.type = "hidden";
                }
            });
            // 单独隐藏 sqr_save_png（有 input slot，用 draw 覆写完全不渲染）
            {
                const _spw = getW("sqr_save_png");
                if (_spw) {
                    _spw.computeSize = () => [0, -4];
                    _spw.draw = () => {};  // 不画任何内容
                }
            }
            // getSqr/setSqr 直接读写 widget，确保值被序列化
            const getSqr = k => getW(k)?.value || "";
            const setSqr = (k, v) => { const w = getW(k); if (w) w.value = v; };

            // 节点设置：从 localStorage 持久化读取，跨节点/工作流/重启都保留
            const _SQR_STORE_KEY = "sqr_picker_mode";
            const _SQR_PNG_KEY   = "sqr_save_png";
            if (!node._sqrSettings) {
                const savedMode = localStorage.getItem(_SQR_STORE_KEY);
                const savedPng  = localStorage.getItem(_SQR_PNG_KEY);
                node._sqrSettings = {
                    pickerMode: savedMode || "system",
                    savePng: savedPng === null ? true : (savedPng !== "false"),
                };
            }

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
                    padding:"22px 26px",width:"400px",display:"flex",flexDirection:"column",gap:"16px",
                    boxShadow:"0 8px 40px rgba(0,0,0,.7)"
                });
                const mkDiv=(t,st)=>Object.assign(document.createElement("div"),{textContent:t,style:st||""});
                box.appendChild(mkDiv("⚙️  分段队列 · 设置","font-size:15px;font-weight:700;"));
                box.appendChild(mkDiv("文件选择器","font-size:11px;opacity:.5;margin-bottom:-8px;"));

                const row = document.createElement("div"); row.style.cssText="display:flex;gap:10px;";
                const mkOpt=(value,title,desc)=>{
                    const d=document.createElement("div");
                    const active=s.pickerMode===value;
                    Object.assign(d.style,{flex:"1",padding:"8px 12px",minHeight:"68px",boxSizing:"border-box",borderRadius:"8px",cursor:"pointer",
                        border:active?"2px solid #4a9":"2px solid var(--border-color,#555)",
                        background:active?"rgba(60,180,120,0.12)":"transparent"});
                    d.innerHTML=`<div style="font-size:13px;font-weight:600;">${title}</div>
                        <div style="font-size:11px;opacity:.5;margin-top:3px;">${desc}</div>`;
                    d.dataset.opt=value;
                    d.onclick=()=>{
                        s.pickerMode=value;
                        row.querySelectorAll("div[data-opt]").forEach(x=>{
                            const me=x.dataset.opt===value;
                            x.style.border=me?"2px solid #4a9":"2px solid var(--border-color,#555)";
                            x.style.background=me?"rgba(60,180,120,0.12)":"transparent";
                        });
                    };
                    return d;
                };
                row.append(
                    mkOpt("system",  "🪟 系统窗口",   "操作系统原生文件选择对话框"),
                    mkOpt("builtin", "📁 内置浏览器", "内置目录浏览，支持缩略图预览")
                );
                box.appendChild(row);

                // ── Save png 开关 ──
                const divider = document.createElement("div");
                divider.style.cssText = "border-top:1px solid var(--border-color,#444);";
                box.appendChild(divider);
                box.appendChild(mkDiv("Save png of first frame for metadata", "font-size:11px;opacity:.5;margin-bottom:2px;"));

                const pngRow = document.createElement("div"); pngRow.style.cssText="display:flex;gap:10px;";
                const mkPngOpt = (value, label, desc) => {
                    const d = document.createElement("div");
                    const active = (s.savePng === value);
                    Object.assign(d.style, {
                        flex:"1", padding:"8px 12px", minHeight:"68px", boxSizing:"border-box", borderRadius:"8px", cursor:"pointer",
                        border: active ? "2px solid #4a9" : "2px solid var(--border-color,#555)",
                        background: active ? "rgba(60,180,120,0.12)" : "transparent"
                    });
                    d.innerHTML = `<div style="font-size:13px;font-weight:600;">${label}</div>
                        <div style="font-size:11px;opacity:.5;margin-top:2px;">${desc}</div>`;
                    d.dataset.pngval = String(value);
                    d.onclick = () => {
                        s.savePng = value;
                        pngRow.querySelectorAll("div[data-pngval]").forEach(x => {
                            const me = x.dataset.pngval === String(value);
                            x.style.border = me ? "2px solid #4a9" : "2px solid var(--border-color,#555)";
                            x.style.background = me ? "rgba(60,180,120,0.12)" : "transparent";
                        });
                    };
                    return d;
                };
                pngRow.append(
                    mkPngOpt(true,  "✅ True",  "保存 png"),
                    mkPngOpt(false, "🚫 False", "不保存 png（自动清理）")
                );
                box.appendChild(pngRow);

                const btns=document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
                const mkBtn=(t,st,fn)=>{const b=document.createElement("button");b.textContent=t;
                    b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${st}`;b.onclick=fn;return b;};
                btns.append(
                    mkBtn("取消","",()=>overlay.remove()),
                    mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{
                        localStorage.setItem(_SQR_STORE_KEY, s.pickerMode);
                        localStorage.setItem(_SQR_PNG_KEY, String(s.savePng));
                        // 同步到 Python 节点的 sqr_save_png widget
                        const pngW = getW("sqr_save_png");
                        if (pngW) pngW.value = String(s.savePng);
                        overlay.remove();
                        node.setDirtyCanvas?.(true, true);
                    })
                );
                box.appendChild(btns);
                // × 关闭按钮（右上角）
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
                    {key:"参考图节点ID",   label:"参考图 LoadImage ID",        tooltip:"LoadImage node ID",              value:getSqr("参考图节点ID")},
                    {key:"参考视频节点ID", label:"参考视频 Load Video ID",      tooltip:"Load Video (target) node ID",    value:getSqr("参考视频节点ID")},
                    {key:"输出节点ID",     label:"输出 VHS_VideoCombine ID",    tooltip:"Main output VHS_VideoCombine ID",value:getSqr("输出节点ID")},
                    {key:"动作嵌入节点ID", label:"WanVideoAnimateEmbeds ID",    tooltip:"WanVideoAnimateEmbeds node ID",  value:getSqr("动作嵌入节点ID")},
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
                ctx.fillStyle = on ? "rgba(30,160,110,0.28)" : "rgba(255,255,255,0.05)";
                ctx.beginPath();
                if(ctx.roundRect) ctx.roundRect(4,y+2,widget_width-8,H-4,4);
                else ctx.rect(4,y+2,widget_width-8,H-4);
                ctx.fill();
                if(on){ctx.strokeStyle="rgba(40,200,130,0.6)";ctx.lineWidth=1;ctx.stroke();}
                ctx.fillStyle = on ? "#7fc" : "rgba(190,190,190,0.5)";
                ctx.font="12px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";
                ctx.fillText(this.name,widget_width/2,y+H/2);
                ctx.textAlign="left";ctx.textBaseline="alphabetic";
            };

            // ── 🎬 选择续跑视频 按钮（按钮名称显示已选文件名）──
            // ── 已选视频管理器（系统窗口模式用，唯一视频，支持右键移除）──
            const showVideoManager = (onConfirm) => {
                document.getElementById("sqr-vidmgr-overlay")?.remove();
                let curPath = getSqr("续跑视频路径") || "";
                const overlay = document.createElement("div");
                overlay.id = "sqr-vidmgr-overlay";
                Object.assign(overlay.style, {
                    position:"fixed",inset:"0",zIndex:"10001",
                    background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"
                });
                const box = document.createElement("div");
                Object.assign(box.style, {
                    background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
                    border:"1px solid var(--border-color,#444)",borderRadius:"12px",
                    padding:"18px 22px",width:"480px",
                    display:"flex",flexDirection:"column",gap:"10px",
                    boxShadow:"0 8px 40px rgba(0,0,0,.7)"
                });
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
                box.appendChild(mkDiv("🎬  已选续跑视频","font-size:14px;font-weight:600;"));
                box.appendChild(mkDiv("右键可移除已选视频（移除后恢复普通模式）","font-size:11px;opacity:.5;"));
                const vidArea = document.createElement("div");
                Object.assign(vidArea.style, {
                    padding:"10px",border:"1px solid var(--border-color,#444)",borderRadius:"8px",minHeight:"52px"
                });
                function renderVid() {
                    vidArea.innerHTML = "";
                    if (!curPath) {
                        vidArea.appendChild(mkDiv("（未选择续跑视频，将以普通模式运行）","opacity:.4;font-size:12px;padding:4px;"));
                    } else {
                        const fname = curPath.split(/[/\\]/).pop();
                        const row = document.createElement("div");
                        Object.assign(row.style, {
                            display:"flex",alignItems:"center",gap:"8px",padding:"8px 10px",
                            borderRadius:"6px",background:"rgba(60,180,120,0.12)",
                            border:"1px solid #4a9",cursor:"default"
                        });
                        row.innerHTML = `<span style="font-size:18px">🎬</span>
                            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6df;">${fname}</span>
                            <span style="opacity:.35;font-size:10px;flex-shrink:0;">右键移除</span>`;
                        row.title = curPath;
                        row.oncontextmenu = e => { e.preventDefault(); curPath = ""; renderVid(); };
                        vidArea.appendChild(row);
                    }
                }
                renderVid();
                box.appendChild(vidArea);
                const btns = document.createElement("div"); btns.style.cssText="display:flex;gap:8px;";
                const mkBtn=(t,s,fn)=>{const b=document.createElement("button");b.textContent=t;
                    b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;b.onclick=fn;return b;};
                btns.append(
                    mkBtn("⊗ 关闭续跑","background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;",
                          ()=>{ onConfirm(""); overlay.remove(); }),
                    mkBtn("取消","",()=>overlay.remove()),
                    mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{
                        onConfirm(curPath); overlay.remove();
                    })
                );
                box.appendChild(btns);
                // × 关闭按钮（右上角）
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
            };


            const _applyVideo = (result) => {
                if (!result) return;
                setSqr("续跑视频路径", result);
                const fname = result.split(/[/\\]/).pop();
                // 截断过长文件名，避免出框
                // 截断文件名使按钮文字不出框
                // 按钮可用宽 = 节点宽 - 32(内边距) - 30(emoji"🎬  "约30px)
                const _availPx = Math.max(40, (node.size?.[0] || 200) - 62);
                // 用临时canvas测量
                const _tc = document.createElement("canvas").getContext("2d");
                _tc.font = "13px sans-serif";
                let dispName = fname;
                while (dispName.length > 2 && _tc.measureText(dispName + "…").width > _availPx) {
                    dispName = dispName.slice(0, -1);
                }
                if (dispName !== fname) dispName = dispName.slice(0, -1) + "…";
                const m = fname.match(/segment_transition_seg(\d+)\.mp4$/i);
                if (m) {
                    const seg = parseInt(m[1]) + 1;
                    const fromW = getW("从第几段开始");
                    if (fromW) fromW.value = seg;
                    resumeBtn.name = `🎬  ${dispName}  ← 第${seg}段开始`;
                    setTimeout(() => { resumeBtn.name = `🎬  ${dispName}`; node.setDirtyCanvas?.(true,true); }, 3000);
                } else {
                    resumeBtn.name = `🎬  ${dispName}`;
                }
                node.setDirtyCanvas?.(true, true);
                resumeBtn._sqrActive = true;  // 高亮标记
                // 同步设置后端 widget 值（让 Python 知道续跑模式）
                const rtw = getW("启用续跑"); if (rtw) rtw.value = true;
            };

            const _resumeNative = async () => {
                try {
                    const resp = await fetch("/sqr/pick_video");
                    const data = await resp.json();
                    if (data.error) throw new Error(data.error);
                    if (data.path) _applyVideo(data.path);
                    // 无论选了还是取消，都弹管理器（可确认或移除）
                    showVideoManager(result => {
                        if (result) _applyVideo(result);
                        else _clearVideo();
                    });
                } catch(e) { console.warn("[SQR] 续跑原生失败:", e); }
            };
            const _resumeBrowse = async () => {
                await showVideoSelector(getSqr("续跑视频路径"), r => {
                    if (r) _applyVideo(r); else _clearVideo();
                });
            };

            // 直接弹文件选择器（跳过 checkpoint 检测）
            const _resumeSelectDirect = () => {
                node._sqrSettings.pickerMode === "system" ? _resumeNative() : _resumeBrowse();
            };

            const resumeBtn = node.addWidget("button", "🎬  选择续跑视频", null, async () => {
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
                // 无 checkpoint → 直接文件选择器；有 checkpoint → 统一续跑弹窗
                if (!ckpt) { _resumeSelectDirect(); return; }
                _showResumeDialog(ckpt, null);
            });
            resumeBtn.serialize = false;
            // 覆写 draw：续跑开启时高亮绿色背景
            resumeBtn.draw = function(ctx, node, widget_width, y, H) {
                const active = !!this._sqrActive;
                ctx.fillStyle = active ? "rgba(40,160,100,0.35)" : "rgba(255,255,255,0.05)";
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(4, y+2, widget_width-8, H-4, 4)
                              : ctx.rect(4, y+2, widget_width-8, H-4);
                ctx.fill();
                if (active) {
                    ctx.strokeStyle = "rgba(60,200,120,0.7)"; ctx.lineWidth = 1; ctx.stroke();
                }
                ctx.fillStyle = active ? "#7fffb0" : "rgba(200,200,200,0.5)";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(this.name, widget_width/2, y + H/2);
                ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
            };
            // 清除续跑的工具函数
            const _clearVideo = () => {
                setSqr("续跑视频路径", "");
                resumeBtn._sqrActive = false;
                const rtw = getW("启用续跑"); if (rtw) rtw.value = false;
                const fromW2 = getW("从第几段开始");
                if (fromW2) fromW2.value = 1;
                // Bug A fix: 重置帧偏移，防止重新设计续跑的偏移值残留污染下次全新运行
                const foW = getW("sqr_frame_offset"); if (foW) foW.value = -1;
                resumeBtn.name = "🎬  已清除，从第1段开始";
                node.setDirtyCanvas?.(true, true);
                setTimeout(() => {
                    resumeBtn.name = "🎬  选择续跑视频";
                    node.setDirtyCanvas?.(true, true);
                }, 3000);
            };
            // 暴露给外部弹窗（_showPreSegmentDialog 等）使用
            node._sqrClearVideo = _clearVideo;
            // 初始化 sqr_save_png widget 值（与设置同步）
            { const w = getW("sqr_save_png"); if (w) w.value = String(node._sqrSettings.savePng ?? true); }
            // sqr_frame_offset 和 sqr_pre_segments：用 draw=()=>{} 隐藏（保留序列化，不用type=hidden）
            for (const _hk of ["sqr_frame_offset", "sqr_pre_segments"]) {
                const _hw = getW(_hk);
                if (_hw) {
                    _hw.computeSize = () => [0, -4];
                    _hw.draw = () => {};
                    // 不设 type=hidden，确保 ComfyUI 序列化时能传给后端
                }
            }
            // 初始化 sqr_frame_offset 为 -1（非情形B时不偏移）
            { const w = getW("sqr_frame_offset"); if (w) w.value = -1; }
            // 恢复逻辑在下方 setTimeout 里

            // ── 已选图片管理弹窗（系统窗口模式选完后弹出，可排序/移除）──
            const showRefManager = (onConfirm) => {
                document.getElementById("sqr-mgr-overlay")?.remove();
                const paths = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean);
                let dragIdx = null;
                const overlay = document.createElement("div");
                overlay.id = "sqr-mgr-overlay";
                Object.assign(overlay.style, {
                    position:"fixed",inset:"0",zIndex:"10001",
                    background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"
                });
                const box = document.createElement("div");
                Object.assign(box.style, {
                    background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
                    border:"1px solid var(--border-color,#444)",borderRadius:"12px",
                    padding:"18px 22px",width:"680px",maxHeight:"88vh",
                    display:"flex",flexDirection:"column",gap:"10px",
                    boxShadow:"0 8px 40px rgba(0,0,0,.7)"
                });
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
                box.appendChild(mkDiv("🖼  管理已选参考图（拖动排序 · 右键移除）","font-size:14px;font-weight:600;"));
                const grid = document.createElement("div");
                Object.assign(grid.style, {
                    display:"flex",flexWrap:"wrap",gap:"8px",
                    minHeight:"80px",maxHeight:"420px",overflowY:"auto",
                    padding:"10px",border:"1px solid var(--border-color,#444)",borderRadius:"8px"
                });
                function renderGrid() {
                    grid.innerHTML = "";
                    if (!paths.length) {
                        grid.appendChild(mkDiv("（尚未选择参考图）","opacity:.4;font-size:13px;padding:8px;")); return;
                    }
                    grid.appendChild(mkDiv("拖动调整顺序  ·  右键移除",
                        "font-size:11px;opacity:.5;width:100%;padding:2px 4px;"));
                    paths.forEach((p, idx) => {
                        const fname = p.split(/[/\\]/).pop();
                        const cell = document.createElement("div");
                        Object.assign(cell.style, {
                            width:"100px",textAlign:"center",position:"relative",
                            border:"2px solid var(--border-color,#555)",
                            borderRadius:"7px",padding:"4px",cursor:"grab",userSelect:"none"
                        });
                        cell.draggable = true;
                        const badge = mkDiv(String(idx+1),
                            "position:absolute;top:2px;left:2px;background:#3a9;color:#fff;border-radius:3px;padding:0 4px;font-size:10px;font-weight:bold;line-height:16px;z-index:1;");
                        const img = new Image();
                        img.src = "/sqr/image_thumb?file=" + encodeURIComponent(p);
                        Object.assign(img.style, {width:"92px",height:"92px",objectFit:"contain",display:"block",borderRadius:"4px",pointerEvents:"none"});
                        const lbl = mkDiv(fname.length>14?fname.slice(0,13)+"…":fname,
                            "font-size:9px;margin-top:3px;word-break:break-all;opacity:.7;");
                        lbl.title = p;
                        cell.ondragstart = e=>{e.stopPropagation();dragIdx=idx;setTimeout(()=>cell.style.opacity=".35",0);};
                        cell.ondragend   = e=>{e.stopPropagation();cell.style.opacity="1";};
                        cell.ondragover  = e=>{e.preventDefault();e.stopPropagation();cell.style.borderColor="#4a9";};
                        cell.ondragleave = ()=>{cell.style.borderColor="var(--border-color,#555)";};
                        cell.ondrop = e=>{
                            e.preventDefault();e.stopPropagation();
                            cell.style.borderColor="var(--border-color,#555)";
                            if(dragIdx!==null&&dragIdx!==idx){const[m]=paths.splice(dragIdx,1);paths.splice(idx,0,m);renderGrid();}
                        };
                        cell.oncontextmenu = e=>{e.preventDefault();e.stopPropagation();paths.splice(idx,1);renderGrid();};
                        cell.append(badge,img,lbl);
                        grid.appendChild(cell);
                    });
                }
                renderGrid();
                box.appendChild(grid);
                const btns = document.createElement("div"); btns.style.cssText="display:flex;gap:8px;";
                const mkBtn=(t,s,fn)=>{const b=document.createElement("button");b.textContent=t;
                    b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;b.onclick=fn;return b;};
                btns.append(
                    mkBtn("取消","",()=>overlay.remove()),
                    mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{
                        onConfirm(paths); overlay.remove();
                    })
                );
                box.appendChild(btns);
                // × 关闭按钮（右上角）
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
            };

            // ── 🖼 选择参考图 按钮 ──
            const _refNative = async () => {
                try {
                    const resp = await fetch("/sqr/pick_images");
                    const data = await resp.json();
                    if (data.error) throw new Error(data.error);
                    if (data.paths?.length) {
                        const cur = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean);
                        data.paths.forEach(p => { if (!cur.includes(p)) cur.push(p); });
                        setSqr("分段参考图", cur.join(","));
                        refThumbWidget.syncPaths();
                    }
                    // 无论选了还是取消，都打开管理器
                    showRefManager(result => {
                        setSqr("分段参考图", result.join(","));
                        refThumbWidget.syncPaths();
                        node.setDirtyCanvas?.(true, true);
                    });
                } catch(e) { console.warn("[SQR] 参考图原生失败:", e); }
            };
            const _refBrowse = async () => {
                await showImageSelector(getSqr("分段参考图"), result => {
                    setSqr("分段参考图", result);
                    refThumbWidget.syncPaths();
                    node.setDirtyCanvas?.(true, true);
                });
            };

            const refBtn = node.addWidget("button", "🖼️  选择参考图", null, () => {
                node._sqrSettings.pickerMode === "system" ? _refNative() : _refBrowse();
            });
            refBtn.serialize = false;

            // ── 缩略图预览行（canvas 自绘 widget）──
            const refThumbWidget = {
                name: "_sqr_ref_thumbs", type: "sqr_thumbs", serialize: false,
                _paths: [], _loaded: {}, _dragSrc: -1, _dragOver: -1,
                syncPaths() {
                    this._paths = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean);
                    this._paths.forEach(p => {
                        if (!this._loaded[p]) {
                            const img = new Image();
                            img.src = "/sqr/image_thumb?file=" + encodeURIComponent(p);
                            img.onload = () => node.setDirtyCanvas?.(true, true);
                            this._loaded[p] = img;
                        }
                    });
                },
                computeSize(width) {
                    if (!this._paths.length) return [width, 0];
                    // 只声明最小高度，不阻止节点被用户拖小。
                    // draw() 会根据 node.size[1] 实时计算布局，实现自由缩放。
                    return [width, this._minH()];
                },
                _minH() { return 20 + 16; }, // 最小高度：1行最小格子+padding
                // 计算除本 widget 外其他 widget 的高度总和
                _getHeaderH(node) {
                    let h = LiteGraph.NODE_TITLE_HEIGHT ?? 26;
                    for (const w of (node.widgets || [])) {
                        if (w === this) break;
                        const sz = w.computeSize ? w.computeSize(node.size[0]) : [0, LiteGraph.NODE_WIDGET_HEIGHT ?? 20];
                        h += (sz[1] ?? 20) + 4;
                    }
                    return h;
                },
                _getAvailH(node, width) {
                    const headerH = this._getHeaderH(node);
                    const totalH = node.size[1] || 300;
                    return Math.max(this._minH(), totalH - headerH - 8);
                },
                // 给定宽度和可用高度，找出使图片最大的布局
                _calcLayout(width, availH) {
                    const n = this._paths.length;
                    if (!n) return { rows: 0, cols: 0, slot: 48, n };
                    const gap = 6, pad = 8;
                    const MIN_SLOT = 20, MAX_SLOT = 800;
                    const aW = width - pad * 2;  // 可用宽
                    const aH = availH - 16;       // 可用高（留上下padding）

                    let bestSlot = MIN_SLOT, bestRows = 1, bestCols = n;
                    // 遍历所有可能的行数，找格子最大的方案
                    for (let r = 1; r <= n; r++) {
                        const c = Math.ceil(n / r);
                        // 此布局下格子大小（受宽和高双重约束）
                        const slotByW = Math.floor((aW - gap*(c-1)) / c);
                        const slotByH = Math.floor((aH - gap*(r-1)) / r);
                        const slot = Math.min(slotByW, slotByH, MAX_SLOT);
                        if (slot >= MIN_SLOT && slot > bestSlot) {
                            bestSlot = slot; bestRows = r; bestCols = c;
                        }
                    }
                    return { rows: bestRows, cols: bestCols, slot: bestSlot, n };
                },
                _layout(width) {
                    const availH = this._getAvailH(node, width);
                    const { rows, cols, slot, n } = this._calcLayout(width, availH);
                    const gap = 6, pad = 8, padV = 8;
                    const totalW = cols * slot + (cols-1) * gap;
                    const ox = pad + Math.max(0, (width - pad*2 - totalW) / 2);
                    return this._paths.map((p, i) => {
                        const col = i % cols, row = Math.floor(i / cols);
                        const x = ox + col * (slot + gap);
                        const y = padV + row * (slot + gap);
                        return { p, x, y: y, w: slot, h: slot };
                    });
                },
                draw(ctx, node, width, y) {
                    if (!this._paths.length) return;
                    // 宽度或高度变化时都触发重绘，确保缩小和放大都能响应
                    const curH = node.size[1];
                    if (this._lastWidth !== width || this._lastHeight !== curH) {
                        this._lastWidth = width;
                        this._lastHeight = curH;
                        // _layout 内部会读取最新的 node.size[1]，无需额外操作
                    }
                    const layout = this._layout(width);
                    layout.forEach(({p, x, y: ly, w, h}, i) => {
                        const ty = y + ly;
                        const img = this._loaded[p];
                        if (this._dragOver === i && this._dragSrc !== i) {
                            ctx.strokeStyle = "#4c6"; ctx.lineWidth = 2;
                            ctx.strokeRect(x-2, ty-2, w+4, h+4);
                        }
                        if (img?.complete && img.naturalWidth) {
                            const iw = img.naturalWidth, ih = img.naturalHeight;
                            const scale = Math.min(w/iw, h/ih);
                            const dw = iw*scale, dh = ih*scale;
                            ctx.save();
                            if (this._dragSrc === i) ctx.globalAlpha = 0.35;
                            ctx.drawImage(img, x+(w-dw)/2, ty+(h-dh)/2, dw, dh);
                            ctx.restore();
                        } else {
                            ctx.fillStyle = "#2a2a2a"; ctx.fillRect(x, ty, w, h);
                            ctx.fillStyle = "#666"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
                            ctx.fillText("…", x+w/2, ty+h/2+4);
                        }
                        ctx.fillStyle = "rgba(50,150,70,0.92)"; ctx.fillRect(x, ty, 15, 15);
                        ctx.fillStyle = "#fff"; ctx.font = "bold 9px sans-serif"; ctx.textAlign = "center";
                        ctx.fillText(String(i+1), x+7.5, ty+11);
                    });
                    ctx.textAlign = "left";
                },
                _idxAt(lx, ly, width) {
                    return this._layout(width).findIndex(({x, y: iy, w, h}) =>
                        lx >= x && lx <= x+w && ly >= iy && ly <= iy+h);
                },
                mouse(evt, pos, node) {
                    if (!this._paths.length) return false;
                    const lx = pos[0], ly = pos[1], w = node.size[0];
                    if (evt.type === "mousedown" && evt.button === 0) {
                        const i = this._idxAt(lx, ly, w);
                        if (i >= 0) { this._dragSrc = i; this._dragOver = i; return true; }
                    }
                    if (evt.type === "mousemove" && this._dragSrc >= 0) {
                        const i = this._idxAt(lx, ly, w); if (i >= 0) this._dragOver = i;
                        node.setDirtyCanvas?.(true, true); return true;
                    }
                    if (evt.type === "mouseup" && this._dragSrc >= 0) {
                        const src = this._dragSrc, over = this._dragOver;
                        this._dragSrc = -1; this._dragOver = -1;
                        if (src !== over && over >= 0) {
                            const arr = [...this._paths];
                            const [m] = arr.splice(src, 1); arr.splice(over, 0, m);
                            setSqr("分段参考图", arr.join(","));
                            this.syncPaths();
                        }
                        node.setDirtyCanvas?.(true, true); return true;
                    }
                    return false;
                }
            };
            node.addCustomWidget(refThumbWidget);

            // 延迟一帧确保 ComfyUI 已填充 widget 值（重载工作流时需要）
            setTimeout(() => {
                refThumbWidget.syncPaths();
                const p = getSqr("续跑视频路径");
                if (p) {
                    const fname = p.split(/[/\\]/).pop();
                    const _availPx2 = Math.max(40, (node.size?.[0] || 200) - 62);
                    const _tc2 = document.createElement("canvas").getContext("2d");
                    _tc2.font = "13px sans-serif";
                    let _dn2 = fname;
                    while (_dn2.length > 2 && _tc2.measureText(_dn2 + "…").width > _availPx2) {
                        _dn2 = _dn2.slice(0, -1);
                    }
                    if (_dn2 !== fname) _dn2 = _dn2.slice(0, -1) + "…";
                    resumeBtn.name = "🎬  " + _dn2;
                    resumeBtn._sqrActive = true;
                }
                node.setDirtyCanvas?.(true, true);
            }, 100);

            // 辅助：读取 load video 节点的当前完整参数
            function _getRefVideoParams() {
                try {
                    const vidNodeId = getSqr("参考视频节点ID");
                    if (!vidNodeId) return null;
                    const vidNode = app.graph?.getNodeById?.(parseInt(vidNodeId));
                    if (!vidNode) return null;
                    const getW2 = name => vidNode.widgets?.find(w => w.name === name);
                    const videoW = getW2("video") || vidNode.widgets?.[0];
                    return {
                        video:             videoW?.value ? String(videoW.value).split(/[/\\]/).pop() : "",
                        force_rate:        getW2("force_rate")?.value        ?? 0,
                        frame_load_cap:    getW2("frame_load_cap")?.value    ?? 0,
                        skip_first_frames: getW2("skip_first_frames")?.value ?? 0,
                        select_every_nth:  getW2("select_every_nth")?.value  ?? 1,
                    };
                } catch(e) { return null; }
            }
            function _getRefVideoName() {
                return _getRefVideoParams()?.video || "";
            }

            // ── 断点续跑检测 ──
            // onNodeCreated 完成后延迟检测，等节点 id 确定
            setTimeout(async () => {
                const uid = String(node.id);
                if (!uid || uid === "undefined") return;
                try {
                    const _rvp = _getRefVideoParams();
                    const refParams = _rvp ? encodeURIComponent(JSON.stringify(_rvp)) : "";
                    const resp = await fetch(`/sqr/checkpoint?uid=${uid}&ref_params=${refParams}`);
                    const data = await resp.json();
                    const ckpt = data.checkpoint;
                    if (!ckpt) return;
                    if (!ckpt.transition_exists) return;
                    if (ckpt.next_seg > ckpt.total_segs) return;
                    // 不再排除条件6失败 — 统一弹窗内处理所有情况
                    _showCheckpointBanner(ckpt);
                } catch(e) {}
            }, 300);

            // 提示条 widget
            function _showCheckpointBanner(ckpt) {
                // 避免重复显示
                if (node._sqrCheckpointBanner) return;
                node._sqrCheckpointBanner = true;

                // 用普通 button widget 插到最顶部，点击天然可靠
                const bannerBtn = node.addWidget(
                    "button",
                    `⚠  上次第${ckpt.completed_seg}/${ckpt.total_segs}段中断 → 点击选择续跑方式`,
                    null,
                    () => _showResumeDialog(ckpt, bannerBtn)
                );
                bannerBtn.serialize = false;

                // 覆写 draw 让按钮显示橙黄色
                bannerBtn.draw = function(ctx, node, widget_width, y, H) {
                    ctx.fillStyle = this._hover
                        ? "rgba(255,160,0,0.45)"
                        : "rgba(255,160,0,0.28)";
                    ctx.beginPath();
                    if (ctx.roundRect) ctx.roundRect(4, y+2, widget_width-8, H-4, 4);
                    else ctx.rect(4, y+2, widget_width-8, H-4);
                    ctx.fill();
                    ctx.strokeStyle = "rgba(255,160,0,0.8)";
                    ctx.lineWidth = 1;
                    ctx.stroke();
                    ctx.fillStyle = "#ffcc00";
                    ctx.font = "bold 11px sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(this.name, widget_width / 2, y + H / 2);
                    ctx.textAlign = "left";
                    ctx.textBaseline = "alphabetic";
                };

                // 移到所有 widget 最前面（⚙设置 按钮之前）
                const idx = node.widgets.indexOf(bannerBtn);
                if (idx > 0) {
                    node.widgets.splice(idx, 1);
                    node.widgets.unshift(bannerBtn);
                }
                node.setDirtyCanvas?.(true, true);
            }

            // ── 统一续跑弹窗 (4选1) ──────────────────────────────────────
            function _showResumeDialog(ckpt, bannerWidget) {
                document.getElementById("sqr-ckpt-overlay")?.remove();

                // 检测变化
                const curSeg   = Number(getW("分段数")?.value ?? ckpt.segments);
                const segChanged = curSeg !== Number(ckpt.segments);
                const lvBad    = ckpt.ref_video_match === false;
                const ckptParams = ckpt.ref_video_params || {};
                const mNames   = { video:"参考视频文件", force_rate:"强制帧率",
                    frame_load_cap:"帧数读取上限", skip_first_frames:"跳过前X帧", select_every_nth:"间隔" };
                const lvStr    = (ckpt.ref_video_mismatches||[]).map(k=>mNames[k]||k).join("、");

                const overlay = document.createElement("div");
                overlay.id = "sqr-ckpt-overlay";
                Object.assign(overlay.style, {
                    position:"fixed",inset:"0",zIndex:"10000",
                    background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"
                });
                const box = document.createElement("div");
                Object.assign(box.style, {
                    background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",
                    border:"2px solid rgba(255,160,0,0.6)",borderRadius:"12px",
                    padding:"20px 24px",width:"500px",maxHeight:"90vh",overflowY:"auto",
                    display:"flex",flexDirection:"column",gap:"10px",
                    boxShadow:"0 8px 40px rgba(0,0,0,.7)",position:"relative"
                });
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});

                // 标题
                box.appendChild(mkDiv("⚠  检测到上次中断 — 选择续跑方式","font-size:15px;font-weight:700;color:#ffcc00;"));

                // 状态条
                const infoDiv = document.createElement("div");
                infoDiv.style.cssText="font-size:12px;background:rgba(255,255,255,0.05);padding:8px 10px;border-radius:6px;line-height:1.9;";
                infoDiv.innerHTML =
                    `上次完成：第 ${ckpt.completed_seg} / ${ckpt.total_segs} 段 &nbsp;·&nbsp; ` +
                    `续跑视频：<span style="color:#6df">${ckpt.transition_video}</span> &nbsp;·&nbsp; ` +
                    `时间：${ckpt.timestamp}`;
                box.appendChild(infoDiv);

                // 变化警告
                const warns = [];
                if (segChanged) warns.push(`分段数已从 ${ckpt.segments} 改为 ${curSeg}（自动续跑将恢复为 ${ckpt.segments} 段）`);
                if (lvBad)      warns.push(`Load Video 参数已修改（${lvStr}）（自动续跑将恢复原参数）`);
                if (warns.length) {
                    const w = document.createElement("div");
                    w.style.cssText="font-size:12px;color:#ffaa44;padding:6px 10px;border:1px solid rgba(255,160,0,0.35);border-radius:6px;display:flex;flex-direction:column;gap:3px;";
                    warns.forEach(t => w.appendChild(mkDiv(`⚠ ${t}`)));
                    box.appendChild(w);
                }

                // ── 统一 applyAndClose ──
                // Bug A fix: _clearVideo 已重置 sqr_frame_offset
                // Bug B/Issue1 fix: 自动续跑用 base_frame_offset（保持原分段计划），
                //                   重新设计用 frame_offset_for_resume（从断点处另起分段）
                const applyAndClose = (mode, opts={}) => {
                    let fo;
                    if (mode === "auto") {
                        // 自动续跑：沿用本次运行的基础偏移，from_seg 决定从哪段继续
                        // base_frame_offset 不存在时（旧 checkpoint）回退到 0（普通全新运行）
                        const base = typeof ckpt.base_frame_offset === "number" && ckpt.base_frame_offset > 0
                            ? ckpt.base_frame_offset : -1;
                        fo = base;
                    } else {
                        // 重新设计续跑：从断点位置的累积偏移处另起分段
                        const redesignFo = typeof ckpt.frame_offset_for_resume === "number" && ckpt.frame_offset_for_resume > 0
                            ? ckpt.frame_offset_for_resume : -1;
                        fo = redesignFo;
                    }
                    const foW = getW("sqr_frame_offset"); if (foW) foW.value = fo;

                    setSqr("续跑视频路径", ckpt.transition_video);
                    const rtw = getW("启用续跑"); if (rtw) rtw.value = true;
                    resumeBtn._sqrActive = true;
                    resumeBtn.name = "🎬  " + ckpt.transition_video;

                    const fromW = getW("从第几段开始");
                    const segW  = getW("分段数");

                    if (mode === "auto") {
                        // 恢复分段数到 checkpoint 值
                        if (segW) segW.value = ckpt.segments;
                        if (fromW) fromW.value = ckpt.next_seg;
                        // 自动恢复 Load Video 参数（如有变化）
                        if (lvBad) {
                            try {
                                const vn = app.graph?.getNodeById?.(parseInt(getSqr("参考视频节点ID")));
                                if (vn) {
                                    const sv=(n,v)=>{const w=vn.widgets?.find(w=>w.name===n);if(w)w.value=v;};
                                    sv("video",             ckptParams.video);
                                    sv("force_rate",        ckptParams.force_rate);
                                    sv("frame_load_cap",    ckptParams.frame_load_cap);
                                    sv("skip_first_frames", ckptParams.skip_first_frames);
                                    sv("select_every_nth",  ckptParams.select_every_nth);
                                    vn.setDirtyCanvas?.(true,true);
                                }
                            } catch(e) {}
                        }
                        // 参考图：从 next_seg 起截取
                        if (ckpt.ref_images?.length) {
                            const si = Math.min(ckpt.next_seg-1, ckpt.ref_images.length-1);
                            const sl = ckpt.ref_images.slice(si);
                            if (sl.length) setSqr("分段参考图", sl.join(","));
                        }
                    } else { // redesign
                        if (fromW) fromW.value = 1;
                        if (opts.newSegCount && segW) segW.value = opts.newSegCount;
                        if (opts.newRefs?.length) setSqr("分段参考图", opts.newRefs.join(","));
                    }

                    const tw = node.widgets?.find(w=>w.name==="_sqr_ref_thumbs");
                    if (tw) tw.syncPaths?.();

                    // 移除 banner（如有）
                    if (bannerWidget) {
                        node._sqrCheckpointBanner = false;
                        const bi = node.widgets?.indexOf(bannerWidget);
                        if (bi>=0) node.widgets.splice(bi,1);
                    }
                    overlay.remove();
                    node.setDirtyCanvas?.(true,true);
                };

                // ── 卡片工厂 ──
                const mkCard = (emoji, title, hint, borderClr, clickFn, bodyEl) => {
                    const card = document.createElement("div");
                    card.style.cssText=`border:1.5px solid ${borderClr};border-radius:8px;overflow:hidden;`;
                    const hdr = document.createElement("div");
                    hdr.style.cssText="padding:10px 14px;cursor:pointer;display:flex;align-items:baseline;gap:8px;";
                    hdr.onmouseover=()=>hdr.style.background="rgba(255,255,255,0.05)";
                    hdr.onmouseout =()=>hdr.style.background="";
                    hdr.appendChild(mkDiv(`${emoji}  ${title}`,`font-size:13px;font-weight:600;color:${borderClr};`));
                    hdr.appendChild(mkDiv(hint,"font-size:11px;opacity:.6;flex:1;"));
                    hdr.onclick = clickFn;
                    card.appendChild(hdr);
                    if (bodyEl) {
                        bodyEl.style.display="none";
                        card.appendChild(bodyEl);
                        // click header toggles body
                        hdr.onclick = () => {
                            bodyEl.style.display = bodyEl.style.display==="none" ? "block" : "none";
                            clickFn?.();
                        };
                    }
                    return card;
                };

                // 1. 关闭续跑
                box.appendChild(mkCard("⊗","关闭续跑","不衔接，全新生成一份","rgba(200,80,80,0.7)",
                    ()=>{ _clearVideo(); overlay.remove(); }));

                // 2. 自动续跑
                const autoHints = [];
                if (segChanged) autoHints.push(`恢复分段数为 ${ckpt.segments} 段`);
                if (lvBad)      autoHints.push("恢复 Load Video 参数");
                const autoHint = autoHints.length
                    ? `推荐 · 将自动${autoHints.join("、")}`
                    : "推荐 · 一键套用，参考图可随时自行修改";
                box.appendChild(mkCard("✅","自动续跑",autoHint,"rgba(30,170,130,0.8)",
                    ()=>applyAndClose("auto")));

                // 3. 重新设计续跑（含内嵌表单）
                let newRefs = [];
                const redesignBody = document.createElement("div");
                redesignBody.style.cssText="padding:6px 14px 12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:8px;";
                // 分段数输入
                const segRow=document.createElement("div"); segRow.style.cssText="display:flex;align-items:center;gap:8px;";
                segRow.appendChild(mkDiv("续跑部分分段数：","font-size:12px;flex-shrink:0;"));
                const segInp=document.createElement("input");
                segInp.type="number";segInp.min="1";segInp.max="20";
                segInp.value=String(getW("分段数")?.value??ckpt.segments);
                Object.assign(segInp.style,{width:"60px",padding:"4px 8px",borderRadius:"5px",fontSize:"13px",
                    background:"var(--comfy-input-bg,#333)",color:"var(--input-text,#eee)",border:"1px solid var(--border-color,#555)"});
                segRow.appendChild(segInp);
                redesignBody.appendChild(segRow);
                // 参考图选择
                const refRow=document.createElement("div"); refRow.style.cssText="display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
                refRow.appendChild(mkDiv("续跑参考图：","font-size:12px;flex-shrink:0;"));
                const refInfo=mkDiv("（未选，使用当前节点设置）","font-size:11px;opacity:.5;");
                const refPickBtn=document.createElement("button");
                refPickBtn.textContent="🖼  选择";
                refPickBtn.style.cssText="padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;";
                refPickBtn.onclick=async()=>{
                    if (node._sqrSettings.pickerMode==="system") {
                        try{const r=await fetch("/sqr/pick_images");const d=await r.json();
                            if(d.paths?.length){newRefs=d.paths;refInfo.textContent=`已选 ${newRefs.length} 张`;refInfo.style.opacity="1";}}catch(e){}
                    } else {
                        await showImageSelector("",result=>{
                            if(result){newRefs=result.split(",").map(s=>s.trim()).filter(Boolean);refInfo.textContent=`已选 ${newRefs.length} 张`;refInfo.style.opacity="1";}
                        });
                    }
                };
                refRow.append(refPickBtn,refInfo);
                redesignBody.appendChild(refRow);
                // 确认按钮
                const confirmRD=document.createElement("button");
                confirmRD.textContent="✅ 确认重新设计续跑";
                confirmRD.style.cssText="flex:1;padding:8px 14px;border-radius:7px;cursor:pointer;font-size:13px;background:#2a9;color:#fff;border:none;font-weight:600;margin-top:2px;";
                confirmRD.onclick=()=>applyAndClose("redesign",{
                    newSegCount:Math.max(1,parseInt(segInp.value)||1),
                    newRefs:newRefs.length?newRefs:null
                });
                redesignBody.appendChild(confirmRD);
                box.appendChild(mkCard("🔧","重新设计续跑","自定义剩余分段数和参考图（进阶）",
                    "rgba(200,150,30,0.8)", null, redesignBody));

                // 4. 手动续跑
                box.appendChild(mkCard("📁","手动续跑","自选视频文件，不使用 checkpoint 引导",
                    "rgba(120,120,120,0.7)", ()=>{ overlay.remove(); _resumeSelectDirect(); }));

                // × 右上角关闭
                const _xBtn=document.createElement("button");
                _xBtn.textContent="×";
                _xBtn.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";
                _xBtn.onmouseover=()=>_xBtn.style.color="#fff";
                _xBtn.onmouseout =()=>_xBtn.style.color="var(--input-text,#aaa)";
                _xBtn.onclick=()=>overlay.remove();
                box.appendChild(_xBtn);
                overlay.appendChild(box);
                overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};
                document.body.appendChild(overlay);
            }


            return r;
        };
    }
});
