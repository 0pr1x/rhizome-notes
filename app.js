// =====================
// STATE
// =====================
let db = load() || {};
let current = null;

const isCloud = !!window.RHIZOME_CONFIG?.USE_DRIVE;

// =====================
// INIT
// =====================
init();

async function init(){
  if (Object.keys(db).length === 0){
    createNote("首頁");
  }

  renderList();
  openNote(Object.keys(db)[0]);
}

// =====================
// NOTES
// =====================
function createNote(name){
  db[name] = [{ id: uid(), content:"" }];
  saveLocal();
}

function openNote(name){
  current = name;
  renderList();
  renderEditor();
}

function renderList(){
  const ul = document.getElementById("noteList");
  ul.innerHTML = "";

  Object.keys(db).forEach(n=>{
    const li = document.createElement("li");
    li.textContent = n;

    if(n===current) li.classList.add("active");

    li.onclick = ()=>openNote(n);
    ul.appendChild(li);
  });
}

// =====================
// EDITOR
// =====================
function renderEditor(){
  const editor = document.getElementById("editor");
  editor.innerHTML = "";

  const blocks = db[current];

  blocks.forEach((b,i)=>{
    const div = document.createElement("div");
    div.className = "block";
    div.contentEditable = true;
    div.innerHTML = b.content;

    // INPUT
    div.oninput = ()=>{
      b.content = div.innerHTML;
      debounceSave();
      updateMeta();
    };

    // ENTER
    div.onkeydown = (e)=>{
      if(e.key==="Enter" && !e.shiftKey){
        e.preventDefault();
        blocks.splice(i+1,0,{id:uid(),content:""});
        renderEditor();
        focus(i+1);
      }
    };

    // ✅ 貼圖片（Drive 整合）
    div.onpaste = async (e)=>{
      const items = e.clipboardData.items;

      for(let item of items){
        if(item.type.startsWith("image")){
          e.preventDefault();

          const file = item.getAsFile();

          let url;

          if(isCloud && window.RhizomeDrive?.isConnected()){
            const res = await window.RhizomeDrive.uploadImage(file, "img_"+Date.now()+".png");
            url = res.src;
          } else {
            url = URL.createObjectURL(file);
          }

          insertImage(url);
          b.content = div.innerHTML;
          debounceSave();
        }
      }
    };

    editor.appendChild(div);
  });

  updateMeta();
}

// =====================
// IMAGE INSERT
// =====================
function insertImage(src){
  const html = `${src}`;

  const sel = window.getSelection();
  if(!sel.rangeCount) return;

  const range = sel.getRangeAt(0);
  const frag = range.createContextualFragment(html);

  range.deleteContents();
  range.insertNode(frag);
}

// =====================
// TAGS
// =====================
function updateMeta(){
  const tagEl = document.getElementById("tags");
  tagEl.innerHTML = "";

  const set = new Set();

  db[current].forEach(b=>{
    (b.content.match(/#\w+/g)||[])
      .forEach(t=>set.add(t));
  });

  set.forEach(t=>{
    const d = document.createElement("div");
    d.textContent = t;
    tagEl.appendChild(d);
  });

  // BACKLINK
  const bl = document.getElementById("backlinks");
  bl.innerHTML = "";

  Object.entries(db).forEach(([name,blocks])=>{
    if(name===current) return;

    blocks.forEach(b=>{
      if(b.content.includes([[${current}]])){
        const d = document.createElement("div");
        d.textContent = "← "+name;
        bl.appendChild(d);
      }
    });
  });
}

// =====================
// SAVE
// =====================
let saveTimer;

function debounceSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll,800);
}

async function saveAll(){
  saveLocal();

  if(isCloud && window.RhizomeDrive?.isConnected()){
    try{
      await window.RhizomeDrive.saveFile(
        current+".json",
        JSON.stringify(db[current],null,2)
      );
    }catch(e){
      console.error(e);
    }
  }
}

function saveLocal(){
  localStorage.setItem("rhizome", JSON.stringify(db));
}

function load(){
  return JSON.parse(localStorage.getItem("rhizome"));
}

// =====================
// UTIL
// =====================
function uid(){
  return Date.now()+Math.random().toString(36).slice(2);
}

function focus(i){
  setTimeout(()=>{
    const el=document.getElementsByClassName("block")[i];
    if(!el) return;

    el.focus();
    const r=document.createRange();
    const s=window.getSelection();
    r.selectNodeContents(el);
    r.collapse(false);
    s.removeAllRanges();
    s.addRange(r);
  },0);
}

// =====================
// UI
// =====================
document.getElementById("newNote").onclick=()=>{
  const name = prompt("筆記名稱");
  if(!name) return;
  createNote(name);
  openNote(name);
};

document.getElementById("menuBtn").onclick=()=>{
  document.getElementById("sidebar").classList.toggle("active");
};

document.getElementById("syncBtn").onclick=async ()=>{
  if(!window.RhizomeDrive) return;

  await window.RhizomeDrive.signIn();
  alert("已連接 Drive");
};

// swipe（手機）
let startX=0;

document.addEventListener("touchstart",e=>{
  startX = e.touches[0].clientX;
});

document.addEventListener("touchmove",e=>{
  const dx = e.touches[0].clientX - startX;

  if(dx>80){
    document.getElementById("sidebar").classList.add("active");
  }

  if(dx<-80){
    document.getElementById("rightPanel").classList.add("active");
  }
});
