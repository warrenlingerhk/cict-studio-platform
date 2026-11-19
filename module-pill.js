

(function(){
  var css = document.createElement('style');
  css.textContent = '.module-header{position:relative;}' +
    '.module-expand-pill{position:absolute;right:18px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:7px;background:#fff;color:#023E8A;border:2px solid #90E0EF;border-radius:999px;padding:6px 15px;font:800 .85rem "Nunito Sans",sans-serif;cursor:pointer;box-shadow:0 3px 0 rgba(2,62,138,.28);transition:background .2s;}' +
    '.module-expand-pill:hover{background:#90E0EF;}' +
    '.module-expand-pill:active{transform:translateY(-50%) scale(.95);}' +
    '.module-expand-pill:focus-visible{outline:3px solid #E600FF;outline-offset:2px;}' +
    '.module-expand-pill svg{transition:transform .25s ease;}' +
    '.module-expand-pill.open svg{transform:rotate(180deg);}' +
    '@media(max-width:700px){.module-expand-pill{position:static;transform:none;margin-top:14px;}.module-expand-pill:active{transform:scale(.95);}}';
  document.head.appendChild(css);

  function content(box){
    for (var i = 0; i < box.children.length; i++) {
      if (box.children[i].classList.contains('expandable-content')) return box.children[i];
    }
    return null;
  }
  function boxes(section){
    return Array.prototype.slice.call(section.querySelectorAll('.mod-items > .mod-item > .expandable-box'));
  }
  function sync(section){
    var pill = section.querySelector('.module-expand-pill');
    if (!pill) return;
    var bs = boxes(section);
    var allOpen = bs.length > 0 && bs.every(function(b){ var c = content(b); return c && c.classList.contains('expanded'); });
    var label = pill.querySelector('.mep-label');
    if (label) label.textContent = allOpen ? 'Collapse' : 'Expand';
    pill.classList.toggle('open', allOpen);
    pill.setAttribute('aria-expanded', allOpen ? 'true' : 'false');
  }
  function toggle(modNum){
    var section = document.getElementById('mod-section-' + modNum);
    if (!section) return;
    var bs = boxes(section);
    if (!bs.length) return;
    var anyClosed = bs.some(function(b){ var c = content(b); return c && !c.classList.contains('expanded'); });
    bs.forEach(function(b){
      var c = content(b);
      if (!c) return;
      if (anyClosed) c.classList.add('expanded'); else c.classList.remove('expanded');
    });
    sync(section);
  }
  function addPills(){
    var sections = document.querySelectorAll('.module-section');
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      if (section.querySelector('.module-expand-pill')) { sync(section); continue; }
      if (!boxes(section).length) continue;
      var modNum = section.id.replace('mod-section-', '');
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'module-expand-pill';
      pill.setAttribute('aria-expanded', 'false');
      pill.setAttribute('aria-label', 'Expand or collapse all topics in Module ' + modNum);
      pill.innerHTML = '<span class="mep-label">Expand</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      pill.onclick = (function(n){ return function(){ toggle(n); }; })(modNum);
      var header = section.querySelector('.module-header');
      if (header) header.appendChild(pill);
    }
  }
  function hook(){
    if (typeof window.renderCourse === 'function' && !window.renderCourse.__pillHooked) {
      var orig = window.renderCourse;
      window.renderCourse = function(){ var r = orig.apply(this, arguments); addPills(); return r; };
      window.renderCourse.__pillHooked = true;
    }
  }
  document.addEventListener('click', function(e){
    var h = e.target && e.target.closest ? e.target.closest('.expandable-header') : null;
    if (h) {
      var sec = h.closest('.module-section');
      if (sec) setTimeout(function(){ sync(sec); }, 0);
    }
  });
  hook();
  document.addEventListener('DOMContentLoaded', hook);
})();
