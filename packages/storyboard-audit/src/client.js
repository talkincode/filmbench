(function () {
  "use strict";

  var raw = document.getElementById("sb-data").textContent;
  var data = JSON.parse(raw);
  var board = document.getElementById("board");
  var grid = document.getElementById("grid");
  var svgSeq = document.getElementById("threads");
  var svgDep = document.getElementById("deps");
  var cards = Array.prototype.slice.call(grid.querySelectorAll(".card"));
  var byId = new Map(cards.map(function (c) { return [c.dataset.id, c]; }));
  var view = { filter: "all", seq: true, dep: true, focus: null };
  var rects = new Map();

  function visible() {
    return cards
      .filter(function (c) { return !c.hasAttribute("hidden-f"); })
      .sort(function (a, b) { return Number(a.dataset.order) - Number(b.dataset.order); });
  }

  function measure() {
    var b = board.getBoundingClientRect();
    rects.clear();
    cards.forEach(function (c) {
      var r = c.getBoundingClientRect();
      rects.set(c.dataset.id, {
        left: r.left - b.left,
        top: r.top - b.top,
        right: r.right - b.left,
        bottom: r.bottom - b.top,
        cx: r.left - b.left + r.width / 2,
        cy: r.top - b.top + r.height / 2,
        w: r.width,
        h: r.height
      });
    });
  }

  function el(name, attrs) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (var k in attrs) if (attrs[k] !== undefined) n.setAttribute(k, String(attrs[k]));
    return n;
  }

  function marker(id, color) {
    var m = el("marker", {
      id: id, viewBox: "0 0 8 8", refX: 7, refY: 4,
      markerWidth: 7, markerHeight: 7, orient: "auto"
    });
    m.appendChild(el("path", { d: "M0,0 L8,4 L0,8 z", fill: color }));
    return m;
  }

  function reset(svg, marks) {
    svg.innerHTML = "";
    svg.setAttribute("width", String(board.clientWidth));
    svg.setAttribute("height", String(board.clientHeight));
    var defs = el("defs", {});
    marks.forEach(function (m) { defs.appendChild(m); });
    svg.appendChild(defs);
  }

  /* —— 顺序连线：同行走列间留白；换行走行间留白，圆角拐弯，绝不压过卡片 —— */
  function drawSeq(list) {
    var prev = null;
    for (var i = 0; i < list.length; i++) {
      var cur = list[i];
      var r = rects.get(cur.dataset.id);
      if (prev && prev.index === i - 1) {
        var a = prev.rect;
        var skipped = Number(cur.dataset.order) - Number(prev.el.dataset.order) - 1;
        var cls = "seq" + (skipped > 0 ? " gap" : "");
        var d;
        if (Math.abs(r.top - a.top) < 2) {
          d = "M" + (a.right + 1) + " " + a.cy + " L" + (r.left - 6) + " " + r.cy;
        } else {
          var rad = 9;
          var gutterY = a.bottom + Math.max(11, (r.top - a.bottom) / 2);
          var dir = r.cx >= a.cx ? 1 : -1;
          d =
            "M" + a.cx + " " + (a.bottom + 1) +
            " L" + a.cx + " " + (gutterY - rad) +
            " Q" + a.cx + " " + gutterY + " " + (a.cx + dir * rad) + " " + gutterY +
            " L" + (r.cx - dir * rad) + " " + gutterY +
            " Q" + r.cx + " " + gutterY + " " + r.cx + " " + (gutterY + rad) +
            " L" + r.cx + " " + (r.top - 1);
        }
        svgSeq.appendChild(el("path", { d: d, class: cls, "marker-end": "url(#arrow-seq)" }));
        if (skipped > 0) {
          var midX = Math.abs(r.top - a.top) < 2 ? (a.right + r.left) / 2 : r.cx;
          var midY = Math.abs(r.top - a.top) < 2 ? a.cy - 9 : a.bottom + 24;
          var label = el("text", { class: "dep-label", x: midX, y: midY, "text-anchor": "middle" });
          label.textContent = "跳过 " + skipped + " 镜";
          svgSeq.appendChild(label);
        }
      }
      prev = { rect: r, el: cur, index: i };
    }
  }

  /* —— 依赖连线：底图层画全部（被卡片遮住，只在留白处露出），悬停时前景重描该镜头的边 —— */
  function depEdges(list, only) {
    var out = [];
    var present = new Map(list.map(function (c) { return [c.dataset.id, c]; }));
    list.forEach(function (src) {
      if (only && src.dataset.id !== only) return;
      var meta = data.shots.find(function (s) { return s.id === src.dataset.id; });
      if (!meta || !meta.deps) return;
      meta.deps.forEach(function (dep) {
        var tgt = present.get(dep.shot);
        if (!tgt) return;
        out.push({ src: src.dataset.id, tgt: dep.shot, kind: dep.kind });
      });
    });
    return out;
  }

  function drawDepLayer(list) {
    depEdges(list).forEach(function (e) {
      var a = rects.get(e.src);
      var b = rects.get(e.tgt);
      if (!a || !b) return;
      var bow = Math.max(70, Math.abs(b.cx - a.cx) * 0.34);
      var d =
        "M" + a.cx + " " + (a.bottom - 3) +
        " C" + a.cx + " " + (a.bottom + bow) + " " + b.cx + " " + (b.top - bow) + " " + b.cx + " " + (b.top + 3);
      svgDep.appendChild(el("path", { d: d, class: "dep", "marker-end": "url(#arrow-dep)" }));
    });
  }

  function drawFocused(list) {
    if (!view.focus) return;
    var list2 = list;
    depEdges(list2, view.focus).forEach(function (e) {
      var a = rects.get(e.src);
      var b = rects.get(e.tgt);
      if (!a || !b) return;
      var bow = Math.max(70, Math.abs(b.cx - a.cx) * 0.34);
      var d =
        "M" + a.cx + " " + (a.bottom - 3) +
        " C" + a.cx + " " + (a.bottom + bow) + " " + b.cx + " " + (b.top - bow) + " " + b.cx + " " + (b.top + 3);
      svgSeq.appendChild(el("path", { d: d, class: "dep-focus", "marker-end": "url(#arrow-dep-focus)" }));
    });
    // 被依赖的镜头（入边）同样描出来
    depEdges(list2).filter(function (e) { return e.tgt === view.focus; }).forEach(function (e) {
      var a = rects.get(e.src);
      var b = rects.get(e.tgt);
      if (!a || !b) return;
      var bow = Math.max(70, Math.abs(b.cx - a.cx) * 0.34);
      var d =
        "M" + a.cx + " " + (a.bottom - 3) +
        " C" + a.cx + " " + (a.bottom + bow) + " " + b.cx + " " + (b.top - bow) + " " + b.cx + " " + (b.top + 3);
      svgSeq.appendChild(el("path", { d: d, class: "dep-focus", "marker-end": "url(#arrow-dep-focus)" }));
    });
  }

  function applyDim(list) {
    var involved = new Set();
    if (view.focus) {
      involved.add(view.focus);
      depEdges(list).forEach(function (e) {
        if (e.src === view.focus || e.tgt === view.focus) { involved.add(e.src); involved.add(e.tgt); }
      });
    }
    board.classList.toggle("focus-mode", !!view.focus);
    cards.forEach(function (c) {
      c.classList.toggle("involved", involved.has(c.dataset.id));
    });
  }

  function draw() {
    var list = visible();
    measure();
    applyDim(list);

    reset(svgSeq, [marker("arrow-seq", "#191610"), marker("arrow-dep-focus", "#ad3a20")]);
    if (view.seq) drawSeq(list);
    if (view.dep) drawFocused(list);

    reset(svgDep, [marker("arrow-dep", "#ad3a20")]);
    if (view.dep) drawDepLayer(list);
  }

  function scheduleDraw() {
    window.requestAnimationFrame(draw);
  }

  /* ——— 交互 ——— */
  function setFilter(next) {
    view.filter = next;
    cards.forEach(function (c) {
      var hide =
        next === "missing" ? c.dataset.flagMissing !== "1" :
        next === "stale" ? c.dataset.flagStale !== "1" :
        next === "blocked" ? c.dataset.flagBlocked !== "1" :
        next === "all" ? false : c.dataset.state !== next;
      if (hide) c.setAttribute("hidden-f", "");
      else c.removeAttribute("hidden-f");
    });
    document.querySelectorAll(".chip[data-filter]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.filter === next));
    });
    scheduleDraw();
  }

  document.querySelectorAll(".chip[data-filter]").forEach(function (b) {
    b.addEventListener("click", function () { setFilter(b.dataset.filter); });
  });

  document.querySelectorAll(".chip[data-thread]").forEach(function (b) {
    b.addEventListener("click", function () {
      var key = b.dataset.thread;
      view[key] = !view[key];
      b.setAttribute("aria-pressed", String(view[key]));
      scheduleDraw();
    });
  });

  document.querySelectorAll(".chip[data-density]").forEach(function (b) {
    b.addEventListener("click", function () {
      board.classList.toggle("dense", b.dataset.density === "dense");
      document.querySelectorAll(".chip[data-density]").forEach(function (x) {
        x.setAttribute("aria-pressed", String(x === b));
      });
      scheduleDraw();
    });
  });

  function jump(id) {
    var card = byId.get(id);
    if (!card) return;
    if (card.hasAttribute("hidden-f")) setFilter("all");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth;
    card.classList.add("flash");
  }

  document.querySelectorAll(".strip-cell").forEach(function (c) {
    c.addEventListener("click", function () { jump(c.dataset.target); });
  });
  document.querySelectorAll("[data-jump]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      jump(a.dataset.jump);
    });
  });

  cards.forEach(function (c) {
    c.addEventListener("click", function (e) {
      if (e.target.closest("a")) return;
      c.classList.toggle("expanded");
    });
    c.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        c.classList.toggle("expanded");
      }
    });
    c.addEventListener("mouseenter", function () {
      view.focus = c.dataset.id;
      scheduleDraw();
    });
    c.addEventListener("mouseleave", function () {
      if (view.focus === c.dataset.id) { view.focus = null; scheduleDraw(); }
    });
    c.addEventListener("focus", function () { view.focus = c.dataset.id; scheduleDraw(); });
    c.addEventListener("blur", function () { if (view.focus === c.dataset.id) { view.focus = null; scheduleDraw(); } });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setFilter("all");
  });

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(scheduleDraw).observe(grid);
  window.addEventListener("resize", scheduleDraw);
  window.addEventListener("scroll", function () { /* 依赖层贴在 board 内，无需重算 */ }, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleDraw);
  scheduleDraw();
})();
