import { app } from "../../scripts/app.js";

const THUMB_URL = "/sqr/image_thumb?file=";

function sqrThumbUrl(path) {
    const sep = THUMB_URL.includes("?") ? "&" : "?";
    return THUMB_URL + encodeURIComponent(path) + sep + "_ts=" + Date.now() + "_r=" + Math.random().toString(36).slice(2, 8);
}

// ── 远程环境检测 ──────────────────────────────────────────────────
function _sqrIsRemote() {
    const h = window.location.hostname;
    return h !== "localhost" && h !== "127.0.0.1" && h !== "::1";
}

/**
 * 远程环境：用浏览器原生文件选择框选图片，上传到服务器 input/ 目录。
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
 * 远程环境：用浏览器原生文件选择框选视频，上传到服务器 input/ 目录。
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

// ── 仅保留平均分段：手动分段相关 UI 已移除 ───────────────────────────

// ── 注册扩展 ──────────────────────────────────────────────────────
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
    const area=document.createElement("div");Object.assign(area.style,{flex:"1",overflowY:"auto",padding:"8px 12px",fontSize:"11px",lineHeight:"1.8",fontFamily:"'Consolas','Courier New',monospace",color:"var(--input-text,#bbb)",whiteSpace:"pre-wrap",wordBreak:"break-word",overflowWrap:"anywhere"});area.innerHTML="<div style='opacity:.4;'>加载中...</div>";box.appendChild(area);document.body.appendChild(box);
    function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
    function lineHtml(r){const s=esc(r);if(/===/.test(r))return`<div style="color:#7cf;font-weight:700;padding-top:3px;">${s}</div>`;if(/---.*段.*---/.test(r))return`<div style="color:#adf;border-top:1px solid #222;margin-top:3px;padding-top:3px;">${s}</div>`;if(/✓/.test(r))return`<div style="color:#5d9;">${s}</div>`;if(/✗/.test(r))return`<div style="color:#f76;">${s}</div>`;if(/⚠/.test(r))return`<div style="color:#fa8;">${s}</div>`;if(/预览模式|全新生成|续跑模式|重新设计续跑模式/.test(r))return`<div style="color:#fd9;font-weight:600;">${s}</div>`;if(String(r).trim()==="")return`<div style="height:6px;"></div>`;return`<div>${s}</div>`;}
    function render(lines){if(!lines||!lines.length){area.innerHTML="<div style='opacity:.4;'>（暂无日志）</div>";return;}const atBot=area.scrollHeight-area.scrollTop-area.clientHeight<50;const html=[];for(const raw of lines){const parts=String(raw).split(/\r?\n/);for(const r of parts)html.push(lineHtml(r));}area.innerHTML=html.join("");if(atBot)area.scrollTop=area.scrollHeight;}
    let lastSig="";
    clrBtn.onclick=e=>{e.stopPropagation();fetch(`/sqr/logs/clear?uid=${nodeId}`,{method:"POST"}).catch(()=>{});area.innerHTML="<div style='opacity:.4;'>（已清空）</div>";lastSig="";};
    async function poll(){if(!document.getElementById(pid))return;try{dot.style.opacity=".35";const d=await(await fetch(`/sqr/logs?uid=${nodeId}`)).json();dot.style.opacity="1";const logs=Array.isArray(d.logs)?d.logs:[];const sig=JSON.stringify(logs);if(sig!==lastSig){lastSig=sig;render(logs);}}catch(e){dot.style.opacity=".15";}if(document.getElementById(pid))setTimeout(poll,2000);}
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

            for (const sqrNode of sqrNodes) {
                const getNodeW = name => sqrNode.widgets?.find(w => w.name === name);
                const preW = getNodeW("sqr_pre_segments");
                if (preW) preW.value = "";

                const resumePath = getNodeW("续跑视频路径")?.value || "";
                if (resumePath) {
                    const prePaths = await _showPreSegmentDialog(sqrNode);
                    if (prePaths === null) return;
                    if (prePaths?.cancelResume) {
                        if (preW) preW.value = "";
                        continue;
                    }
                    if (preW) preW.value = prePaths.join(",");
                }
            }

            let submitResult;
            try {
                const { output: fullOutput, workflow: lgWorkflow } = await app.graphToPrompt();
                const upstreamIds = new Set();
                for (const sqrNode of sqrNodes) { _sqrCollectUpstream(String(sqrNode.id), fullOutput, upstreamIds); }
                for (const sqrNode of sqrNodes) { const sqrId = String(sqrNode.id); for (const [nid, ndata] of Object.entries(fullOutput)) { const vals = Object.values(ndata.inputs || {}); if (vals.some(v => Array.isArray(v) && v.length === 2 && String(v[0]) === sqrId)) { upstreamIds.add(nid); } } }
                const strippedOutput = {};
                for (const nid of upstreamIds) { if (fullOutput[nid]) strippedOutput[nid] = fullOutput[nid]; }
                const clientId = app.api?.clientId ?? "";
                const res = await fetch("/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ client_id: clientId, prompt: strippedOutput, extra_data: { extra_pnginfo: { workflow: lgWorkflow, sqr_full_prompt: fullOutput, sqr_client_id: clientId } } }) });
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

            const sqrKeys = ["参考图节点ID","参考视频节点ID","输出节点ID","动作嵌入节点ID","分段参考图","续跑视频路径"];
            const resumeToggle = getW("启用续跑");
            if (resumeToggle) { resumeToggle.computeSize = () => [0, -4]; resumeToggle.type = "hidden"; }
            sqrKeys.forEach(k => {
                const w = getW(k);
                if (w) { w.computeSize = () => [0, -4]; w.type = "hidden"; }
            });
            {
                const _spw = getW("sqr_save_png");
                if (_spw) { _spw.computeSize = () => [0, -4]; _spw.draw = () => {}; }
            }

            const segW = getW("分段数");
            const startW = getW("从第几段开始");

            function _sqrApplySegMax() {
                const maxVal = Math.max(2, Math.min(100, node._sqrSettings?.segMax || 100));
                if (segW) {
                    segW.options.max = maxVal;
                    if (segW.value > maxVal) segW.value = maxVal;
                }
                if (startW) {
                    const curSeg = segW ? Math.max(1, Math.round(segW.value)) : maxVal;
                    startW.options.max = curSeg;
                    if (startW.value > curSeg) startW.value = curSeg;
                }
                node.setDirtyCanvas?.(true, true);
            }

            function _sqrEnsureSegCapacity(required) {
                const need = Math.max(2, Math.min(100, Math.round(required || 0)));
                if (!need) return;
                if (!node._sqrSettings) node._sqrSettings = {};
                if ((node._sqrSettings.segMax || 0) < need) {
                    node._sqrSettings.segMax = need;
                    try { localStorage.setItem(_SQR_SEGMAX_KEY, String(need)); } catch(e) {}
                }
                _sqrApplySegMax();
            }

            if (segW) {
                const _origSegCb = segW.callback;
                segW.callback = function(v, ...args) {
                    const iv = Math.max(1, Math.round(v));
                    this.value = iv;
                    if (startW) {
                        startW.options.max = iv;
                        if (startW.value > iv) startW.value = iv;
                    }
                    if (_origSegCb) return _origSegCb.call(this, iv, ...args);
                };
            }

            if (startW) {
                const _origStartCb = startW.callback;
                startW.callback = function(v, ...args) {
                    const mx = segW ? Math.max(1, Math.round(segW.value)) : 100;
                    if (v > mx) { this.value = mx; v = mx; }
                    if (_origStartCb) return _origStartCb.call(this, v, ...args);
                };
            }

            const getSqr = k => getW(k)?.value || "";
            const setSqr = (k, v) => { const w = getW(k); if (w) w.value = v; };

            const _SQR_PNG_KEY   = "sqr_save_png";
            const _SQR_SEGMAX_KEY = "sqr_seg_max";
            const _SQR_EXECGLOW_KEY = "sqr_exec_glow";
            if (!node._sqrSettings) {
                const savedPng  = localStorage.getItem(_SQR_PNG_KEY);
                const savedSegMax = localStorage.getItem(_SQR_SEGMAX_KEY);
                const savedExecGlow = localStorage.getItem(_SQR_EXECGLOW_KEY);
                node._sqrSettings = {
                    savePng: savedPng === null ? true : (savedPng !== "false"),
                    segMax: savedSegMax ? parseInt(savedSegMax) : 10,
                    execGlow: savedExecGlow === null ? true : (savedExecGlow !== "false"),
                };
            }

            _sqrApplySegMax();

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
                    padding:"22px 26px",width:"520px",display:"flex",flexDirection:"column",gap:"16px",
                    boxShadow:"0 8px 40px rgba(0,0,0,.7)"
                });
                const mkDiv=(t,st)=>Object.assign(document.createElement("div"),{textContent:t,style:st||""});
                box.appendChild(mkDiv("⚙️  分段队列 · 设置","font-size:15px;font-weight:700;"));
                const mkRemoteHint = (text) => {
                    const el = document.createElement("div");
                    Object.assign(el.style, { padding:"10px 14px", borderRadius:"8px", fontSize:"12px", lineHeight:"1.7", border:"1px solid rgba(100,180,255,0.3)", background:"rgba(60,140,255,0.08)", color:"var(--input-text,#ccc)" });
                    el.innerHTML = `<span style="color:#7cf;font-weight:600;">🌐 远程模式</span>&nbsp; ${text}`;
                    return el;
                };

                const isRemote = _sqrIsRemote();

                box.appendChild(Object.assign(document.createElement("div"),{style:"border-top:1px solid var(--border-color,#444);"}));
                box.appendChild(mkDiv("平均分段设置","font-size:13px;font-weight:600;margin-bottom:2px;"));
                box.appendChild(mkDiv("仅保留平均分段模式，分段数语义固定为“段数”。","font-size:10px;opacity:.45;line-height:1.5;margin-bottom:6px;"));

                if (!isRemote) {
                    const segMaxSection = document.createElement("div");
                    segMaxSection.style.cssText = "display:flex;align-items:center;gap:10px;margin-top:4px;";
                    const segMaxLabel = document.createElement("span"); segMaxLabel.textContent = "分段数滑动条最大值"; segMaxLabel.style.cssText = "font-size:12px;opacity:.7;";
                    const segMaxInput = document.createElement("input"); segMaxInput.type = "number"; segMaxInput.min = "2"; segMaxInput.max = "100"; segMaxInput.value = String(s.segMax || 10);
                    Object.assign(segMaxInput.style, { width:"70px", padding:"5px 8px", borderRadius:"5px", border:"1px solid var(--border-color,#555)", background:"var(--comfy-input-bg,#333)", color:"var(--input-text,#eee)", fontSize:"13px" });
                    segMaxInput.onchange = () => { let v = parseInt(segMaxInput.value) || 10; v = Math.max(2, Math.min(100, v)); segMaxInput.value = v; s.segMax = v; };
                    const segMaxHint = document.createElement("span"); segMaxHint.textContent = "（2-100，默认10）"; segMaxHint.style.cssText = "font-size:11px;opacity:.4;";
                    segMaxSection.append(segMaxLabel, segMaxInput, segMaxHint);
                    box.appendChild(segMaxSection);
                } else {
                    box.appendChild(mkDiv(`当前分段最大值：${s.segMax}`,"font-size:12px;opacity:.7;padding:4px 0;"));
                }

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

                const btns=document.createElement("div"); btns.style.cssText="display:flex;gap:8px;margin-top:4px;";
                const mkBtn=(t,st,fn)=>{const b=document.createElement("button");b.textContent=t;b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${st}`;b.onclick=fn;return b;};
                btns.append(
                    mkBtn("取消","",()=>overlay.remove()),
                    mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{
                        if (!isRemote) {
                            localStorage.setItem(_SQR_PNG_KEY, String(s.savePng));
                            localStorage.setItem(_SQR_SEGMAX_KEY, String(s.segMax));
                            localStorage.setItem(_SQR_EXECGLOW_KEY, String(s.execGlow));
                            const pngW = getW("sqr_save_png");
                            if (pngW) pngW.value = String(s.savePng);
                            _sqrApplySegMax();
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

            // ── 已选视频管理弹窗 ──
            const showVideoManager = (onConfirm) => {
                document.getElementById("sqr-vidmgr-overlay")?.remove();
                let curPath = getSqr("续跑视频路径") || "";
                const overlay = document.createElement("div");overlay.id = "sqr-vidmgr-overlay";Object.assign(overlay.style, {position:"fixed",inset:"0",zIndex:"10001",background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"});
                const box = document.createElement("div");Object.assign(box.style, {background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",border:"1px solid var(--border-color,#444)",borderRadius:"12px",padding:"18px 22px",width:"480px",display:"flex",flexDirection:"column",gap:"10px",boxShadow:"0 8px 40px rgba(0,0,0,.7)"});
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
                box.appendChild(mkDiv("🎬  已选续跑视频","font-size:14px;font-weight:600;"));
                box.appendChild(mkDiv("右键可移除已选视频（移除后恢复普通模式）","font-size:11px;opacity:.5;"));
                const vidArea = document.createElement("div");Object.assign(vidArea.style,{padding:"10px",border:"1px solid var(--border-color,#444)",borderRadius:"8px",minHeight:"52px"});
                function renderVid() {
                    vidArea.innerHTML = "";
                    if (!curPath) { vidArea.appendChild(mkDiv("（未选择续跑视频，将以普通模式运行）","opacity:.4;font-size:12px;padding:4px;")); } else {
                        const fname = curPath.split(/[/\\]/).pop(); const row = document.createElement("div"); Object.assign(row.style, {display:"flex",alignItems:"center",gap:"8px",padding:"8px 10px",borderRadius:"6px",background:"rgba(60,180,120,0.12)",border:"1px solid #4a9",cursor:"default"});
                        row.innerHTML = `<span style="font-size:18px">🎬</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#6df;">${fname}</span><span style="opacity:.35;font-size:10px;flex-shrink:0;">右键移除</span>`;
                        row.title = curPath; row.oncontextmenu = e => { e.preventDefault(); curPath = ""; renderVid(); }; vidArea.appendChild(row); } }
                renderVid(); box.appendChild(vidArea);
                const btns = document.createElement("div"); btns.style.cssText="display:flex;gap:8px;";
                const mkBtn=(t,s,fn)=>{const b=document.createElement("button");b.textContent=t;b.style.cssText=`flex:1;padding:7px 18px;border-radius:7px;cursor:pointer;font-size:13px;${s}`;b.onclick=fn;return b;};
                btns.append(mkBtn("⊗ 关闭续跑","background:rgba(180,60,60,0.2);border:1px solid rgba(200,80,80,0.5);color:#f88;",()=>{onConfirm("");overlay.remove();}),mkBtn("取消","",()=>overlay.remove()),mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{onConfirm(curPath);overlay.remove();}));
                box.appendChild(btns);
                const _xBtn=document.createElement("button");_xBtn.textContent="×";_xBtn.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";_xBtn.onmouseover=()=>_xBtn.style.color="#fff";_xBtn.onmouseout=()=>_xBtn.style.color="var(--input-text,#aaa)";_xBtn.onclick=()=>overlay.remove();box.style.position="relative";box.appendChild(_xBtn);overlay.appendChild(box);overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};document.body.appendChild(overlay);
            };

            const _applyVideo = (result) => {
                if (!result) return;
                setSqr("续跑视频路径", result);
                const fname = result.split(/[/\\]/).pop();
                const _availPx = Math.max(40, (node.size?.[0] || 200) - 62);
                const _tc = document.createElement("canvas").getContext("2d");
                _tc.font = "13px sans-serif";
                let dispName = fname;
                while (dispName.length > 2 && _tc.measureText(dispName + "…").width > _availPx) {
                    dispName = dispName.slice(0, -1);
                }
                if (dispName !== fname) dispName = dispName.slice(0, -1) + "…";
                const m = fname.match(/sqr_trans_[0-9_]+_seg(\d+)\.mp4$/i) || fname.match(/sqr_trans_[a-f0-9]+_seg(\d+)\.mp4$/i) || fname.match(/segment_transition_seg(\d+)\.mp4$/i);
                if (m) {
                    const seg = parseInt(m[1]) + 1;
                    const maxSeg = segW ? Math.round(segW.value) : 100;
                    const fromW = getW("从第几段开始");
                    if (seg <= maxSeg) {
                        if (fromW) fromW.value = seg;
                        resumeBtn.name = `🎬  ${dispName}  ← 第${seg}段开始`;
                    } else {
                        resumeBtn.name = `🎬  ${dispName}  ← 请手动设置从第几段开始`;
                    }
                    setTimeout(() => { resumeBtn.name = `🎬  ${dispName}`; node.setDirtyCanvas?.(true,true); }, 3000);
                } else {
                    resumeBtn.name = `🎬  ${dispName}`;
                }
                node.setDirtyCanvas?.(true, true);
                resumeBtn._sqrActive = true;
                const rtw = getW("启用续跑"); if (rtw) rtw.value = true;
            };

            const _resumeNative = async () => {
                // 统一走浏览器弹框（避免本地 tkinter 在部分环境下弹不出来）
                try {
                    const saved = await _sqrPickAndUploadVideo();
                    if (saved) _applyVideo(saved);
                    showVideoManager(result => { if (result) _applyVideo(result); else _clearVideo(); });
                } catch(e) { console.warn("[SQR] 续跑选择失败:", e); }
            };
            const _resumeSelectDirect = () => {
                _resumeNative();
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
                ctx.fillStyle = active ? "rgba(40,160,100,0.35)" : "rgba(255,255,255,0.05)";
                ctx.beginPath();
                ctx.roundRect ? ctx.roundRect(4, y+2, widget_width-8, H-4, 4) : ctx.rect(4, y+2, widget_width-8, H-4);
                ctx.fill();
                if (active) { ctx.strokeStyle = "rgba(60,200,130,0.7)"; ctx.lineWidth = 1; ctx.stroke(); }
                ctx.fillStyle = active ? "#7fffb0" : "rgba(190,190,190,0.5)";
                ctx.font = "12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(this.name, widget_width/2, y + H/2);
                ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
            };

            const _clearVideo = () => {
                setSqr("续跑视频路径", "");
                resumeBtn._sqrActive = false;
                const rtw = getW("启用续跑"); if (rtw) rtw.value = false;
                const fromW2 = getW("从第几段开始");
                if (fromW2) fromW2.value = 1;
                const foW = getW("sqr_frame_offset"); if (foW) foW.value = -1;
                resumeBtn.name = "🎬  已清除，从第1段开始";
                node.setDirtyCanvas?.(true, true);
                setTimeout(() => {
                    resumeBtn.name = "🎬  选择续跑视频";
                    node.setDirtyCanvas?.(true, true);
                }, 3000);
            };
            node._sqrClearVideo = _clearVideo;

            { const w = getW("sqr_save_png"); if (w) w.value = String(node._sqrSettings.savePng ?? true); }
            for (const _hk of ["sqr_frame_offset", "sqr_pre_segments"]) {
                const _hw = getW(_hk);
                if (_hw) { _hw.computeSize = () => [0, -4]; _hw.draw = () => {}; }
            }
            { const w = getW("sqr_frame_offset"); if (w) w.value = -1; }

            // ── 已选图片管理弹窗 ──
            const showRefManager = (onConfirm) => {
                document.getElementById("sqr-mgr-overlay")?.remove();
                const paths = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean);
                let dragIdx = null;
                const overlay = document.createElement("div");overlay.id = "sqr-mgr-overlay";Object.assign(overlay.style,{position:"fixed",inset:"0",zIndex:"10001",background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"});
                const box = document.createElement("div");Object.assign(box.style,{background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",border:"1px solid var(--border-color,#444)",borderRadius:"12px",padding:"18px 22px",width:"680px",maxHeight:"88vh",display:"flex",flexDirection:"column",gap:"10px",boxShadow:"0 8px 40px rgba(0,0,0,.7)"});
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});
                box.appendChild(mkDiv("🖼  管理已选参考图（左键复制 · 拖动排序 · 右键移除）","font-size:14px;font-weight:600;"));
                const grid = document.createElement("div");Object.assign(grid.style,{display:"flex",flexWrap:"wrap",gap:"8px",minHeight:"80px",maxHeight:"420px",overflowY:"auto",padding:"10px",border:"1px solid var(--border-color,#444)",borderRadius:"8px"});
                function renderGrid() {
                    grid.innerHTML = "";
                    if (!paths.length) { grid.appendChild(mkDiv("（尚未选择参考图）","opacity:.4;font-size:13px;padding:8px;")); return; }
                    grid.appendChild(mkDiv("左键单击复制  ·  拖动调整顺序  ·  右键移除","font-size:11px;opacity:.5;width:100%;padding:2px 4px;"));
                    paths.forEach((p, idx) => {
                        const fname = p.split(/[/\\]/).pop();
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
                btns.append(mkBtn("取消","",()=>overlay.remove()),mkBtn("✓ 确认","background:#2a9;color:#fff;border:none;font-weight:600;",()=>{onConfirm(paths);overlay.remove();}));
                box.appendChild(btns);
                const _xBtn=document.createElement("button");_xBtn.textContent="×";_xBtn.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";_xBtn.onmouseover=()=>_xBtn.style.color="#fff";_xBtn.onmouseout=()=>_xBtn.style.color="var(--input-text,#aaa)";_xBtn.onclick=()=>overlay.remove();box.style.position="relative";box.appendChild(_xBtn);overlay.appendChild(box);overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};document.body.appendChild(overlay);
            };

            const _refNative = async () => {
                // 统一走浏览器弹框（避免本地 tkinter 在部分环境下弹不出来）
                try {
                    const saved = await _sqrPickAndUploadImages();
                    if (saved.length) { const cur = (getSqr("分段参考图")||"").split(",").map(s=>s.trim()).filter(Boolean); saved.forEach(name => { if (!cur.includes(name)) cur.push(name); }); setSqr("分段参考图", cur.join(",")); refThumbWidget.syncPaths(); }
                    showRefManager(result => { setSqr("分段参考图", result.join(",")); refThumbWidget.syncPaths(); node.setDirtyCanvas?.(true, true); });
                } catch(e) { console.warn("[SQR] 参考图选择失败:", e); }
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
                const p = getSqr("续跑视频路径");
                if (p) {
                    const fname = p.split(/[/\\]/).pop();
                    const _availPx2 = Math.max(40, (node.size?.[0] || 200) - 62);
                    const _tc2 = document.createElement("canvas").getContext("2d");
                    _tc2.font = "13px sans-serif";
                    let _dn2 = fname;
                    while (_dn2.length > 2 && _tc2.measureText(_dn2 + "…").width > _availPx2) { _dn2 = _dn2.slice(0, -1); }
                    if (_dn2 !== fname) _dn2 = _dn2.slice(0, -1) + "…";
                    resumeBtn.name = "🎬  " + _dn2;
                    resumeBtn._sqrActive = true;
                }
                node.setDirtyCanvas?.(true, true);
            }, 100);

            function _getRefVideoParams() {
                try {
                    const vidNodeId = getSqr("参考视频节点ID"); if (!vidNodeId) return null;
                    const vidNode = app.graph?.getNodeById?.(parseInt(vidNodeId)); if (!vidNode) return null;
                    const getW2 = name => vidNode.widgets?.find(w => w.name === name);
                    const videoW = getW2("video") || vidNode.widgets?.[0];
                    return { video: videoW?.value ? String(videoW.value).split(/[/\\]/).pop() : "", force_rate: getW2("force_rate")?.value ?? 0, frame_load_cap: getW2("frame_load_cap")?.value ?? 0, skip_first_frames: getW2("skip_first_frames")?.value ?? 0, select_every_nth: getW2("select_every_nth")?.value ?? 1 };
                } catch(e) { return null; }
            }
            function _getRefVideoName() { return _getRefVideoParams()?.video || ""; }

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
                if (node._sqrCheckpointBanner) return; node._sqrCheckpointBanner = true;
                const bannerBtn = node.addWidget("button", `⚠  上次第${ckpt.completed_seg}/${ckpt.total_segs}段中断 → 点击选择续跑方式`, null, () => _showResumeDialog(ckpt, bannerBtn));
                bannerBtn.serialize = false;
                bannerBtn.draw = function(ctx, node, widget_width, y, H) {
                    ctx.fillStyle = this._hover ? "rgba(255,160,0,0.45)" : "rgba(255,160,0,0.28)";
                    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(4, y+2, widget_width-8, H-4, 4); else ctx.rect(4, y+2, widget_width-8, H-4); ctx.fill();
                    ctx.strokeStyle = "rgba(255,160,0,0.8)"; ctx.lineWidth = 1; ctx.stroke();
                    ctx.fillStyle = "#ffcc00"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                    ctx.fillText(this.name, widget_width / 2, y + H / 2); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
                };
                const idx = node.widgets.indexOf(bannerBtn); if (idx > 0) { node.widgets.splice(idx, 1); node.widgets.unshift(bannerBtn); }
                node.setDirtyCanvas?.(true, true);
            }

            function _showResumeDialog(ckpt, bannerWidget) {
                document.getElementById("sqr-ckpt-overlay")?.remove();
                const curSeg = Number(getW("分段数")?.value ?? ckpt.segments); const segChanged = curSeg !== Number(ckpt.segments);
                const lvBad = ckpt.ref_video_match === false; const ckptParams = ckpt.ref_video_params || {};
                const mNames = { video:"参考视频文件", force_rate:"强制帧率", frame_load_cap:"帧数读取上限", skip_first_frames:"跳过前X帧", select_every_nth:"间隔" };
                const lvStr = (ckpt.ref_video_mismatches||[]).map(k=>mNames[k]||k).join("、");

                const overlay = document.createElement("div");overlay.id = "sqr-ckpt-overlay";Object.assign(overlay.style,{position:"fixed",inset:"0",zIndex:"10000",background:"rgba(0,0,0,.75)",display:"flex",alignItems:"center",justifyContent:"center"});
                const box = document.createElement("div");Object.assign(box.style,{background:"var(--comfy-menu-bg,#1e1e1e)",color:"var(--input-text,#eee)",border:"2px solid rgba(255,160,0,0.6)",borderRadius:"12px",padding:"20px 24px",width:"500px",maxHeight:"90vh",overflowY:"auto",display:"flex",flexDirection:"column",gap:"10px",boxShadow:"0 8px 40px rgba(0,0,0,.7)",position:"relative"});
                const mkDiv=(t,s)=>Object.assign(document.createElement("div"),{textContent:t,style:s||""});

                box.appendChild(mkDiv("⚠  检测到上次中断 — 选择续跑方式","font-size:15px;font-weight:700;color:#ffcc00;"));
                const infoDiv = document.createElement("div");infoDiv.style.cssText="font-size:12px;background:rgba(255,255,255,0.05);padding:8px 10px;border-radius:6px;line-height:1.9;";
                infoDiv.innerHTML = `上次完成：第 ${ckpt.completed_seg} / ${ckpt.total_segs} 段 &nbsp;·&nbsp; 平均分段数：<span style="color:#6df">${ckpt.segments}</span> &nbsp;·&nbsp; 续跑视频：<span style="color:#6df">${ckpt.transition_video}</span> &nbsp;·&nbsp; 时间：${ckpt.timestamp}`;
                box.appendChild(infoDiv);

                const warns = [];
                if (segChanged) warns.push(`分段数已从 ${ckpt.segments} 改为 ${curSeg}（自动续跑将恢复为 ${ckpt.segments} 段）`);
                if (lvBad) warns.push(`Load Video 参数已修改（${lvStr}）（自动续跑将恢复原参数）`);
                if (warns.length) { const w = document.createElement("div"); w.style.cssText="font-size:12px;color:#ffaa44;padding:6px 10px;border:1px solid rgba(255,160,0,0.35);border-radius:6px;display:flex;flex-direction:column;gap:3px;"; warns.forEach(t => w.appendChild(mkDiv(`⚠ ${t}`))); box.appendChild(w); }

                const applyAndClose = (mode, opts={}) => {
                    let fo;
                    if (mode === "auto") { const base = typeof ckpt.base_frame_offset === "number" && ckpt.base_frame_offset > 0 ? ckpt.base_frame_offset : -1; fo = base; }
                    else { const redesignFo = typeof ckpt.frame_offset_for_resume === "number" && ckpt.frame_offset_for_resume > 0 ? ckpt.frame_offset_for_resume : -1; fo = redesignFo; }
                    const foW = getW("sqr_frame_offset"); if (foW) foW.value = fo;
                    setSqr("续跑视频路径", ckpt.transition_video);
                    const rtw = getW("启用续跑"); if (rtw) rtw.value = true;
                    resumeBtn._sqrActive = true; resumeBtn.name = "🎬  " + ckpt.transition_video;
                    const fromW = getW("从第几段开始"); const segWw = getW("分段数");
                    if (mode === "auto") {
                        _sqrEnsureSegCapacity(ckpt.segments);
                        if (segWw) segWw.value = ckpt.segments;
                        if (fromW) fromW.value = Math.min(ckpt.next_seg, ckpt.total_segs);
                        if (lvBad) { try { const vn = app.graph?.getNodeById?.(parseInt(getSqr("参考视频节点ID"))); if (vn) { const sv=(n,v)=>{const w=vn.widgets?.find(w=>w.name===n);if(w)w.value=v;}; sv("video",ckptParams.video);sv("force_rate",ckptParams.force_rate);sv("frame_load_cap",ckptParams.frame_load_cap);sv("skip_first_frames",ckptParams.skip_first_frames);sv("select_every_nth",ckptParams.select_every_nth);vn.setDirtyCanvas?.(true,true); } } catch(e) {} }
                        if (ckpt.ref_images?.length) { const si = Math.min(ckpt.next_seg-1, ckpt.ref_images.length-1); const sl = ckpt.ref_images.slice(si); if (sl.length) setSqr("分段参考图", sl.join(",")); }
                    } else {
                        if (fromW) fromW.value = 1;
                        if (opts.newSegCount) _sqrEnsureSegCapacity(opts.newSegCount);
                        if (opts.newSegCount && segWw) segWw.value = opts.newSegCount;
                        if (opts.newRefs?.length) setSqr("分段参考图", opts.newRefs.join(","));
                    }
                    if (segWw && startW) { startW.options.max = Math.round(segWw.value); if (startW.value > startW.options.max) startW.value = startW.options.max; }
                    const tw = node.widgets?.find(w=>w.name==="_sqr_ref_thumbs"); if (tw) tw.syncPaths?.();
                    if (bannerWidget) { node._sqrCheckpointBanner = false; const bi = node.widgets?.indexOf(bannerWidget); if (bi>=0) node.widgets.splice(bi,1); }
                    overlay.remove(); node.setDirtyCanvas?.(true,true);
                };

                const mkCard = (emoji, title, hint, borderClr, clickFn, bodyEl) => {
                    const card = document.createElement("div");card.style.cssText=`border:1.5px solid ${borderClr};border-radius:8px;overflow:hidden;`;
                    const hdr = document.createElement("div");hdr.style.cssText="padding:10px 14px;cursor:pointer;display:flex;align-items:baseline;gap:8px;";
                    hdr.onmouseover=()=>hdr.style.background="rgba(255,255,255,0.05)";hdr.onmouseout=()=>hdr.style.background="";
                    hdr.appendChild(mkDiv(`${emoji}  ${title}`,`font-size:13px;font-weight:600;color:${borderClr};`));
                    hdr.appendChild(mkDiv(hint,"font-size:11px;opacity:.6;flex:1;"));
                    hdr.onclick = clickFn; card.appendChild(hdr);
                    if (bodyEl) { bodyEl.style.display="none"; card.appendChild(bodyEl); hdr.onclick = () => { bodyEl.style.display = bodyEl.style.display==="none" ? "block" : "none"; clickFn?.(); }; }
                    return card;
                };

                box.appendChild(mkCard("⊗","关闭续跑","不衔接，全新生成一份","rgba(200,80,80,0.7)",()=>{_clearVideo();overlay.remove();}));
                const autoHints = []; if (segChanged) autoHints.push(`恢复分段数为 ${ckpt.segments} 段`); if (lvBad) autoHints.push("恢复 Load Video 参数");
                const autoHint = autoHints.length ? `推荐 · 将自动${autoHints.join("、")}` : "推荐 · 一键套用，参考图可随时自行修改";
                box.appendChild(mkCard("✅","自动续跑",autoHint,"rgba(30,170,130,0.8)",()=>applyAndClose("auto")));

                let newRefs = [];
                const redesignBody = document.createElement("div");redesignBody.style.cssText="padding:6px 14px 12px;border-top:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:8px;";
                const segRow=document.createElement("div");segRow.style.cssText="display:flex;align-items:center;gap:8px;";
                segRow.appendChild(mkDiv("续跑部分分段数：","font-size:12px;flex-shrink:0;"));
                const segInp=document.createElement("input");segInp.type="number";segInp.min="1";segInp.max="100";
                segInp.value=String(getW("分段数")?.value??ckpt.segments);
                Object.assign(segInp.style,{width:"60px",padding:"4px 8px",borderRadius:"5px",fontSize:"13px",background:"var(--comfy-input-bg,#333)",color:"var(--input-text,#eee)",border:"1px solid var(--border-color,#555)"});
                segRow.appendChild(segInp);redesignBody.appendChild(segRow);
                const refRow=document.createElement("div");refRow.style.cssText="display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
                refRow.appendChild(mkDiv("续跑参考图：","font-size:12px;flex-shrink:0;"));
                const refInfo=mkDiv("（未选，使用当前节点设置）","font-size:11px;opacity:.5;");
                const refPickBtn=document.createElement("button");refPickBtn.textContent="🖼  选择";refPickBtn.style.cssText="padding:4px 10px;border-radius:5px;cursor:pointer;font-size:12px;";
                refPickBtn.onclick=async()=>{
                    // 统一走浏览器弹框
                    try { const saved = await _sqrPickAndUploadImages(); if (saved.length) { newRefs = saved; refInfo.textContent=`已选 ${newRefs.length} 张`; refInfo.style.opacity="1"; } } catch(e) {}
                };
                refRow.append(refPickBtn,refInfo);redesignBody.appendChild(refRow);
                const confirmRD=document.createElement("button");confirmRD.textContent="✅ 确认重新设计续跑";confirmRD.style.cssText="flex:1;padding:8px 14px;border-radius:7px;cursor:pointer;font-size:13px;background:#2a9;color:#fff;border:none;font-weight:600;margin-top:2px;";
                confirmRD.onclick=()=>applyAndClose("redesign",{newSegCount:Math.max(1,parseInt(segInp.value)||1),newRefs:newRefs.length?newRefs:null});
                redesignBody.appendChild(confirmRD);
                box.appendChild(mkCard("🔧","重新设计续跑","自定义剩余分段数和参考图（进阶）","rgba(200,150,30,0.8)", null, redesignBody));
                box.appendChild(mkCard("📁","手动续跑","自选视频文件，不使用 checkpoint 引导","rgba(120,120,120,0.7)", ()=>{ overlay.remove(); _resumeSelectDirect(); }));

                const _xBtn=document.createElement("button");_xBtn.textContent="×";_xBtn.style.cssText="position:absolute;top:10px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--input-text,#aaa);line-height:1;padding:0;";_xBtn.onmouseover=()=>_xBtn.style.color="#fff";_xBtn.onmouseout=()=>_xBtn.style.color="var(--input-text,#aaa)";_xBtn.onclick=()=>overlay.remove();
                box.appendChild(_xBtn);overlay.appendChild(box);overlay.onclick=e=>{if(e.target===overlay)overlay.remove();};document.body.appendChild(overlay);
            }

            return r;
        };
    }
});
